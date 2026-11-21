import { z } from 'zod'
import {
  DimensionKeySchema,
  DimensionScoresSchema,
  IssueSchema,
  VerdictSchema
} from './report'

/**
 * 审批台（PHASE-08）的 IPC 契约。
 *
 * 与创作台同构：状态里只放 UI 需要的东西；所有请求 strictObject。
 * 报告 → patch → 新 revision → 复检 → 定稿的每一步都单独一个动作，
 * 因为每一步的闸门与失败语义不同（讨论不改稿 / G5 才出 patch / G6 才定稿）。
 */

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  draft_complete: '待审批',
  under_review: '审批中',
  revising: '修订中',
  approved: '已通过',
  finalized: '已定稿',
  drafting: '创作中',
  storyboard_ready: '已分镜',
  planned: '已规划',
  paused: '已暂停',
  abandoned: '已放弃'
}

export const ReviewBeatSchema = z.strictObject({
  beatId: z.string(),
  ord: z.number().int().positive(),
  sceneOrd: z.number().int().positive(),
  speakerType: z.enum(['character', 'narrator']),
  speakerName: z.string(),
  body: z.string(),
  status: z.string(),
  wordCount: z.number().int().nonnegative(),
  /** 该拍命中的阻断/建议条数（初稿 gutter 用）。 */
  blockingCount: z.number().int().nonnegative(),
  suggestionCount: z.number().int().nonnegative()
})
export type ReviewBeatState = z.infer<typeof ReviewBeatSchema>

export const ReviewReportStateSchema = z.strictObject({
  id: z.string(),
  round: z.number().int().positive(),
  verdict: VerdictSchema,
  revisionId: z.string(),
  blocking: z.array(IssueSchema),
  suggestions: z.array(IssueSchema),
  dimensions: DimensionScoresSchema,
  /** 复检范围；空数组 = 全量报告。 */
  scope: z.array(DimensionKeySchema),
  degraded: z.string().nullable(),
  model: z.string().nullable(),
  /** 异构复检留痕（PHASE-16 §5.3）：报告由哪一家产出。 */
  provider: z.string().nullable(),
  createdAt: z.string()
})
export type ReviewReportState = z.infer<typeof ReviewReportStateSchema>

export const ReviewReportSummarySchema = z.strictObject({
  id: z.string(),
  round: z.number().int().positive(),
  verdict: VerdictSchema,
  blockingCount: z.number().int().nonnegative(),
  suggestionCount: z.number().int().nonnegative(),
  scope: z.array(DimensionKeySchema),
  createdAt: z.string()
})
export type ReviewReportSummary = z.infer<typeof ReviewReportSummarySchema>

export const ReviewPatchStateSchema = z.strictObject({
  id: z.string(),
  proposalId: z.string(),
  revisionId: z.string(),
  beatId: z.string(),
  sceneOrd: z.number().int().nonnegative(),
  beatOrd: z.number().int().nonnegative(),
  speakerName: z.string(),
  before: z.string(),
  after: z.string(),
  reason: z.string(),
  issueRef: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'applied', 'superseded']),
  appliedRevisionId: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable()
})
export type ReviewPatchState = z.infer<typeof ReviewPatchStateSchema>

export const ReviewVersionStateSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['draft', 'final']),
  parentRevisionId: z.string().nullable(),
  contentHash: z.string(),
  createdBy: z.string(),
  note: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** 分支（PHASE-16 §5.2）：null = 主线；final 永远 null。 */
  branchId: z.string().nullable()
})
export type ReviewVersionState = z.infer<typeof ReviewVersionStateSchema>

export const ReviewBranchStateSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  baseRevisionId: z.string(),
  headRevisionId: z.string(),
  status: z.enum(['open', 'merged', 'archived']),
  createdAt: z.string(),
  isCurrent: z.boolean()
})
export type ReviewBranchState = z.infer<typeof ReviewBranchStateSchema>

