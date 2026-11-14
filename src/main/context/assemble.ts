import { AppError } from '../../shared/domain/app-error'
import type { AgentInstanceKey, AgentKey, RefType, ToolRef } from '../tools/types'
import type { BeatStatus, SpeakerType } from '../db/repos/beat'
import { baseAgentOf } from '../tools/registry'
import type { ContextBundle, CtxBlock } from './budget'
import { fitToBudget, planBudget } from './budget'
import { estimateTokens, truncateToTokens } from './tokens'

/**
 * L0–L3 上下文装配（PRD §8.1 / DEV-PLAN §7.3）。
 *
 * 纯函数：不读时钟、不读数据库、不读环境；同一输入两次产出完全相同的 blocks
 * 与 totalTokens。排序键 `(layer, priority, id)`，检索按 `(score desc, id asc)`。
 *
 * 可见性在装配前就由调用方过滤（sources.ts）；本函数不再做权限判断，
 * 只负责「给什么、放哪层、超预算先裁谁」。
 */

export interface BeatSpec {
  id: string
  ord: number
  speakerType: SpeakerType
  speakerId: string
  intent: string
  maxWords: number | null
}

export interface ChapterSpec {
  id: string
  ord: number
  title: string
  goal: string
  coreEvent: string
  /** 旁白可见的场景序列（不含禁揭清单）。 */
  sceneSequence?: string[]
  forbiddenReveals: string[]
}

export interface SceneSpec {
  id: string
  ord: number
  location: string
  participants: string[]
  goal: string
  entry: string
  exit: string
  previousResult: string | null
}

export interface CharacterSpec {
  id: string
  name: string
  card: Record<string, unknown>
}

export interface SpectatorSpec extends CharacterSpec {
  location: string
  emotion: string
  known: string[]
  unknown: string[]
  tension: number
}

export interface RetrievedItem {
  refType: RefType
  id: string
  text: string
  score: number
  importance: number
  pinned: boolean
}

export interface RecentBeatSpec {
  id: string
  seq: number | null
  ord: number
  speakerType: SpeakerType
  speakerId: string
  body: string
  status: BeatStatus
}

export interface AssembleInput {
  agent: AgentInstanceKey
  beat: BeatSpec
  chapter: ChapterSpec
  scene: SceneSpec
  speaker: CharacterSpec | null
  spectators: SpectatorSpec[]
  /** 已按 (importance desc, id asc) 排好；pinned 独立成段，不参与相关性排序。 */
  pinned: RetrievedItem[]
  /** 已按 (score desc, id asc) 排好。 */
  retrieved: RetrievedItem[]
  /** 从新到旧。 */
  recentBeats: RecentBeatSpec[]
  maxWords?: number
  contextWindow?: number
  calibration?: number
  topK?: number
  recentLimit?: number
}

export interface AssembleResult {
  bundle: ContextBundle
  /** 本轮装配提供的可引用项；grounding 校验以它 + 工具返回为准。 */
  refs: ToolRef[]
  /** 进入上下文的检索条数（用于 meta/审计）。 */
  usedRefs: number
  usedPinned: number
  usedRecent: number
}

const FULL_L0_AGENTS: readonly AgentKey[] = ['planner', 'orchestrator', 'reviewer', 'memory']

function agentOf(agent: AgentInstanceKey): AgentKey {
  return baseAgentOf(agent)
}

export function defaultMaxWords(input: AssembleInput): number {
  return input.maxWords ?? input.beat.maxWords ?? 120
}

