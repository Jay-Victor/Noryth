/**
 * 章预算口径（PHASE-20 §5.1 / M2-3）。
 *
 * 唯一真源：`chapterBudget()`（main）与预算编辑器（renderer）都读这里，
 * UI 里不再出现 120000 / 5.00 之类的字面量。
 *
 * 两套预算同时生效：token 与人民币，任一超限都算 `budget_exceeded`。
 * 费用只累加有计价的行；没有计价时 `unpricedCalls > 0`，UI 显示「费用为下限」，
 * 不把未知当 0 写成假精确值。
 */

export const DEFAULT_CHAPTER_BUDGET_TOKENS = 120_000
export const DEFAULT_CHAPTER_BUDGET_CNY = 5

/** 预检区间：0.7 × mid .. 1.3 × mid（PHASE-20 §5.2）。 */
export const BUDGET_RANGE_LOW = 0.7
export const BUDGET_RANGE_HIGH = 1.3

/** 没有 5 拍历史时的回落值（PHASE-20 §5.2）。 */
export const DEFAULT_TOKENS_PER_BEAT = 900

/** 预算编辑的可接受范围（防误输入；不是产品承诺）。 */
export const MAX_CHAPTER_BUDGET_TOKENS = 10_000_000
export const MAX_CHAPTER_BUDGET_CNY = 10_000

export type BudgetReason = 'tokens' | 'cost' | 'both'

export interface ChapterBudget {
  tokensUsed: number
  tokensLimit: number
  costUsed: number
  costLimit: number
  /** 有计价（cost_cny 非空）的调用数。 */
  pricedCalls: number
  /** 无计价的调用数；>0 时费用只是下限。 */
  unpricedCalls: number
  exceeded: boolean
  reason: BudgetReason | null
}

export const BUDGET_REASON_LABELS: Record<BudgetReason, string> = {
  tokens: 'token 预算已用尽',
  cost: '费用预算已用尽',
  both: 'token 与费用预算都已用尽'
}

/** 费用比较的浮点容差：0.1 + 0.2 不应因表示误差漏判超限。 */
const COST_EPSILON = 1e-9

export function budgetReasonOf(input: {
  tokensUsed: number
  tokensLimit: number
  costUsed: number
  costLimit: number
  pricedCalls: number
}): BudgetReason | null {
  const tokensOver = input.tokensUsed >= input.tokensLimit
  // 没有计价调用时无法证明超限：0 不等于「没花钱」，交给 token 预算兜底。
  const costOver = input.pricedCalls > 0 && input.costUsed + COST_EPSILON >= input.costLimit
  if (tokensOver && costOver) return 'both'
  if (tokensOver) return 'tokens'
  if (costOver) return 'cost'
  return null
}

/** `¥0.84`；小于 ¥0.1 时多给一位小数（预算很小时不显示成 ¥0.00）。 */
export function formatCny(value: number): string {
  return `¥${value > 0 && value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`
}

/** 费用是下限时带 `≥`。 */
export function formatBudgetCost(budget: Pick<ChapterBudget, 'costUsed' | 'costLimit' | 'unpricedCalls'>): string {
  const prefix = budget.unpricedCalls > 0 ? '≥' : ''
  return `${prefix}${formatCny(budget.costUsed)} / ${formatCny(budget.costLimit)}`
}

/** `12.4k / 120k`；小数位只用于可读，不参与判定。 */
export function formatBudgetTokens(tokens: number): string {
  if (tokens < 10_000) return String(Math.round(tokens))
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
}