export const ReviewMessageSchema = z.strictObject({
  id: z.string(),
  round: z.number().int().nonnegative(),
  role: z.enum(['author', 'reviewer', 'system']),
  kind: z.enum(['text', 'report', 'patch', 'pause']),
  body: z.string(),
  createdAt: z.string()
})
export type ReviewMessageState = z.infer<typeof ReviewMessageSchema>

export const ReviewChapterSummarySchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  title: z.string(),
  status: z.string(),
  rounds: z.number().int().nonnegative(),
  verdict: VerdictSchema.nullable(),
  /** 蓝图变更标脏（PHASE-15）：G4 前提示「待重审」，不阻断审批。 */
  invalidatedAt: z.string().nullable()
})
export type ReviewChapterSummary = z.infer<typeof ReviewChapterSummarySchema>

export const ReviewUnreviewedItemSchema = z.strictObject({
  kind: z.enum(['patch', 'edit', 'revision']),
  id: z.string(),
  label: z.string()
})
export type ReviewUnreviewedItem = z.infer<typeof ReviewUnreviewedItemSchema>

export const ReviewFinalizePreviewSchema = z.strictObject({
  ready: z.boolean(),
  blockers: z.array(z.string()),
  blocking: z.array(IssueSchema),
  unreviewed: z.array(ReviewUnreviewedItemSchema),
  /** 未被报告覆盖、但已应用/手改的拍数（勾选「我已复核」的对象）。 */
  unreviewedCount: z.number().int().nonnegative(),
  rounds: z.number().int().nonnegative(),
  takeover: z.boolean(),
  alreadyFinalized: z.boolean(),
  finalRevisionId: z.string().nullable()
})
export type ReviewFinalizePreview = z.infer<typeof ReviewFinalizePreviewSchema>

export const ReviewGateSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  /** G5 的轮次；G6 的报告轮次。 */
  round: z.number().int().nonnegative()
})
export type ReviewGateState = z.infer<typeof ReviewGateSchema>

export const ReviewSceneRefSchema = z.strictObject({
  sceneId: z.string(),
  /** chapter_scene.ord */
  ord: z.number().int().nonnegative(),
  location: z.string()
})
export type ReviewSceneRef = z.infer<typeof ReviewSceneRefSchema>

export const ReviewStateSchema = z.strictObject({
  projectId: z.string(),
  projectTitle: z.string(),
  chapterId: z.string(),
  chapterOrd: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterStatus: z.string(),
  readOnly: z.boolean(),
  revisionId: z.string().nullable(),
  contentHash: z.string().nullable(),
  finalRevisionId: z.string().nullable(),
  /**
   * 本章认知快照（PHASE-13 M1-19）：审批按 `covered_until_seq` 展开，
   * 不再用项目水位 `seq_head`。0 表示还没写过正文，复审会被拒绝。
   */
  asOf: z.number().int().nonnegative(),
  rounds: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  takeover: z.boolean(),
  chapters: z.array(ReviewChapterSummarySchema),
  draft: z.array(ReviewBeatSchema),
  /** 本章场景引用（PHASE-19 M2-2）：声音面板按 sceneId 读 `voice.scene`。 */
  scenes: z.array(ReviewSceneRefSchema),
  report: ReviewReportStateSchema.nullable(),
  reports: z.array(ReviewReportSummarySchema),
  patches: z.array(ReviewPatchStateSchema),
  versions: z.array(ReviewVersionStateSchema),
  /** 分支树（M1-21）：主线末梢 + 分支列表；切到 final 走「重新打开」。 */
  branches: z.array(ReviewBranchStateSchema),
  mainlineHeadId: z.string().nullable(),
  mainlineCurrent: z.boolean(),
  /** 当前 revision 所属分支；null = 主线。 */
  branchId: z.string().nullable(),
  g5: ReviewGateSchema,
  g6: ReviewFinalizePreviewSchema,
  messages: z.array(ReviewMessageSchema),
  running: z.boolean(),
  /** 报告是否已生成；false 时预览显示骨架 + 生成按钮（UI-DESIGN §6.1）。 */
  hasReport: z.boolean(),
  model: z.strictObject({
    provider: z.string(),
    model: z.string(),
    label: z.string(),
    ready: z.boolean()
  })
})
export type ReviewState = z.infer<typeof ReviewStateSchema>

