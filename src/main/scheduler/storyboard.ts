import { AppError } from '../../shared/domain/app-error'
import { parseCharacterCard } from '../../shared/schema/plan'
import { StoryboardDraftSchema, type DraftScene, type StoryboardConflict } from '../../shared/schema/storyboard'
import { validateStoryboard } from '../../shared/dsl/storyboard'
import type { ExitRegistry } from '../../shared/dsl/exit'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { newId } from '../db/repos/common'
import type { BeatRecord } from '../db/repos/beat'
import type { SceneInChapter } from '../db/repos/scene'
import { hashManifestRows, hashText } from '../db/hash'
import type { ManifestBeatRow } from '../db/revision'
import { withTransaction } from '../db/tx'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../doc/mirror'

/**
 * 分镜：草案 → 校验 → G2 物化（PHASE-07 F1 / DEV-PLAN §8.1）。
 *
 * 开演前唯一真相是 `storyboard_draft.scenes_json`；G2 通过才写 scene / beat。
 * 这样「改分镜」不会制造 revision，也不会出现「分镜里删一拍、正文里留孤儿」。
 */

export interface ChapterStoryboardScene {
  scene: SceneInChapter['scene']
  chapterOrd: number
  beats: BeatRecord[]
}

export interface StoryboardDraftView {
  chapterId: string
  rev: number
  updatedBy: 'author' | 'orchestrator'
  updatedAt: string
  scenes: DraftScene[]
}

function parseScenes(json: string, chapterId: string): DraftScene[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new AppError('internal_error', `分镜草案 ${chapterId} 不是合法 JSON`)
  }
  const parsed = StoryboardDraftSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('schema_invalid', `分镜草案 ${chapterId} 不符合契约`, {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    })
  }
  return parsed.data.scenes
}

export function readStoryboardDraft(repos: Repos, chapterId: string): StoryboardDraftView | null {
  const row = repos.storyboard.get(chapterId)
  if (!row) return null
  return {
    chapterId: row.chapterId,
    rev: row.rev,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    scenes: parseScenes(row.scenesJson, chapterId)
  }
}

/** 保存草案：schema 先过，再交给 G2 校验；硬冲突允许保存（作者可以分步改）。 */
export function saveStoryboardDraft(
  repos: Repos,
  input: { chapterId: string; scenes: unknown; updatedBy: 'author' | 'orchestrator' }
): StoryboardDraftView {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
  if (chapter.finalRevisionId !== null) {
    throw new AppError('invalid_args', '已定稿章节不能修改分镜', { chapterId: chapter.id })
  }
  const parsed = StoryboardDraftSchema.safeParse({ chapter_id: chapter.id, scenes: input.scenes })
  if (!parsed.success) {
    throw new AppError('schema_invalid', '分镜草案不符合契约', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    })
  }
  repos.storyboard.save({
    chapterId: chapter.id,
    projectId: chapter.projectId,
    scenesJson: JSON.stringify(parsed.data),
    updatedBy: input.updatedBy
  })
  return readStoryboardDraft(repos, chapter.id)!
}

/** 实体/谓词登记表（DEV-PLAN §8.4 D3/D4）：角色、地点、世界事实的 subject/predicate。 */
export function buildExitRegistry(repos: Repos, projectId: string, participants?: Iterable<string>): ExitRegistry {
  const entities = new Set<string>()
  const predicates = new Set<string>()
  for (const character of repos.character.list(projectId)) {
    entities.add(character.id)
    entities.add(character.name)
  }
  for (const scene of repos.scene.listByProject(projectId)) {
    entities.add(scene.location)
  }
  for (const fact of repos.world.listByProject(projectId)) {
    entities.add(fact.subject)
    predicates.add(fact.predicate)
  }
  return {
    entities,
    predicates,
    ...(participants === undefined ? {} : { participants: new Set(participants) })
  }
}

export function characterCardViews(
  repos: Repos,
  projectId: string
): Map<string, { taboo?: string; bannedWords?: string }> {
  const map = new Map<string, { taboo?: string; bannedWords?: string }>()
  for (const character of repos.character.list(projectId)) {
    const card = parseCharacterCard(character.cardJson)
    map.set(character.id, {
      ...(card.taboo.trim().length > 0 ? { taboo: card.taboo } : {}),
      ...(card.voice.banned_words.trim().length > 0 ? { bannedWords: card.voice.banned_words } : {})
    })
  }
  return map
}

/** 全量校验：分镜编辑器、G2 预览、T34 提案共用。 */
export function validateScenes(
  repos: Repos,
  projectId: string,
  scenes: readonly DraftScene[],
  chapterId?: string
): StoryboardConflict[] {
  const ownership: StoryboardConflict[] = []
  if (chapterId !== undefined) {
    scenes.forEach((scene, index) => {
      if (!scene.scene_id) return
      // 引用章只读：别的章演出过的场景不能直接进本章分镜，必须先 fork（PHASE-12 §5.1）。
      const owner = repos.scene.ownerChapter(scene.scene_id)
      if (owner !== null && owner.chapterId !== chapterId) {
        ownership.push({
          code: 'scene_performed_elsewhere',
          severity: 'hard',
          message: `场景「${scene.location}」已在第 ${owner.chapterOrd} 章演出；先 fork 到本章`,
          scene_ord: index + 1
        })
      }
    })
  }
  return [
    ...ownership,
    ...validateStoryboard(
      { scenes: [...scenes] },
      {
        registry: buildExitRegistry(repos, projectId),
        characters: characterCardViews(repos, projectId)
      }
    )
  ]
}

