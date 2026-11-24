import { z } from 'zod'
import { DimensionKeySchema } from './report'

/**
 * 异构复检校准报告（PHASE-21 §5.4 / M2-8）。
 *
 * 只读 `approval_report` / `patch` / `gate_record`，不新增打分 UI。
 * 「阻断被作者接受（patch 应用）」是代理指标，不是人工标注的召回率；
 * 报告必须把这一点写进 limitations。
 */

export const CalibrationCohortSchema = z.strictObject({
  reports: z.number().int().nonnegative(),
  blocking: z.strictObject({
    total: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    acceptanceRate: z.number().nullable()
  }),
  /** 每份报告的阻断数；异构组的「漏报代理」越大越好，只作代理。 */
  blockingPerReport: z.number().nullable()
})
export type CalibrationCohort = z.infer<typeof CalibrationCohortSchema>

export const CalibrationDimensionSchema = z.strictObject({
  dimension: DimensionKeySchema,
  meanScore: z.number().nullable(),
  acceptedMean: z.number().nullable(),
  rejectedMean: z.number().nullable(),
  samples: z.number().int().nonnegative()
})
export type CalibrationDimension = z.infer<typeof CalibrationDimensionSchema>

export const CalibrationDecisionSchema = z.strictObject({
  /** D4 判定：只有规则全部满足才推荐 prefer；否则保持 off。 */
  recommended: z.enum(['off', 'prefer']),
  reasons: z.array(z.string())
})
export type CalibrationDecision = z.infer<typeof CalibrationDecisionSchema>

export const CalibrationReportSchema = z.strictObject({
  reports: z.number().int().nonnegative(),
  blocking: z.strictObject({
    total: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    acceptanceRate: z.number().nullable()
  }),
  suggestions: z.strictObject({
    total: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    acceptanceRate: z.number().nullable()
  }),
  byDimension: z.array(CalibrationDimensionSchema),
  cost: z.strictObject({
    reviewCny: z.number(),
    generationCny: z.number(),
    /** 预设计价模拟的费用差；无法计价（第二家没价格）时为 null。 */
    heteroDeltaPct: z.number().nullable()
  }),
  /** 同家 / 异构两组的对照；任一为空表示没有可比数据。 */
  cohorts: z.strictObject({
    sameProvider: CalibrationCohortSchema,
    heteroProvider: CalibrationCohortSchema
  }),
  /** G6 已定稿章数（只读 gate_record，证明数据覆盖到定稿）。 */
  finalizedChapters: z.number().int().nonnegative(),
  decision: CalibrationDecisionSchema,
  limitations: z.array(z.string()),
  generatedAt: z.string()
})
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>
