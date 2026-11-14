import { z } from 'zod'
import { GroundingItemSchema } from './envelope'

/**
 * 开发切片（PHASE-05）的 IPC 契约。
 *
 * 只在未打包的构建里注册通道；生产包不暴露 seed/generate/confirm 等入口。
 * 所有字段显式声明（strictObject），多余参数一律拒绝。
 */

/** 与 0001_init.sql 的 beat.status 检查约束保持一致。 */
export const SLICE_BEAT_STATUSES = [
  'proposed',
  'generating',
  'draft',
  'waiting_for_human',
  'confirmed',
  'regenerating',
  'rejected',
  'author_edited',
  'stale',
  'superseded',
  'interrupted'
] as const
export const SliceBeatStatusSchema = z.enum(SLICE_BEAT_STATUSES)
export type SliceBeatStatus = z.infer<typeof SliceBeatStatusSchema>

/**
 * 切片 UI 的状态矩阵（PHASE-05 §5.3）：状态 → 文案 / 是否占用生成槽位。
 * 新增 beat 状态时这里必须同步，否则 `slice/status-matrix.test.ts` 会红。
 */
export const SLICE_STATUS_LABELS: Record<SliceBeatStatus, string> = {
  proposed: '待生成',
  generating: '生成中',
  draft: '草稿',
  waiting_for_human: '待确认',
  confirmed: '已确认',
  regenerating: '重生成中',
  rejected: '已拒绝',
  author_edited: '已编辑',
  stale: '已过期',
  superseded: '被替换',
  interrupted: '已中断'
}
export const SLICE_BUSY_STATUSES: readonly SliceBeatStatus[] = ['generating', 'regenerating']

export const SliceBeatSchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  speakerType: z.enum(['character', 'narrator']),
  speakerId: z.string(),
  speakerName: z.string(),
  intent: z.string(),
  body: z.string(),
  status: SliceBeatStatusSchema,
  grounding: z.array(GroundingItemSchema),
  traceRef: z.string().nullable(),
  revisionId: z.string(),
  wordCount: z.number().int().nonnegative(),
  maxWords: z.number().int().positive().nullable(),
  updatedAt: z.string()
})
export type SliceBeatState = z.infer<typeof SliceBeatSchema>

export const SliceStateSchema = z.strictObject({
  devOnly: z.literal(true),
  projectId: z.string(),
  chapterId: z.string(),
  chapterOrd: z.number().int().positive(),
  chapterTitle: z.string(),
  revisionId: z.string().nullable(),
  contentHash: z.string().nullable(),
  beats: z.array(SliceBeatSchema),
  /** 最近一个生成任务；崩溃恢复后应为 interrupted。 */
  lastJob: z
    .strictObject({
      id: z.string(),
      status: z.string(),
      errorCode: z.string().nullable()
    })
    .nullable()
})
export type SliceState = z.infer<typeof SliceStateSchema>

export const SliceEmptyInputSchema = z.strictObject({})
export const SliceBeatInputSchema = z.strictObject({ beatId: z.string().min(1) })
export const SliceEditInputSchema = z.strictObject({
  beatId: z.string().min(1),
  body: z.string().min(1).max(4000),
  /** UI 加载时的 chapter.current_revision_id；不一致拒绝写入。 */
  expectedRevision: z.string().nullable()
})
export type SliceEditInput = z.infer<typeof SliceEditInputSchema>

export const SliceSeedResultSchema = z.strictObject({
  projectId: z.string(),
  chapterId: z.string(),
  sceneId: z.string(),
  beatIds: z.array(z.string()),
  characterIds: z.array(z.string()),
  /** false = 已经有切片数据，未重复写入。 */
  seeded: z.boolean()
})
export type SliceSeedResult = z.infer<typeof SliceSeedResultSchema>

export const SliceGenerateResultSchema = z.strictObject({
  jobId: z.string(),
  status: z.enum(['committed', 'rejected']),
  beatId: z.string().nullable(),
  revisionId: z.string().nullable(),
  contentHash: z.string().nullable(),
  rejection: z
    .strictObject({
      code: z.string(),
      message: z.string()
    })
    .nullable(),
  state: SliceStateSchema
})
export type SliceGenerateResult = z.infer<typeof SliceGenerateResultSchema>

/**
 * 流式事件（renderer 用 seq 丢弃乱序）：只携带当前拍的增量。
 * `committed` / `failed` 是终态；已确认拍不会收到任何 delta。
 */
export const SliceBeatEventSchema = z.strictObject({
  projectId: z.string(),
  jobId: z.string(),
  turnId: z.string(),
  beatId: z.string(),
  seq: z.number().int().nonnegative(),
  phase: z.enum(['start', 'delta', 'validated', 'committed', 'failed']),
  delta: z.string().optional(),
  full: z.string().optional(),
  code: z.string().optional()
})
export type SliceBeatEvent = z.infer<typeof SliceBeatEventSchema>
