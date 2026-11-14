import { AppError } from '../../shared/domain/app-error'
import type { RefType } from '../tools/types'
import { estimateTokens, truncateToTokens } from './tokens'

/**
 * 上下文预算与裁剪（DEV-PLAN §7.3）。
 *
 * 纯函数：输入相同则输出相同。排序键固定为 `(layer, priority, id)`；
 * priority 表示「提示词里的先后」，裁剪顺序由 role 分组显式执行，
 * 两者分开，避免用一个字段同时承担两种含义。
 */

export type Layer = 'L0' | 'L1' | 'L2' | 'L3'

export type BlockRole =
  | 'l0'
  | 'l1'
  | 'card'
  | 'pinned'
  | 'ref'
  | 'recent'
  | 'intent'
  | 'spectator'

export interface CtxBlock {
  id: string
  layer: Layer
  /** 稳定前缀：参与供应商前缀缓存。 */
  stable: boolean
  /** 显示顺序（越小越靠前）；裁剪顺序见 TRIM_ORDER。 */
  priority: number
  tokens: number
  text: string
  role: BlockRole
  /** 仅 ref / pinned / recent：同组内的保留顺序（0 最该保留），裁剪从大到小丢。 */
  order?: number
  /** 仅 ref / pinned：引用类型，用于记忆降级。 */
  refType?: RefType
  /** 仅 spectator：关系张力，裁剪时先丢最低者。 */
  tension?: number
}

export interface ContextBundle {
  blocks: CtxBlock[]
  totalTokens: number
  /** 被裁掉的块 id，按裁剪发生顺序。 */
  trimmed: string[]
  /** 降级标记：context_trimmed / memory_empty / memory_facts_only。 */
  degraded: string[]
}

export const BUDGET = {
  hardCapRatio: 0.5,
  hardCapTokens: 12_000,
  l0: 900,
  l1: 600,
  card: 700,
  intent: 160,
  spectator: 150,
  maxSpectators: 8,
  pinnedMax: 5,
  recentDefault: 6,
  recentMin: 2,
  refsMin: 2,
  topKDefault: 5
} as const

export interface BudgetInput {
  /** 绑定模型的能力探测值；未知按 32k（DEV-PLAN §7.3）。 */
  contextWindow?: number
  maxWords: number
  /** 在场的非发言者数量。 */
  spectators: number
}

export interface BudgetPlan {
  contextWindow: number
  hardCap: number
  reserveOut: number
  /** 固定块（L0/L1/卡/意图/L3）之后的剩余额度。 */
  dynamic: number
  caps: {
    l0: number
    l1: number
    card: number
    intent: number
    spectator: number
    spectators: number
  }
  limits: {
    pinnedMax: number
    recentMax: number
    recentMin: number
    refsMin: number
    topK: number
  }
  total: number
}

export function planBudget(input: BudgetInput): BudgetPlan {
  const contextWindow = Math.max(1, Math.trunc(input.contextWindow ?? 32_000))
  const hardCap = Math.min(Math.floor(contextWindow * BUDGET.hardCapRatio), BUDGET.hardCapTokens)
  const maxWords = Math.max(0, Math.trunc(input.maxWords))
  const reserveOut = Math.ceil(maxWords * 1.4) + 400
  const total = Math.max(0, hardCap - reserveOut)

  const spectators = Math.max(0, Math.min(Math.trunc(input.spectators), BUDGET.maxSpectators))
  const fixed =
    BUDGET.l0 + BUDGET.l1 + BUDGET.card + BUDGET.intent + BUDGET.spectator * spectators

  return {
    contextWindow,
    hardCap,
    reserveOut,
    total,
    dynamic: Math.max(0, total - fixed),
    caps: {
      l0: BUDGET.l0,
      l1: BUDGET.l1,
      card: BUDGET.card,
      intent: BUDGET.intent,
      spectator: BUDGET.spectator,
      spectators
    },
    limits: {
      pinnedMax: BUDGET.pinnedMax,
      recentMax: BUDGET.recentDefault,
      recentMin: BUDGET.recentMin,
      refsMin: BUDGET.refsMin,
      topK: BUDGET.topKDefault
    }
  }
}