export const ReviewDiffLineSchema = z.strictObject({
  kind: z.enum(['same', 'add', 'remove']),
  leftNo: z.number().int().nonnegative(),
  rightNo: z.number().int().nonnegative(),
  text: z.string()
})
export type ReviewDiffLine = z.infer<typeof ReviewDiffLineSchema>

export const ReviewDiffHunkSchema = z.strictObject({
  /** hunk 锚点：同一拍的两版对比；null = 新增/删除段落。 */
  beatId: z.string().nullable(),
  sceneOrd: z.number().int().nonnegative(),
  beatOrd: z.number().int().nonnegative(),
  speakerName: z.string(),
  status: z.enum(['same', 'changed', 'added', 'removed']),
  leftBeatId: z.string().nullable(),
  rightBeatId: z.string().nullable(),
  lines: z.array(ReviewDiffLineSchema)
})
export type ReviewDiffHunk = z.infer<typeof ReviewDiffHunkSchema>

export const ReviewCompareResultSchema = z.strictObject({
  chapterId: z.string(),
  leftRevisionId: z.string(),
  rightRevisionId: z.string(),
  leftHash: z.string(),
  rightHash: z.string(),
  changedBeats: z.number().int().nonnegative(),
  hunks: z.array(ReviewDiffHunkSchema)
})
export type ReviewCompareResult = z.infer<typeof ReviewCompareResultSchema>

/** 请求体。 */
export const ReviewChapterInputSchema = z.strictObject({ chapterId: z.string().min(1) })
export const ReviewSendInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  text: z.string().min(1).max(4000)
})
export const ReviewDecideInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  /** 作者看到 patch 时的草稿 revision；与当前不一致即 stale_revision。 */
  expectedRevision: z.string().nullable(),
  decisions: z
    .array(
      z.strictObject({
        patchId: z.string().min(1),
        accept: z.boolean()
      })
    )
    .min(1)
    .max(40)
})
export const ReviewFinalizeInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  token: z.string().min(1),
  /** 有阻断时勾选「我已复核」。 */
  ackBlocking: z.boolean(),
  /** 有未复检改动时勾选「我已复核」。 */
  ackUnreviewed: z.boolean(),
  reason: z.string().max(500).optional()
})
export const ReviewCompareInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  leftRevisionId: z.string().min(1),
  rightRevisionId: z.string().min(1)
})
export const ReviewReopenInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  reason: z.string().max(500).optional()
})
export const ReviewBranchCreateInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  name: z.string().min(1).max(40)
})
export const ReviewBranchSwitchInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  /** null = 切回主线。 */
  branchId: z.string().min(1).nullable()
})
export const ReviewDevSeedInputSchema = z.strictObject({
  scenes: z.number().int().min(1).max(4).optional(),
  beatsPerScene: z.number().int().min(1).max(8).optional()
})

export const ReviewActionResultSchema = z.strictObject({
  state: ReviewStateSchema,
  detail: z.string().nullable()
})
export type ReviewActionResult = z.infer<typeof ReviewActionResultSchema>

export const ReviewSendResultSchema = z.strictObject({
  state: ReviewStateSchema,
  reply: z.string(),
  toolCalls: z.number().int().nonnegative(),
  reportId: z.string().nullable(),
  patchIds: z.array(z.string())
})
export type ReviewSendResult = z.infer<typeof ReviewSendResultSchema>

/** 流式事件：审批长任务的进度；正文永远以 state 为准。 */
export const ReviewEventSchema = z.strictObject({
  projectId: z.string(),
  chapterId: z.string(),
  jobId: z.string(),
  phase: z.enum(['start', 'delta', 'done', 'failed']),
  delta: z.string().optional(),
  full: z.string().optional(),
  code: z.string().optional()
})
export type ReviewEvent = z.infer<typeof ReviewEventSchema>
