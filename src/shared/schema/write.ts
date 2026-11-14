import { z } from 'zod'
import { GroundingItemSchema } from './envelope'
import { DraftSceneSchema, StoryboardConflictSchema } from './storyboard'

/**
 * 创作台（PHASE-07）的 IPC 契约。
 *
 * 所有请求显式声明字段（strictObject），多余参数一律拒绝。
 * 状态里只放 UI 需要的东西：正文、拍状态、依据、出口判定、暂停原因、预算与预检。
 */

export const WRITE_BEAT_STATUSES = [
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
export const WriteBeatStatusSchema = z.enum(WRITE_BEAT_STATUSES)

/** 状态 → 文案（UI-DESIGN §5.4 的拍卡头部与状态栏共用）。 */
export const WRITE_STATUS_LABELS: Record<z.infer<typeof WriteBeatStatusSchema>, string> = {
  proposed: '待生成',
  generating: '生成中',
  draft: '草稿',
  waiting_for_human: '待确认',
  confirmed: '已确认',
  regenerating: '重生成中',
  rejected: '未通过',
  author_edited: '已手改',
  stale: '上游已改',
  superseded: '旧版',
  interrupted: '已中断'
}

export const WRITE_CHAPTER_STATUS_LABELS: Record<string, string> = {
  planned: '已规划',
  storyboard_ready: '已分镜',
  drafting: '进行中',
  draft_complete: '草稿完成',
  under_review: '待审批',
  revising: '修订中',
  approved: '已通过',
  finalized: '已定稿',
  paused: '已暂停',
  abandoned: '已放弃'
}

export const WriteBeatSchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  sceneId: z.string(),
  sceneOrd: z.number().int().positive(),
  speakerType: z.enum(['character', 'narrator']),
  speakerId: z.string(),
  speakerName: z.string(),
  intent: z.string(),
  body: z.string(),
  status: WriteBeatStatusSchema,
  grounding: z.array(GroundingItemSchema),
  traceRef: z.string().nullable(),
  wordCount: z.number().int().nonnegative(),
  maxWords: z.number().int().positive().nullable(),
  authorEdited: z.boolean(),
  /** 下游/自身需要作者处理（stale 或 未通过）。 */
  needsAttention: z.boolean(),
  updatedAt: z.string()
})
export type WriteBeatState = z.infer<typeof WriteBeatSchema>

export const WriteSceneSchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  location: z.string(),
  participants: z.array(z.string()),
  participantNames: z.array(z.string()),
  goal: z.string(),
  entry: z.string(),
  exitText: z.string(),
  exitValid: z.boolean(),
  exitReason: z.string().nullable(),
  exitSatisfied: z.boolean(),
  exitNodes: z.array(
    z.strictObject({
      op: z.string(),
      label: z.string(),
      satisfied: z.boolean(),
      detail: z.string().optional()
    })
  ),
  status: z.string(),
  maxBeats: z.number().int().positive(),
  totalBeats: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  beats: z.array(WriteBeatSchema)
})
export type WriteSceneState = z.infer<typeof WriteSceneSchema>

export const WriteG2Schema = z.strictObject({
  ready: z.boolean(),
  blocker: z.string().nullable(),
  sceneCount: z.number().int().nonnegative(),
  beatCount: z.number().int().nonnegative(),
  maxBeats: z.number().int().nonnegative(),
  storyboardRev: z.number().int().nullable(),
  conflicts: z.array(StoryboardConflictSchema)
})
export type WriteG2State = z.infer<typeof WriteG2Schema>

export const WriteStoryboardSchema = z.strictObject({
  exists: z.boolean(),
  rev: z.number().int().nullable(),
  updatedBy: z.enum(['author', 'orchestrator']).nullable(),
  updatedAt: z.string().nullable(),
  scenes: z.array(DraftSceneSchema),
  conflicts: z.array(StoryboardConflictSchema),
  /** 已经 G2 物化过的章：分镜 tab 只读（补分镜走「补分镜」入口）。 */
  materialized: z.boolean()
})
export type WriteStoryboardState = z.infer<typeof WriteStoryboardSchema>

export const WriteBudgetSchema = z.strictObject({
  limit: z.number().int().nonnegative(),
  spent: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  exceeded: z.boolean()
})

export const WritePreflightSchema = z.strictObject({
  ready: z.boolean(),
  blockers: z.array(z.string()),
  remainingBeats: z.number().int().nonnegative(),
  maxBeats: z.number().int().nonnegative(),
  estimatedTokensPerBeat: z.number().int().nonnegative(),
  estimatedTokens: z.strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  estimatedCostCny: z.strictObject({ min: z.number(), max: z.number() }),
  consecutiveBeats: z.number().int().nonnegative()
})
export type WritePreflightState = z.infer<typeof WritePreflightSchema>

export const WriteMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(['author', 'orchestrator', 'system']),
  kind: z.enum(['text', 'storyboard', 'pause', 'refusal']),
  body: z.string(),
  createdAt: z.string()
})
export type WriteMessageState = z.infer<typeof WriteMessageSchema>

