import {
  BUDGET_RANGE_HIGH,
  BUDGET_RANGE_LOW,
  DEFAULT_TOKENS_PER_BEAT
} from '../../shared/domain/budget'

/**
 * 费用预测（PHASE-20 §5.2 / M2-3）。
 *
 * 纯函数：同一输入两次相等，不读数据库、不调模型、不带随机。
 *   remainingBeats = maxBeats - beatsGenerated
 *   perBeatTokens  = median(最近 5 拍 tokens_in + tokens_out)（不足 5 拍用 900）
 *   perBeatCost    = median(最近 5 拍 cost_cny)（无计价则 null）
 *   range          = 0.7 × mid .. 1.3 × mid
 *
 * 预检只估自动模式的拍；审批 / 记忆 / 导出不在其中（UI 明确写「不含审批与记忆费用」）。
 */

export interface ForecastSample {
  tokensIn: number | null
  tokensOut: number | null
  costCny: number | null
}

export interface ForecastRange {
  low: number
  mid: number
  high: number
}

export interface BudgetForecast {
  beats: number
  tokens: ForecastRange
  /** 全窗口都没有计价时为 null（UI 不显示假精确值）。 */
  cost: ForecastRange | null
  basis: 'recent' | 'default'
  /** 参与中位数计算的样本数（最多 5）。 */
  sampleSize: number
}

const WINDOW = 5

/** 中位数：偶数个取中间两个的均值；空数组返回 0（调用方先判空）。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

function tokensOf(sample: ForecastSample): number | null {
  if (sample.tokensIn === null && sample.tokensOut === null) return null
  return (sample.tokensIn ?? 0) + (sample.tokensOut ?? 0)
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function rangeOf(mid: number, round: (value: number) => number): ForecastRange {
  return {
    low: round(mid * BUDGET_RANGE_LOW),
    mid: round(mid),
    high: round(mid * BUDGET_RANGE_HIGH)
  }
}

export function forecastBudget(input: {
  remainingBeats: number
  /** 最近 N 次写拍调用（升序或降序都可以，这里只取最后 5 条）。 */
  recent: readonly ForecastSample[]
}): BudgetForecast {
  const beats = Math.max(0, Math.trunc(input.remainingBeats))
  const samples = input.recent.slice(-WINDOW)
  const tokenValues = samples
    .map(tokensOf)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const costValues = samples
    .map((sample) => sample.costCny)
    .filter((value): value is number => value !== null && Number.isFinite(value))

  const enough = tokenValues.length >= WINDOW
  const perBeatTokens = enough ? median(tokenValues) : DEFAULT_TOKENS_PER_BEAT
  const tokens = rangeOf(perBeatTokens * beats, (value) => Math.round(value))
  const cost =
    costValues.length === 0
      ? null
      : rangeOf(median(costValues) * beats, round4)

  return {
    beats,
    tokens,
    cost,
    basis: enough ? 'recent' : 'default',
    sampleSize: samples.length
  }
}