export function validateChapterStoryboard(repos: Repos, chapterId: string): StoryboardConflict[] {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  const draft = readStoryboardDraft(repos, chapterId)
  if (!draft) {
    return [{ code: 'no_storyboard', severity: 'hard', message: '本章还没有分镜草案', scene_ord: 0 }]
  }
  return validateScenes(repos, chapter.projectId, draft.scenes, chapterId)
}

/** 章内现行分镜（G2 之后才有行）；引用场不返回别的章的拍。 */
export function readChapterStoryboard(repos: Repos, chapterId: string): ChapterStoryboardScene[] {
  const beats = repos.beat.listLiveByChapter(chapterId)
  return repos.scene.listByChapter(chapterId).map((entry) => ({
    scene: entry.scene,
    chapterOrd: entry.chapterOrd,
    beats: beats.filter((beat) => beat.sceneId === entry.scene.id)
  }))
}

export interface MaterializeResult {
  sceneCount: number
  beatCount: number
  revisionId: string
  contentHash: string
  beatIds: string[]
}

interface PlannedRow {
  sceneId: string
  sceneOrd: number
  ord: number
  speakerType: 'character' | 'narrator'
  speakerId: string
  intent: string
  maxWords: number | null
  /** 已有正文的拍：保留正文，不新建版本。 */
  keep: BeatRecord | null
  beatId: string
  body: string
}

/**
 * G2 物化：草案 → scene / chapter_scene / beat（proposed，body 为空）。
 *
 * - 已有正文的槽位保留正文；改发言人直接拒绝（避免把已写内容挪到别人名下）。
 * - 草案里删掉的拍只有空正文才 supersede，否则报错让作者先处理正文。
 * - 每次物化写一个新 revision（清单 = 现行拍），保证 `db.verify` 的清单/hash 一致。
 */
