import { z } from 'zod'
import { AppError } from '../../../shared/domain/app-error'
import type { Repos } from '../../db/repos'
import type { ChapterRecord } from '../../db/repos/chapter'
import type { OutlineNodeRecord } from '../../db/repos/outline'
import { defineTool } from '../define'
import { firstLine } from '../support/text'
import { parseCard, publicProfile } from '../support/cards'
import { AUDIT, Id, degradeFor, limitsFor, parseJson, participantIds } from './shared'

/** T01–T09：结构读取（PRD §4.10.1）。 */

function chapterOf(repos: Repos, projectId: string, chapterId: string): ChapterRecord {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter || chapter.projectId !== projectId) {
    throw new AppError('invalid_args', `chapter ${chapterId} not in project`)
  }
  return chapter
}

function requireChapterId(chapterId: string | null): string {
  if (!chapterId) throw new AppError('invalid_args', 'chapter context missing')
  return chapterId
}

const ChapterStatus = z.strictObject({
  id: Id,
  ord: z.number().int(),
  status: z.string(),
  covered_until_seq: z.number().int(),
  has_final: z.boolean()
})

const projectGetMeta = defineTool({
  toolId: 'T01',
  name: 'project.get_meta',
  version: '1.0.0',
  family: 'structure',
  summary: '读取项目题材、视角、目标篇幅、章状态与已通过闸门，不含 Key 与费用明细',
  actors: ['planner', 'orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({}),
  output: z.strictObject({
    project: z.strictObject({
      id: Id,
      title: z.string(),
      genre: z.string(),
      pov: z.string(),
      target_words: z.number().int().nullable(),
      status: z.string(),
      setup_state: z.string(),
      chapter_count: z.number().int(),
      finalized_count: z.number().int(),
      word_count: z.number().int()
    }),
    chapters: z.array(ChapterStatus),
    gates: z.array(z.strictObject({ gate_id: z.string(), decision: z.string(), created_at: z.string() }))
  }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')
    const chapters = services.repos.chapter.listByProject(project.id)
    const gates = services.repos.gate.listByEntity('project', project.id)
    return {
      data: {
        project: {
          id: project.id,
          title: project.title,
          genre: project.genre,
          pov: project.pov,
          target_words: project.targetWords,
          status: project.status,
          setup_state: project.setupState,
          chapter_count: chapters.length,
          finalized_count: services.repos.project.finalizedChapterCount(),
          word_count: services.repos.project.finalizedWordCount()
        },
        chapters: chapters.map((chapter) => ({
          id: chapter.id,
          ord: chapter.ord,
          status: chapter.status,
          covered_until_seq: chapter.coveredUntilSeq,
          has_final: chapter.finalRevisionId !== null
        })),
        gates: gates.map((gate) => ({ gate_id: gate.gateId, decision: gate.decision, created_at: gate.createdAt }))
      }
    }
  }
})

const OutlineNodeOutput = z.strictObject({
  id: Id,
  parent_id: Id.nullable(),
  kind: z.string(),
  ord: z.number().int(),
  title: z.string(),
  content: z.string(),
  status: z.string(),
  version: z.number().int()
})

const outlineGetSubtree = defineTool({
  toolId: 'T02',
  name: 'outline.get_subtree',
  version: '1.0.0',
  family: 'structure',
  summary: '按节点读取大纲子树（主线、卷、章），只返回当前草案与已批准版本',
  actors: ['planner', 'orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({
    node_id: Id.optional(),
    kinds: z.array(z.enum(['main', 'volume', 'chapter'])).min(1).max(3).optional(),
    depth: z.number().int().min(0).max(6).default(2)
  }),
  output: z.strictObject({ nodes: z.array(OutlineNodeOutput) }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const all = services.repos.outline
      .listByProject(ctx.runtime.project_id)
      .filter((node) => node.status !== 'locked')
    const kinds = args.kinds ? new Set(args.kinds) : null
    const childrenOf = (parentId: string | null): OutlineNodeRecord[] =>
      all.filter((node) => node.parentId === parentId).sort((left, right) => left.ord - right.ord)

    let roots: OutlineNodeRecord[]
    if (args.node_id) {
      const root = all.find((node) => node.id === args.node_id)
      if (!root) return { data: { nodes: [] }, degraded: 'empty' as const }
      roots = [root]
    } else {
      roots = childrenOf(null)
    }

    const nodes: OutlineNodeRecord[] = []
    const walk = (node: OutlineNodeRecord, level: number): void => {
      if (!kinds || kinds.has(node.kind)) nodes.push(node)
      if (level >= args.depth) return
      for (const child of childrenOf(node.id)) walk(child, level + 1)
    }
    for (const root of roots) walk(root, 0)

    return {
      data: {
        nodes: nodes.map((node) => ({
          id: node.id,
          parent_id: node.parentId,
          kind: node.kind,
          ord: node.ord,
          title: node.title,
          content: node.content,
          status: node.status,
          version: node.version
        }))
      },
      degraded: nodes.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const outlineGetChapterBrief = defineTool({
  toolId: 'T03',
  name: 'outline.get_chapter_brief',
  version: '1.0.0',
  family: 'structure',
  summary: '返回本章一句话目标（脱敏），不含章纲全文、卷纲与禁揭清单',
  actors: ['character', 'narrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['chapter_id'],
  input: z.strictObject({}),
  output: z.strictObject({ chapter_id: Id, one_line_goal: z.string() }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const chapterId = requireChapterId(ctx.chapterId)
    const chapter = chapterOf(services.repos, ctx.runtime.project_id, chapterId)
    const node = services.repos.outline.get(chapter.outlineNodeId)
    const goal = firstLine(node?.content || node?.title || '')
    return { data: { chapter_id: chapter.id, one_line_goal: goal } }
  }
})

const CharacterCardOutput = z.strictObject({
  character_id: Id,
  name: z.string(),
  card_version: z.number().int(),
  card: z.record(z.string(), z.unknown())
})

const characterGetOwnCard = defineTool({
  toolId: 'T04',
  name: 'character.get_own_card',
  version: '1.0.0',
  family: 'structure',
  summary: '返回本人完整角色卡与卡版本；角色身份由运行时注入，无可传参数',
  actors: ['character'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['character_id'],
  input: z.strictObject({}),
  output: CharacterCardOutput.extend({}),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const characterId = ctx.runtime.character_id
    if (!characterId) throw new AppError('invalid_args', 'character identity missing')
    const character = services.repos.character.get(characterId)
    if (!character || character.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'character not in project')
    }
    const card = parseCard(character.cardJson)
    return {
      data: {
        character_id: character.id,
        name: character.name,
        card_version: character.cardVersion,
        card
      },
      degraded: Object.keys(card).length === 0 ? ('summary' as const) : ('none' as const)
    }
  }
})

const PublicProfileOutput = z.strictObject({
  id: Id,
  name: z.string(),
  role: z.string().nullable(),
  age: z.number().nullable(),
  appearance: z.string().nullable(),
  public_identity: z.string().nullable(),
  public_voice: z.string().nullable()
})

const characterGetPublicProfile = defineTool({
  toolId: 'T05',
  name: 'character.get_public_profile',
  version: '1.0.0',
  family: 'structure',
  summary: '返回角色公开身份、外貌与公开语气，剔除欲望、恐惧、禁忌与私有记忆',
  actors: ['narrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ character_ids: z.array(Id).min(1).max(12) }),
  output: z.strictObject({ profiles: z.array(PublicProfileOutput), missing_count: z.number().int() }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const profiles = []
    let missing = 0
    for (const id of args.character_ids) {
      const character = services.repos.character.get(id)
      if (!character || character.projectId !== ctx.runtime.project_id) {
        missing += 1
        continue
      }
      profiles.push(publicProfile(character.id, character.name, parseCard(character.cardJson)))
    }
    return {
      data: { profiles, missing_count: missing },
      degraded: profiles.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const characterGetCardFull = defineTool({
  toolId: 'T06',
  name: 'character.get_card_full',
  version: '1.0.0',
  family: 'structure',
  summary: '按角色 ID 读取完整角色卡，审批仅引最小必要证据',
  actors: ['planner', 'orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ character_id: Id }),
  output: z.strictObject({ found: z.boolean(), character: CharacterCardOutput.nullable() }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const character = services.repos.character.get(args.character_id)
    if (!character || character.projectId !== ctx.runtime.project_id) {
      return { data: { found: false, character: null }, degraded: 'empty' as const }
    }
    return {
      data: {
        found: true,
        character: {
          character_id: character.id,
          name: character.name,
          card_version: character.cardVersion,
          card: parseCard(character.cardJson)
        }
      }
    }
  }
})

const StoryboardBeatOutput = z.strictObject({
  beat_id: Id,
  ord: z.number().int(),
  speaker_type: z.string(),
  speaker_id: z.string(),
  intent: z.string(),
  status: z.string(),
  max_words: z.number().int().nullable()
})

const StoryboardSceneOutput = z.strictObject({
  scene_id: Id,
  ord: z.number().int(),
  location: z.string(),
  participants: z.array(z.string()),
  goal: z.string(),
  entry: z.string(),
  exit: z.unknown(),
  status: z.string(),
  beats: z.array(StoryboardBeatOutput)
})

const storyboardGetChapter = defineTool({
  toolId: 'T07',
  name: 'storyboard.get_chapter',
  version: '1.0.0',
  family: 'structure',
  summary: '读取本章当前分镜：场景、拍、出口条件与拍状态',
  actors: ['orchestrator', 'reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ chapter_id: Id }),
  output: z.strictObject({ chapter_id: Id, status: z.string(), scenes: z.array(StoryboardSceneOutput) }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const chapter = chapterOf(services.repos, ctx.runtime.project_id, args.chapter_id)
    const scenes = services.repos.scene.listByChapter(chapter.id)
    return {
      data: {
        chapter_id: chapter.id,
        status: chapter.status,
        scenes: scenes.map(({ scene, chapterOrd }) => ({
          scene_id: scene.id,
          ord: chapterOrd,
          location: scene.location,
          participants: participantIds(scene.participantsJson),
          goal: scene.goal,
          entry: scene.entry,
          exit: parseJson<unknown>(scene.exitJson, null),
          status: scene.status,
          beats: services.repos.beat.listLiveByScene(scene.id).map((beat) => ({
            beat_id: beat.id,
            ord: beat.ord,
            speaker_type: beat.speakerType,
            speaker_id: beat.speakerId,
            intent: beat.intent,
            status: beat.status,
            max_words: beat.maxWords
          }))
        }))
      },
      degraded: scenes.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const storyboardGetBeat = defineTool({
  toolId: 'T08',
  name: 'storyboard.get_beat',
  version: '1.0.0',
  family: 'structure',
  summary: '返回本拍意图、字数上限与场景元信息，不给后续拍',
  actors: ['character', 'narrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['beat_id'],
  input: z.strictObject({}),
  output: z.strictObject({
    beat_id: Id,
    ord: z.number().int(),
    intent: z.string(),
    max_words: z.number().int().nullable(),
    scene: z.strictObject({
      scene_id: Id,
      location: z.string(),
      goal: z.string(),
      participants: z.array(z.string())
    })
  }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    if (!ctx.beatId) throw new AppError('invalid_args', 'beat context missing')
    const beat = services.repos.beat.get(ctx.beatId)
    if (!beat) throw new AppError('invalid_args', 'beat not found')
    const scene = services.repos.scene.get(beat.sceneId)
    if (!scene) throw new AppError('internal_error', 'beat scene missing')
    return {
      data: {
        beat_id: beat.id,
        ord: beat.ord,
        intent: beat.intent,
        max_words: beat.maxWords,
        scene: {
          scene_id: scene.id,
          location: scene.location,
          goal: scene.goal,
          participants: participantIds(scene.participantsJson)
        }
      }
    }
  }
})

const sceneGet = defineTool({
  toolId: 'T09',
  name: 'scene.get',
  version: '1.0.0',
  family: 'structure',
  summary: '读取场景地点、在场者、目标、入口与上一场结果，在场者超阈值返回告警',
  actors: ['orchestrator', 'reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ scene_id: Id }),
  output: z.strictObject({
    scene_id: Id,
    location: z.string(),
    participants: z.array(z.string()),
    participant_count: z.number().int(),
    goal: z.string(),
    entry: z.string(),
    exit: z.unknown(),
    status: z.string(),
    previous_scene_result: z.string().nullable(),
    warning: z.string().nullable()
  }),
  limits: limitsFor('structure'),
  degrade: degradeFor('structure'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const scene = services.repos.scene.get(args.scene_id)
    if (!scene || scene.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'scene not in project')
    }
    const participants = participantIds(scene.participantsJson)
    const ordered = services.repos.scene.listByProject(ctx.runtime.project_id)
    const index = ordered.findIndex((item) => item.id === scene.id)
    const previous = index > 0 ? ordered[index - 1] : null
    const previousExit = previous ? parseJson<Record<string, unknown>>(previous.exitJson, {}) : {}
    const previousHook = typeof previousExit.hook === 'string' ? previousExit.hook : null
    return {
      data: {
        scene_id: scene.id,
        location: scene.location,
        participants,
        participant_count: participants.length,
        goal: scene.goal,
        entry: scene.entry,
        exit: parseJson<unknown>(scene.exitJson, null),
        status: scene.status,
        previous_scene_result: previousHook ?? (previous ? firstLine(previous.goal, 200) : null),
        warning: participants.length > 8 ? 'participants_over_threshold' : null
      }
    }
  }
})

export const STRUCTURE_TOOLS = [
  projectGetMeta,
  outlineGetSubtree,
  outlineGetChapterBrief,
  characterGetOwnCard,
  characterGetPublicProfile,
  characterGetCardFull,
  storyboardGetChapter,
  storyboardGetBeat,
  sceneGet
]
