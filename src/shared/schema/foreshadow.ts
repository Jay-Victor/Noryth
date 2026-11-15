import { z } from 'zod'

/**
 * 伏笔契约（PHASE-15 M1-10）。
 *
 * 边界（PRD §4.10 T22 / §8.4）：
 * - 伏笔只由作者标注；M1 不做自动语义识别（M2）。
 * - 只报节奏（距离 / 是否超期），不产生逻辑判定、不进记忆检索、不阻断任何闸门。
 * - 伏笔不设时间衰减：不会被「时间久」自动回收。
 */

export const FORESHADOW_STATUSES = ['open', 'closed'] as const
export const ForeshadowStatusSchema = z.enum(FORESHADOW_STATUSES)

export const ForeshadowViewSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  status: ForeshadowStatusSchema,
  plantedChapterId: z.string().nullable(),
  plantedOrd: z.number().int().nullable(),
  plannedPayoffChapterId: z.string().nullable(),
  plannedPayoffOrd: z.number().int().nullable(),
  payoffChapterId: z.string().nullable(),
  payoffOrd: z.number().int().nullable(),
  /** 距埋设章已过几章（按当前章算）；没有埋设章或当前章早于埋设章时为 0。 */
  distance: z.number().int().nonnegative(),
  /** 已过计划回收章仍未回收：只标「已 N 章未回收」，不阻断。 */
  overdue: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type ForeshadowView = z.infer<typeof ForeshadowViewSchema>

export const ForeshadowStateSchema = z.strictObject({
  readOnly: z.boolean(),
  /** 当前章（距离与超期的参照）；null = 未选章，用最后一章。 */
  chapterId: z.string().nullable(),
  chapterOrd: z.number().int().nullable(),
  chapters: z.array(z.strictObject({ id: z.string(), ord: z.number().int(), title: z.string() })),
  items: z.array(ForeshadowViewSchema),
  openCount: z.number().int().nonnegative(),
  closedCount: z.number().int().nonnegative()
})
export type ForeshadowState = z.infer<typeof ForeshadowStateSchema>

export const ForeshadowListInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional()
})
export type ForeshadowListInput = z.infer<typeof ForeshadowListInputSchema>

export const ForeshadowCreateInputSchema = z.strictObject({
  text: z.string().min(1).max(300),
  plantedChapterId: z.string().min(1),
  plannedPayoffChapterId: z.string().min(1).nullable().optional()
})
export type ForeshadowCreateInput = z.infer<typeof ForeshadowCreateInputSchema>

export const ForeshadowUpdateInputSchema = z.strictObject({
  foreshadowId: z.string().min(1),
  text: z.string().min(1).max(300).optional(),
  /** 省略 = 不改；null = 清空计划回收章。 */
  plannedPayoffChapterId: z.string().min(1).nullable().optional()
})
export type ForeshadowUpdateInput = z.infer<typeof ForeshadowUpdateInputSchema>

export const ForeshadowCloseInputSchema = z.strictObject({
  foreshadowId: z.string().min(1),
  payoffChapterId: z.string().min(1)
})
export type ForeshadowCloseInput = z.infer<typeof ForeshadowCloseInputSchema>

export const ForeshadowIdInputSchema = z.strictObject({ foreshadowId: z.string().min(1) })

/** 标注动作的返回：整表 + 本次条目（删除时为 null），UI 一次刷新。 */
export const ForeshadowMutationResultSchema = z.strictObject({
  state: ForeshadowStateSchema,
  item: ForeshadowViewSchema.nullable()
})
export type ForeshadowMutationResult = z.infer<typeof ForeshadowMutationResultSchema>

/** T22 foreshadow.list_open 的输出（契约变更：PRD §4.10 T22 行已同步）。 */
export const ForeshadowListOpenOutputSchema = z.strictObject({
  as_of_chapter_id: z.string().nullable(),
  as_of_ord: z.number().int().nullable(),
  items: z.array(
    z.strictObject({
      id: z.string(),
      text: z.string(),
      status: ForeshadowStatusSchema,
      planted_chapter_id: z.string().nullable(),
      planted_chapter_ord: z.number().int().nullable(),
      distance: z.number().int().nonnegative(),
      planned_payoff_chapter_id: z.string().nullable(),
      overdue: z.boolean(),
      /** 只报节奏：例如「已 7 章未回收」。 */
      note: z.string()
    })
  )
})
export type ForeshadowListOpenOutput = z.infer<typeof ForeshadowListOpenOutputSchema>