export const TRIM_ORDER = [
  'recent',
  'refs',
  'spectators',
  'pinned',
  'memory_degrade',
  'overflow'
] as const

function tokensOf(blocks: readonly CtxBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokens, 0)
}

function withText(block: CtxBlock, text: string): CtxBlock {
  return { ...block, text, tokens: estimateTokens(text) }
}

function sortBlocks(blocks: readonly CtxBlock[]): CtxBlock[] {
  const layerRank: Record<Layer, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }
  return [...blocks].sort(
    (left, right) =>
      layerRank[left.layer] - layerRank[right.layer] ||
      left.priority - right.priority ||
      left.id.localeCompare(right.id)
  )
}

/**
 * 超预算时按 DEV-PLAN §7.3 的顺序裁剪：
 *   a 最近拍（保留至少 2）→ b top_k（最低 2）→ c L3 张力最低者
 *   → d pinned 5→3→1 → e 记忆 full→summary→facts_only → f context_overflow
 * 角色卡核心与本拍意图不在任何一步裁剪。
 */
export function fitToBudget(blocks: readonly CtxBlock[], budget: number): ContextBundle {
  let kept = sortBlocks(blocks)
  const trimmed: string[] = []
  const degraded: string[] = []

  const drop = (block: CtxBlock): void => {
    kept = kept.filter((item) => item.id !== block.id)
    trimmed.push(block.id)
  }

  const group = (role: BlockRole): CtxBlock[] =>
    kept
      .filter((block) => block.role === role)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))

  if (tokensOf(kept) > budget) degraded.push('context_trimmed')

  // a) 历史拍：从最旧开始丢，保留至少 recentMin
  while (tokensOf(kept) > budget) {
    const recent = group('recent')
    if (recent.length <= BUDGET.recentMin) break
    drop(recent[recent.length - 1]!)
  }

  // b) 检索 refs：丢最低分（调用方按 score desc, id asc 排列，id 顺序即名次）
  while (tokensOf(kept) > budget) {
    const refs = group('ref')
    if (refs.length <= BUDGET.refsMin) break
    drop(refs[refs.length - 1]!)
  }

  // c) L3 旁观者：丢张力最低者；张力相同按 id 倒序（后面的先丢）
  while (tokensOf(kept) > budget) {
    const spectators = kept
      .filter((block) => block.role === 'spectator')
      .sort((left, right) => (left.tension ?? 0) - (right.tension ?? 0) || right.id.localeCompare(left.id))
    const victim = spectators[0]
    if (!victim) break
    drop(victim)
  }

  // d) pinned 5 → 3 → 1
  for (const target of [3, 1]) {
    if (tokensOf(kept) <= budget) break
    let pinned = group('pinned')
    while (pinned.length > target && tokensOf(kept) > budget) {
      drop(pinned[pinned.length - 1]!)
      pinned = group('pinned')
    }
  }

  // e) 记忆降级：full → summary → facts_only
  for (const level of ['summary', 'facts_only'] as const) {
    if (tokensOf(kept) <= budget) break
    const limit = level === 'summary' ? 60 : 24
    kept = kept.map((block) => {
      if ((block.role !== 'ref' && block.role !== 'pinned') || block.refType !== 'memory') return block
      const text = truncateToTokens(block.text, limit, level === 'summary' ? '…' : '')
      return text === block.text ? block : withText(block, text)
    })
    degraded.push(level === 'summary' ? 'memory_summary' : 'memory_facts_only')
  }

  // f) 仍超预算：配置错误，不静默截角色卡与意图
  if (tokensOf(kept) > budget) {
    throw new AppError('context_overflow', 'context exceeds budget after trimming', {
      budget,
      total: tokensOf(kept),
      blocks: kept.map((block) => ({ id: block.id, tokens: block.tokens }))
    })
  }

  const ordered = sortBlocks(kept)
  return { blocks: ordered, totalTokens: tokensOf(ordered), trimmed, degraded }
}

/** 前缀 hash 的输入：只取稳定块（system + L0/L1）。 */
export function stablePrefixText(blocks: readonly CtxBlock[]): string {
  return sortBlocks(blocks)
    .filter((block) => block.stable)
    .map((block) => `[${block.id}]\n${block.text}`)
    .join('\n\n')
}
