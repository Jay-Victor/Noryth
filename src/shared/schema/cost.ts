import { z } from 'zod'
import { MAX_CHAPTER_BUDGET_CNY, MAX_CHAPTER_BUDGET_TOKENS } from '../domain/budget'

/**
 * 成本/耗时报表契约（PHASE-20 §5.5 / M2-5）。
 *
 * 只读 IPC：`report.cost`。数字来自 `turn_metric`（0000 起就有的逐调用指标）与
 * `revision_beat`（字数），不在 UI 里二次计算。`shareBasis` 明确「按费用还是按 token」，
 * 无计价时 UI 显示「费用为下限」而不是 0。
 */

export const CostReportInputSchema = z.strictObject({
  /** 只看一章；省略 = 全书。 */
  chapterId: z.string().min(1).optional(),
  /** created_at ISO 时间窗（左闭右闭）；两端都可省略。 */
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
})
export type CostReportInput = z.infer<typeof CostReportInputSchema>

export const CostLatencySchema = z.strictObject({
  /** 样本 <5 时 P95 为 null：只显示中位数（口径写进报告脚注）。 */
  p50: z.number().int().nonnegative().nullable(),
  p95: z.number().int().nonnegative().nullable(),
  samples: z.number().int().nonnegative()
})

export const CostChapterRowSchema = z.strictObject({
  chapterId: z.string(),
  /** 已删除章为 0（报表显示「已删除章」）。 */
  ord: z.number().int().nonnegative(),
  title: z.string(),
  words: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costCny: z.number().nonnegative(),
  /** words=0 或全无计价时为 null，不显示 0。 */
  costPer10k: z.number().nonnegative().nullable(),
  calls: z.number().int().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  latencyP50: z.number().int().nonnegative().nullable(),
  latencyP95: z.number().int().nonnegative().nullable()
})
export type CostChapterRow = z.infer<typeof CostChapterRowSchema>

export const CostAgentRowSchema = z.strictObject({
  agentKey: z.string(),
  label: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costCny: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  /** 占比：有计价时按费用，否则按 token（看 `shareBasis`）。 */
  share: z.number().min(0).max(1),
  latencyP50: z.number().int().nonnegative().nullable(),
  latencyP95: z.number().int().nonnegative().nullable()
})
export type CostAgentRow = z.infer<typeof CostAgentRowSchema>

export const CostTotalsSchema = z.strictObject({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costCny: z.number().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  costPer10k: z.number().nonnegative().nullable()
})
export type CostTotals = z.infer<typeof CostTotalsSchema>

/** 每拍确认耗时：只统计作者确认（自动确认不算），来自 scheduler_event。 */
export const CostConfirmLatencySchema = z.strictObject({
  samples: z.number().int().nonnegative(),
  p50: z.number().int().nonnegative().nullable(),
  p95: z.number().int().nonnegative().nullable(),
  /** 有 beat_committed 但没有 beat_confirmed 的拍（自动确认或未确认）；不补 0。 */
  missingBeats: z.number().int().nonnegative()
})
export type CostConfirmLatency = z.infer<typeof CostConfirmLatencySchema>

export const CostReportSchema = z.strictObject({
  total: CostTotalsSchema,
  byChapter: z.array(CostChapterRowSchema),
  byAgent: z.array(CostAgentRowSchema),
  /** 项目级（chapter_id IS NULL）：规划费用单列，不摊到章。 */
  projectLevel: z.strictObject({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    costCny: z.number().nonnegative(),
    calls: z.number().int().nonnegative()
  }),
  /** cost = 有计价；tokens = 全无计价时的退路（UI 标「按 token」）。 */
  shareBasis: z.enum(['cost', 'tokens']),
  confirm: CostConfirmLatencySchema,
  generatedAt: z.string()
})
export type CostReport = z.infer<typeof CostReportSchema>

/** 章节预算编辑（PHASE-20 §5.4）：null = 回到默认值。 */
export const WriteBudgetInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  budgetCny: z.number().min(0).max(MAX_CHAPTER_BUDGET_CNY).nullable().optional(),
  budgetTokens: z.number().int().min(0).max(MAX_CHAPTER_BUDGET_TOKENS).nullable().optional()
})
export type WriteBudgetInput = z.infer<typeof WriteBudgetInputSchema>