export const WriteEventLogSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string()
})

export const WriteChapterSummarySchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  title: z.string(),
  status: z.string(),
  sceneCount: z.number().int().nonnegative(),
  beatCount: z.number().int().nonnegative(),
  confirmedCount: z.number().int().nonnegative()
})
export type WriteChapterSummary = z.infer<typeof WriteChapterSummarySchema>

export const WriteStateSchema = z.strictObject({
  projectId: z.string(),
  projectTitle: z.string(),
  chapterId: z.string(),
  chapterOrd: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterStatus: z.string(),
  readOnly: z.boolean(),
  setupState: z.string(),
  blueprintLocked: z.boolean(),
  mode: z.enum(['beat', 'auto']),
  revisionId: z.string().nullable(),
  contentHash: z.string().nullable(),
  chapters: z.array(WriteChapterSummarySchema),
  /** 角色 id → 名字（分镜编辑器与拍卡显示用）。 */
  characters: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  scenes: z.array(WriteSceneSchema),
  storyboard: WriteStoryboardSchema,
  g2: WriteG2Schema,
  progress: z.strictObject({
    totalBeats: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    scenesTotal: z.number().int().nonnegative(),
    scenesClosed: z.number().int().nonnegative()
  }),
  currentBeatId: z.string().nullable(),
  pauseReason: z.string().nullable(),
  pauseText: z.string().nullable(),
  running: z.boolean(),
  autoRunning: z.boolean(),
  autoPaused: z.boolean(),
  budget: WriteBudgetSchema,
  preflight: WritePreflightSchema.nullable(),
  messages: z.array(WriteMessageSchema),
  events: z.array(WriteEventLogSchema),
  model: z.strictObject({
    provider: z.string(),
    model: z.string(),
    label: z.string(),
    ready: z.boolean()
  })
})
export type WriteState = z.infer<typeof WriteStateSchema>

export const WriteModelStatusSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  label: z.string(),
  /** false = 没有可用 Key；生成会失败为 model_auth。 */
  ready: z.boolean()
})
export type WriteModelStatus = z.infer<typeof WriteModelStatusSchema>

export const WriteChapterInputSchema = z.strictObject({ chapterId: z.string().min(1) })
export const WriteStoryboardSaveInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  scenes: z.array(DraftSceneSchema).min(1).max(10)
})
export const WriteStoryboardValidateInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  scenes: z.array(DraftSceneSchema).min(0).max(10)
})
export const WriteG2InputSchema = z.strictObject({ chapterId: z.string().min(1) })
export const WriteBeatInputSchema = z.strictObject({ beatId: z.string().min(1) })
export const WriteEditInputSchema = z.strictObject({
  beatId: z.string().min(1),
  body: z.string().min(1).max(8000),
  expectedRevision: z.string().nullable()
})
export const WriteConfirmInputSchema = z.strictObject({
  beatId: z.string().min(1),
  expectedRevision: z.string().nullable().optional()
})
export const WriteSendInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  text: z.string().min(1).max(4000)
})
export const WriteDevSeedInputSchema = z.strictObject({
  scenes: z.number().int().min(1).max(10).optional(),
  beatsPerScene: z.number().int().min(1).max(20).optional(),
  exit: z.string().min(1).max(500).optional()
})

export const WriteStaleChoiceInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  beatId: z.string().min(1),
  /** 仅替换本拍 / 替换并重跑后续 / 开新分支（默认）。 */
  choice: z.enum(['replace', 'rerun', 'branch'])
})

export const WriteStoryboardResultSchema = z.strictObject({
  state: WriteStateSchema,
  conflicts: z.array(StoryboardConflictSchema)
})

export const WriteActionResultSchema = z.strictObject({
  state: WriteStateSchema,
  /** 本次动作的补充信息：拒演理由、暂停原因、闸门结果等。 */
  detail: z.string().nullable()
})
export type WriteActionResult = z.infer<typeof WriteActionResultSchema>

export const WriteSendResultSchema = z.strictObject({
  state: WriteStateSchema,
  reply: z.string(),
  toolCalls: z.number().int().nonnegative(),
  /** 编排在对话里提交了分镜（T34）→ UI 切到分镜 tab。 */
  storyboardUpdated: z.boolean()
})
export type WriteSendResult = z.infer<typeof WriteSendResultSchema>

/** 流式事件：只带当前拍增量；已确认拍不会收到 delta。 */
export const WriteEventSchema = z.strictObject({
  projectId: z.string(),
  chapterId: z.string(),
  jobId: z.string(),
  turnId: z.string(),
  beatId: z.string(),
  seq: z.number().int().nonnegative(),
  phase: z.enum(['start', 'delta', 'validated', 'committed', 'failed', 'paused', 'state', 'thought']),
  delta: z.string().optional(),
  full: z.string().optional(),
  code: z.string().optional(),
  reason: z.string().optional()
})
export type WriteEvent = z.infer<typeof WriteEventSchema>
