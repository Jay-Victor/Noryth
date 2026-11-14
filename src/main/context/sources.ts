import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'
import type { CharacterRecord } from '../db/repos/character'
import type { WorldFactRecord } from '../db/repos/world'
import type { AgentInstanceKey } from '../tools/types'
import { baseAgentOf } from '../tools/registry'
import { scoreText } from '../tools/support/text'
import type {
  AssembleInput,
  CharacterSpec,
  ChapterSpec,
  RecentBeatSpec,
  RetrievedItem,
  SceneSpec,
  SpectatorSpec
} from './assemble'

/**
 * 上下文取材（DEV-PLAN §8.3 的 M0 基线）：先做可见性过滤，再召回、排序。
 *
 * 这里的排序是确定性的（score desc, id asc），不依赖数据库返回顺序。
 * 阶段 09 换成 sqlite-vec 时只替换 `retrieveMemories`，装配器不变。
 */

export interface CollectContextInput {
  projectId: string
  chapterId: string
  beatId: string
  agent: AgentInstanceKey
  contextWindow?: number
  topK?: number
  recentLimit?: number
}

export interface CollectedContext {
  input: AssembleInput
  asOf: number
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseCard(character: CharacterRecord): Record<string, unknown> {
  const parsed = parseJson<unknown>(character.cardJson, {})
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function asCharacter(character: CharacterRecord): CharacterSpec {
  return { id: character.id, name: character.name, card: parseCard(character) }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function factValidAt(fact: WorldFactRecord, asOf: number): boolean {
  return fact.validFromSeq <= asOf && (fact.validToSeq === null || fact.validToSeq > asOf)
}

function factKnownBy(fact: WorldFactRecord, characterId: string): boolean {
  return parseJson<string[]>(fact.knownByJson, []).includes(characterId)
}

function memoryValid(entry: { learnedSeq: number; validToSeq: number | null }, asOf: number): boolean {
  return entry.learnedSeq <= asOf && (entry.validToSeq === null || entry.validToSeq > asOf)
}

function rank(items: RetrievedItem[]): RetrievedItem[] {
  return [...items].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

export function collectContext(repos: Repos, input: CollectContextInput): CollectedContext {
  const project = repos.project.getById(input.projectId)
  if (!project) throw new AppError('project_not_found', 'project missing', { projectId: input.projectId })

  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', 'chapter missing', { chapterId: input.chapterId })

  const beat = repos.beat.get(input.beatId)
  if (!beat) throw new AppError('project_not_found', 'beat missing', { beatId: input.beatId })

  const scene = repos.scene.get(beat.sceneId)
  if (!scene) throw new AppError('project_not_found', 'scene missing', { sceneId: beat.sceneId })

  const outline = repos.outline.get(chapter.outlineNodeId)
  const chapterScenes = repos.scene.listByChapter(input.chapterId)
  const sceneSequence = chapterScenes.map(
    (entry) => `${entry.scene.ord}. ${entry.scene.location}（${entry.scene.goal}）`
  )

  const chapterSpec: ChapterSpec = {
    id: chapter.id,
    ord: chapter.ord,
    title: outline?.title ?? `第 ${chapter.ord} 章`,
    goal: outline?.content?.trim() || scene.goal,
    coreEvent: outline?.content?.trim() || scene.goal,
    sceneSequence,
    forbiddenReveals: []
  }

  const previous =
    chapterScenes.length > 0
      ? chapterScenes.filter((entry) => entry.scene.ord < scene.ord).at(-1)?.scene ?? null
      : null
  const sceneSpec: SceneSpec = {
    id: scene.id,
    ord: scene.ord,
    location: scene.location,
    participants: parseJson<string[]>(scene.participantsJson, []),
    goal: scene.goal,
    entry: scene.entry,
    exit: scene.exitJson,
    previousResult: previous ? `${previous.location}：${previous.exitJson}` : null
  }

  const asOf = chapter.coveredUntilSeq > 0 ? chapter.coveredUntilSeq : project.seqHead

  const actorCharacterId = input.agent.startsWith('character:')
    ? input.agent.slice('character:'.length)
    : null
  if (actorCharacterId !== null && actorCharacterId !== beat.speakerId) {
    throw new AppError('invalid_args', 'agent 与分拍发言者不一致', {
      agent: input.agent,
      speakerId: beat.speakerId
    })
  }
  if (actorCharacterId === null && input.agent === 'narrator' && beat.speakerType !== 'narrator') {
    throw new AppError('invalid_args', '旁白 Agent 不能装配角色拍', { beatId: beat.id })
  }

  const characters = new Map<string, CharacterRecord>()
  for (const participantId of sceneSpec.participants) {
    const character = repos.character.get(participantId)
    if (character) characters.set(character.id, character)
  }

  const speakerRecord =
    beat.speakerType === 'character' ? (characters.get(beat.speakerId) ?? repos.character.get(beat.speakerId)) : null
  if (beat.speakerType === 'character' && !speakerRecord) {
    throw new AppError('setup_incomplete', 'speaker character missing', { beatId: beat.id })
  }
  const speaker = speakerRecord ? asCharacter(speakerRecord) : null

  const agentBase = baseAgentOf(input.agent)
  const tensionByTarget = new Map<string, number>()
  if (speakerRecord) {
    for (const edge of repos.relationship.listActiveFrom(speakerRecord.id)) {
      if (edge.axis !== 'tension' || edge.sinceSeq > asOf) continue
      if (edge.validToSeq !== null && edge.validToSeq <= asOf) continue
      tensionByTarget.set(edge.toId, edge.value)
    }
  }

  const spectators: SpectatorSpec[] = []
  for (const participantId of sceneSpec.participants) {
    if (participantId === beat.speakerId) continue
    const character = characters.get(participantId)
    if (!character) continue
    const card = parseCard(character)
    spectators.push({
      ...asCharacter(character),
      location: stringValue(card.location, scene.location),
      emotion: stringValue(card.emotion, ''),
      known: stringArray(card.known),
      unknown: stringArray(card.unknown),
      tension: tensionByTarget.get(character.id) ?? 0.5
    })
  }

  const recentBeats: RecentBeatSpec[] = []
  const pushBeats = (chapterId: string): void => {
    const rows = repos.beat
      .listLiveByChapter(chapterId)
      .filter((row) => row.id !== beat.id)
      .filter((row) => row.seq !== null && row.seq <= asOf)
      .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0) || left.id.localeCompare(right.id))
    for (const row of rows) {
      if (recentBeats.length >= (input.recentLimit ?? 6)) break
      recentBeats.push({
        id: row.id,
        seq: row.seq,
        ord: row.ord,
        speakerType: row.speakerType,
        speakerId: row.speakerId,
        body: row.body,
        status: row.status
      })
    }
  }
  pushBeats(input.chapterId)
  if (recentBeats.length < 2) {
    const previousChapter = repos.chapter
      .listByProject(input.projectId)
      .filter((item) => item.ord < chapter.ord)
      .sort((left, right) => right.ord - left.ord)[0]
    if (previousChapter) pushBeats(previousChapter.id)
  }

  const query = `${beat.intent} ${scene.goal}`.trim()
  const pinned: RetrievedItem[] = []
  const retrieved: RetrievedItem[] = []

  if (beat.speakerType === 'character' && speaker) {
    for (const entry of repos.memory.listByCharacter(speaker.id, { status: 'active' })) {
      if (!memoryValid(entry, asOf)) continue
      const item: RetrievedItem = {
        refType: 'memory',
        id: entry.id,
        text: entry.text,
        score: scoreText(entry.text, query).score,
        importance: entry.importance,
        pinned: entry.pinned === 1
      }
      if (item.pinned) pinned.push(item)
      else retrieved.push(item)
    }
    for (const belief of repos.belief.listByCharacter(speaker.id)) {
      if (belief.status !== 'active' || belief.learnedSeq > asOf) continue
      const scored = scoreText(belief.beliefText, query)
      if (scored.score <= 0) continue
      retrieved.push({
        refType: 'belief',
        id: belief.id,
        text: belief.beliefText,
        score: scored.score,
        importance: belief.confidence,
        pinned: false
      })
    }
    for (const fact of repos.world.listByProject(input.projectId)) {
      if (!factValidAt(fact, asOf)) continue
      const visible = factKnownBy(fact, speaker.id) || (fact.visibility === 'public' && fact.revealSeq !== null && fact.revealSeq <= asOf)
      if (!visible) continue
      const text = `${fact.subject} ${fact.predicate} ${fact.object}`
      const scored = scoreText(text, query)
      if (scored.score <= 0) continue
      retrieved.push({
        refType: 'fact',
        id: fact.id,
        text,
        score: scored.score,
        importance: 0.8,
        pinned: false
      })
    }
  } else if (agentBase === 'narrator') {
    for (const fact of repos.world.listByProject(input.projectId)) {
      if (!factValidAt(fact, asOf)) continue
      if (fact.visibility !== 'public' || fact.revealSeq === null || fact.revealSeq > asOf) continue
      const text = `${fact.subject} ${fact.predicate} ${fact.object}`
      const scored = scoreText(text, query)
      if (scored.score <= 0) continue
      retrieved.push({
        refType: 'fact',
        id: fact.id,
        text,
        score: scored.score,
        importance: 0.8,
        pinned: false
      })
    }
  } else {
    for (const fact of repos.world.listByProject(input.projectId)) {
      if (!factValidAt(fact, asOf)) continue
      const text = `${fact.subject} ${fact.predicate} ${fact.object}`
      const scored = scoreText(text, query)
      retrieved.push({
        refType: 'fact',
        id: fact.id,
        text,
        score: scored.score,
        importance: 0.8,
        pinned: false
      })
    }
  }

  const assembleInput: AssembleInput = {
    agent: input.agent,
    beat: {
      id: beat.id,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      intent: beat.intent || scene.goal,
      maxWords: beat.maxWords
    },
    chapter: chapterSpec,
    scene: sceneSpec,
    speaker,
    spectators,
    pinned: [...pinned].sort(
      (left, right) => right.importance - left.importance || left.id.localeCompare(right.id)
    ),
    retrieved: rank(retrieved),
    recentBeats,
    ...(beat.maxWords === null ? {} : { maxWords: beat.maxWords }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    ...(input.recentLimit === undefined ? {} : { recentLimit: input.recentLimit })
  }

  return { input: assembleInput, asOf }
}