function stringField(card: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = card[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function stableValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(stableValue).join('、')
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key}=${stableValue((value as Record<string, unknown>)[key])}`)
      .join('；')
  }
  return ''
}

/** 角色卡核心：身份 / 声音 / 欲望 / 恐惧 / 禁忌，固定顺序、永不裁剪。 */
export function characterCardCore(character: CharacterSpec): string {
  const card = character.card
  const lines: string[] = [`角色：${character.name}`]
  const identity = stringField(card, ['identity', 'role', 'position', 'identity_label'])
  const voice = card.voice ?? card.speech ?? card.voice_style
  const want = stringField(card, ['want', 'desire', 'goal', 'motivation'])
  const fear = stringField(card, ['fear', 'dread'])
  const taboo = stringField(card, ['taboo', 'taboos', 'boundary', 'forbidden'])
  if (identity) lines.push(`身份/定位：${identity}`)
  if (voice !== undefined && voice !== null) lines.push(`声音：${stableValue(voice)}`)
  if (want) lines.push(`欲望：${want}`)
  if (fear) lines.push(`恐惧：${fear}`)
  if (taboo) lines.push(`禁忌：${taboo}`)
  return lines.join('\n')
}

function chapterL0(input: AssembleInput): string {
  const { chapter, agent } = input
  const base = agentOf(agent)
  if (FULL_L0_AGENTS.includes(base)) {
    const lines = [`章：第${chapter.ord}章 ${chapter.title}`, `章目标：${chapter.goal}`]
    if (chapter.coreEvent) lines.push(`核心事件：${chapter.coreEvent}`)
    if (chapter.forbiddenReveals.length > 0) lines.push(`禁揭：${chapter.forbiddenReveals.join('；')}`)
    return lines.join('\n')
  }
  const oneLine = chapter.goal.split(/[。！？!?\n]/)[0]?.trim() || chapter.goal
  const lines = [`本章目标：${[...oneLine].slice(0, 120).join('')}`]
  if (base === 'narrator') {
    const sequence = chapter.sceneSequence ?? []
    lines.push(`场景序列：${sequence.length > 0 ? sequence.join(' → ') : '（按分镜顺序）'}`)
  }
  return lines.join('\n')
}

function sceneL1(scene: SceneSpec): string {
  const lines = [
    `地点：${scene.location}`,
    `在场：${scene.participants.length > 0 ? scene.participants.join('、') : '（无）'}`,
    `场景目标：${scene.goal}`
  ]
  if (scene.entry) lines.push(`入口条件：${scene.entry}`)
  if (scene.exit) lines.push(`出口条件：${scene.exit}`)
  if (scene.previousResult) lines.push(`上一场结果：${scene.previousResult}`)
  return lines.join('\n')
}

function referenceLabel(type: RefType): string {
  switch (type) {
    case 'memory':
      return '记忆'
    case 'belief':
      return '信念'
    case 'fact':
      return '世界事实'
    case 'canon':
      return '公共设定'
    case 'outline':
      return '纲要'
    case 'manuscript':
      return '正文'
  }
}

function recentLine(beat: RecentBeatSpec, names: ReadonlyMap<string, string>): string {
  const speaker =
    beat.speakerType === 'narrator' ? '旁白' : (names.get(beat.speakerId) ?? beat.speakerId)
  const seq = beat.seq === null ? '-' : String(beat.seq)
  return `[seq ${seq}] ${speaker}：${beat.body}`
}

function spectatorCard(spectator: SpectatorSpec): string {
  const lines = [`[旁观] ${spectator.name}（关系张力 ${spectator.tension.toFixed(2)}）`]
  if (spectator.location) lines.push(`位置：${spectator.location}`)
  if (spectator.emotion) lines.push(`情绪：${spectator.emotion}`)
  if (spectator.known.length > 0) lines.push(`已知：${spectator.known.join('；')}`)
  if (spectator.unknown.length > 0) lines.push(`未知：${spectator.unknown.join('；')}`)
  return lines.join('\n')
}

function block(partial: Omit<CtxBlock, 'tokens'>): CtxBlock {
  return { ...partial, tokens: estimateTokens(partial.text) }
}

function capped(text: string, maxTokens: number): string {
  return truncateToTokens(text, maxTokens)
}

export function assembleContext(input: AssembleInput): AssembleResult {
  const maxWords = defaultMaxWords(input)
  const calibration = input.calibration ?? 1
  const plan = planBudget({
    contextWindow: input.contextWindow,
    maxWords,
    spectators: input.spectators.filter((spectator) => spectator.id !== input.beat.speakerId).length
  })
  const speakerCard = input.speaker ? characterCardCore(input.speaker) : ''
  const effectiveBudget = Math.ceil(plan.total / Math.max(0.7, Math.min(1.6, calibration)))

  const blocks: CtxBlock[] = []
  blocks.push(
    block({
      id: 'L0:chapter',
      layer: 'L0',
      stable: true,
      priority: 10,
      text: capped(chapterL0(input), plan.caps.l0),
      role: 'l0'
    })
  )
  blocks.push(
    block({
      id: 'L1:scene',
      layer: 'L1',
      stable: true,
      priority: 10,
      text: capped(sceneL1(input.scene), plan.caps.l1),
      role: 'l1'
    })
  )

  if (speakerCard) {
    blocks.push(
      block({
        id: 'L2:card',
        layer: 'L2',
        stable: true,
        priority: 10,
        text: capped(speakerCard, plan.caps.card),
        role: 'card'
      })
    )
  }

  const pinned = [...input.pinned]
    .sort((left, right) => right.importance - left.importance || left.id.localeCompare(right.id))
    .slice(0, plan.limits.pinnedMax)
  const pinnedKeys = new Set(pinned.map((item) => `${item.refType}:${item.id}`))

  const retrieved = [...input.retrieved]
    .filter((item) => !pinnedKeys.has(`${item.refType}:${item.id}`))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, input.topK ?? plan.limits.topK)

  for (const [index, item] of pinned.entries()) {
    const text = capped(`[${referenceLabel(item.refType)}·pin] id=${item.id}\n${item.text}`, 320)
    blocks.push(
      block({
        id: `L2:pinned:${item.refType}:${item.id}`,
        layer: 'L2',
        stable: false,
        priority: 20,
        text,
        role: 'pinned',
        order: index,
        refType: item.refType
      })
    )
  }

  for (const [index, item] of retrieved.entries()) {
    const text = capped(
      `[${referenceLabel(item.refType)}] id=${item.id}（相关度 ${item.score.toFixed(2)}）\n${item.text}`,
      320
    )
    blocks.push(
      block({
        id: `L2:ref:${item.refType}:${item.id}`,
        layer: 'L2',
        stable: false,
        priority: 30,
        text,
        role: 'ref',
        order: index,
        refType: item.refType
      })
    )
  }

  const names = new Map<string, string>()
  if (input.speaker) names.set(input.speaker.id, input.speaker.name)
  for (const spectator of input.spectators) names.set(spectator.id, spectator.name)

  const recent = [...input.recentBeats]
    .sort(
      (left, right) =>
        (right.seq ?? right.ord) - (left.seq ?? left.ord) || left.id.localeCompare(right.id)
    )
    .slice(0, input.recentLimit ?? plan.limits.recentMax)
  for (const [index, beat] of recent.entries()) {
    blocks.push(
      block({
        id: `L2:recent:${beat.id}`,
        layer: 'L2',
        stable: false,
        priority: 40,
        text: capped(recentLine(beat, names), 600),
        role: 'recent',
        order: index
      })
    )
  }

  const intent = input.beat.intent.trim() || '按分镜继续本拍。'
  blocks.push(
    block({
      id: 'L2:intent',
      layer: 'L2',
      stable: false,
      priority: 50,
      text: capped(`本拍意图：${intent}\n字数上限：${maxWords} 字`, plan.caps.intent),
      role: 'intent'
    })
  )

  const spectators = input.spectators
    .filter((spectator) => spectator.id !== input.beat.speakerId)
    .slice(0, plan.caps.spectators)
  for (const spectator of spectators) {
    blocks.push(
      block({
        id: `L3:spectator:${spectator.id}`,
        layer: 'L3',
        stable: true,
        priority: 10,
        text: capped(spectatorCard(spectator), plan.caps.spectator),
        role: 'spectator',
        tension: spectator.tension
      })
    )
  }

  const bundle = fitToBudget(blocks, effectiveBudget)
  if (retrieved.length === 0 && pinned.length === 0) bundle.degraded.push('memory_empty')

  // 只有真正进入上下文的引用才可被 grounding 引用；被裁掉的块模型没看见。
  // quote 取最终块里「标签行之后」的正文，保证模型引用的就是它实际看到的文本。
  const kept = new Map(bundle.blocks.map((item) => [item.id, item]))
  const quoteOf = (id: string, fallback: string): string => {
    const block = kept.get(id)
    if (!block) return fallback
    const newline = block.text.indexOf('\n')
    return newline === -1 ? block.text : block.text.slice(newline + 1)
  }
  const keptPinned = pinned
    .map((item) => ({ item, id: `L2:pinned:${item.refType}:${item.id}` }))
    .filter((entry) => kept.has(entry.id))
  const keptRefs = retrieved
    .map((item) => ({ item, id: `L2:ref:${item.refType}:${item.id}` }))
    .filter((entry) => kept.has(entry.id))
  const refs: ToolRef[] = [...keptPinned, ...keptRefs].map((entry) => ({
    type: entry.item.refType,
    id: entry.item.id,
    quote: quoteOf(entry.id, entry.item.text)
  }))

  return {
    bundle,
    refs,
    usedRefs: keptRefs.length,
    usedPinned: keptPinned.length,
    usedRecent: bundle.blocks.filter((item) => item.role === 'recent').length
  }
}

/** 组装结果的自检：调用方把它写进 turn_metric，不要在这里读时钟。 */
export function contextSnapshot(
  bundle: ContextBundle,
  prefixHash: string,
  meta: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    blocks: bundle.blocks.map((item) => ({
      id: item.id,
      layer: item.layer,
      stable: item.stable,
      priority: item.priority,
      tokens: item.tokens,
      role: item.role,
      order: item.order ?? null,
      ref_type: item.refType ?? null
    })),
    total_tokens: bundle.totalTokens,
    trimmed: bundle.trimmed,
    degraded: bundle.degraded,
    prefix_hash: prefixHash,
    ...meta
  })
}

export function assertBeatSpeaker(input: AssembleInput): void {
  if (input.beat.speakerType === 'character' && !input.speaker) {
    throw new AppError('setup_incomplete', 'character beat has no speaker card', { beatId: input.beat.id })
  }
}