export function materializeStoryboard(
  db: Db,
  repos: Repos,
  input: { chapterId: string; scenes: readonly DraftScene[]; actor: string }
): MaterializeResult {
  return withTransaction(db, () => {
    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
    const project = repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')

    const existing = repos.scene.listByChapter(chapter.id)
    const existingBySceneId = new Map(existing.map((entry) => [entry.scene.id, entry]))
    const sceneOrdBase = repos.scene.listByProject(project.id).reduce((max, scene) => Math.max(max, scene.ord), 0)

    const planned: Array<{ sceneId: string; chapterOrd: number; beats: DraftScene['beats'] }> = []

    input.scenes.forEach((draft, index) => {
      const chapterOrd = index + 1
      if (draft.scene_id) {
        // 别的章演出过的场景不能在本章物化：引用章只读，演出前必须 fork（PHASE-12 §5.1）。
        const owner = repos.scene.ownerChapter(draft.scene_id)
        const owned = repos.scene.get(draft.scene_id)
        if (owned !== null && owned.projectId !== chapter.projectId) {
          throw new AppError('invalid_args', '分镜引用了其他项目的场景', { sceneId: draft.scene_id })
        }
        if (owner !== null && owner.chapterId !== chapter.id) {
          throw new AppError('invalid_args', `场景已在第 ${owner.chapterOrd} 章演出；先 fork 到本章`, {
            sceneId: draft.scene_id,
            needsFork: true,
            ownerChapterOrd: owner.chapterOrd
          })
        }
      }
      const match = draft.scene_id ? existingBySceneId.get(draft.scene_id) : existing[index]
      const sceneId = match?.scene.id ?? draft.scene_id ?? newId('scn')
      if (match) {
        repos.scene.update(match.scene.id, {
          location: draft.location,
          participantsJson: JSON.stringify(draft.participants),
          goal: draft.goal,
          entry: draft.entry ?? '',
          exitJson: JSON.stringify({ dsl: draft.exit ?? null }),
          maxBeats: draft.max_beats ?? match.scene.maxBeats,
          status: match.scene.status === 'closed' ? 'closed' : 'planned'
        })
      } else {
        repos.scene.insert({
          id: sceneId,
          projectId: project.id,
          ord: sceneOrdBase + index + 1,
          location: draft.location,
          participantsJson: JSON.stringify(draft.participants),
          goal: draft.goal,
          entry: draft.entry ?? '',
          exitJson: JSON.stringify({ dsl: draft.exit ?? null }),
          maxBeats: draft.max_beats ?? 40,
          status: 'planned'
        })
      }
      planned.push({ sceneId, chapterOrd, beats: draft.beats })
    })

    const plannedIds = new Set(planned.map((entry) => entry.sceneId))
    // 引用场：本章链接、但拍属于别的章；草案里没有它们也算数，物化时保留链接。
    const references = existing.filter((entry) => !plannedIds.has(entry.scene.id)).filter((entry) => {
      const owner = repos.scene.ownerChapter(entry.scene.id)
      return owner !== null && owner.chapterId !== chapter.id
    })

    // 重置章内场景顺序：先清空再按草案顺序插入；引用场排在后面（只读，不参与演出）。
    for (const entry of existing) repos.scene.unlinkFromChapter(chapter.id, entry.scene.id)
    for (const entry of planned) repos.scene.linkToChapter(chapter.id, entry.sceneId, entry.chapterOrd)
    references.forEach((entry, index) => {
      repos.scene.linkToChapter(chapter.id, entry.scene.id, planned.length + index + 1)
    })

    const liveBefore = repos.beat.listLiveByChapter(chapter.id)
    const slotOf = (sceneId: string, ord: number): BeatRecord | undefined =>
      liveBefore.find((beat) => beat.sceneId === sceneId && beat.ord === ord)

    const rows: PlannedRow[] = []
    for (const entry of planned) {
      entry.beats.forEach((draft, index) => {
        const ord = draft.ord ?? index + 1
        const current = slotOf(entry.sceneId, ord)
        const hasBody = current !== undefined && current.body.trim().length > 0
        if (hasBody && (current.speakerType !== draft.speaker_type || current.speakerId !== draft.speaker_id)) {
          throw new AppError('invalid_args', '已有正文的拍不能改发言人；先编辑或重生成这一拍', {
            beatId: current.id,
            sceneId: entry.sceneId,
            ord
          })
        }
        rows.push({
          sceneId: entry.sceneId,
          sceneOrd: entry.chapterOrd,
          ord,
          speakerType: draft.speaker_type,
          speakerId: draft.speaker_id,
          intent: draft.intent,
          maxWords: draft.max_words ?? null,
          keep: hasBody ? current! : null,
          beatId: hasBody ? current!.id : newId('bt'),
          body: hasBody ? current!.body : ''
        })
      })
    }

    // 被草案移除的槽位：只有空正文才能 supersede。
    const keptSlots = new Set(rows.map((row) => `${row.sceneId}:${row.ord}`))
    for (const beat of liveBefore) {
      if (keptSlots.has(`${beat.sceneId}:${beat.ord}`)) continue
      if (beat.body.trim().length > 0) {
        throw new AppError('invalid_args', '要删除的拍已有正文；先撤回该拍再改分镜', { beatId: beat.id })
      }
      repos.beat.markSuperseded(beat.id)
    }

    const manifest: ManifestBeatRow[] = rows
      .map((row) => ({
        beatId: row.beatId,
        sceneId: row.sceneId,
        sceneOrd: row.sceneOrd,
        beatOrd: row.ord,
        speakerType: row.speakerType,
        speakerId: row.speakerId,
        body: row.body
      }))
      .sort((left, right) => left.sceneOrd - right.sceneOrd || left.beatOrd - right.beatOrd)
    const contentHash = hashManifestRows(manifest)

    // revision 先建（beat.created_revision_id 非空），hash 在插入前算好。
    const revisionId = newId('rev')
    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: chapter.currentRevisionId,
      kind: 'draft',
      contentHash,
      createdBy: input.actor === 'author' ? 'author' : 'doc_controller',
      note: 'storyboard materialized (G2)'
    })

    for (const row of rows) {
      if (row.keep) continue
      const current = slotOf(row.sceneId, row.ord)
      if (current) repos.beat.markSuperseded(current.id)
      repos.beat.insert({
        id: row.beatId,
        chapterId: chapter.id,
        sceneId: row.sceneId,
        ord: row.ord,
        seq: null,
        speakerType: row.speakerType,
        speakerId: row.speakerId,
        intent: row.intent,
        body: '',
        status: 'proposed',
        createdRevisionId: revisionId,
        maxWords: row.maxWords
      })
    }

    repos.revision.insertMembers(
      revisionId,
      manifest.map((member) => ({
        revisionId,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )
    repos.chapter.setCurrentRevision(chapter.id, revisionId)

    // 物化后把 scene_id 写回草案（PHASE-12 M1-1/M1-2）：编辑器据此显示三轴、
    // 场景库据此判断「这一场已经在本章演出」，下次保存也不会重复建场景。
    repos.storyboard.save({
      chapterId: chapter.id,
      projectId: chapter.projectId,
      scenesJson: JSON.stringify({
        chapter_id: chapter.id,
        scenes: input.scenes.map((scene, index) => ({ ...scene, scene_id: planned[index]!.sceneId }))
      }),
      updatedBy: 'author'
    })

    const mirrorHash = hashText(renderChapterMarkdown(db, { chapterId: chapter.id, revisionId }))
    repos.outbox.enqueue({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      revisionId,
      path: chapterMirrorRelPath(chapter.ord),
      expectedHash: mirrorHash
    })

    return {
      sceneCount: planned.length,
      beatCount: manifest.length,
      revisionId,
      contentHash,
      beatIds: manifest.map((member) => member.beatId)
    }
  })
}
