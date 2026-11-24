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
  /** 时间三轴（PHASE-12 M1-2）：idx 由章序派生，故事时间只展示不比较。 */
  timeline: z.enum(['main', 'flashback', 'dream']),
  storyStart: z.string().nullable(),
  storyEnd: z.string().nullable(),
  /** 引用场：拍属于别的章（只读）；非 null 时演出前必须 fork。 */
  referenceChapterOrd: z.number().int().nullable(),
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
  /** token 上限（`tokensLimit` 的兼容别名）。 */
  limit: z.number().int().nonnegative(),
  /** token 已用（`tokensUsed` 的兼容别名）。 */
  spent: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  exceeded: z.boolean(),
  /** 超限原因（PHASE-20 M2-3）：tokens / cost / both；未超限 null。 */
  reason: z.enum(['tokens', 'cost', 'both']).nullable(),
  tokensUsed: z.number().int().nonnegative(),
  tokensLimit: z.number().int().nonnegative(),
  costUsed: z.number().nonnegative(),
  costLimit: z.number().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  /** >0 时费用只是下限（没有计价的调用无法换算成钱）。 */
  unpricedCalls: z.number().int().nonnegative()
})
export type WriteBudgetState = z.infer<typeof WriteBudgetSchema>

export const WriteForecastRangeSchema = z.strictObject({
  low: z.number(),
  mid: z.number(),
  high: z.number()
})

export const WritePreflightSchema = z.strictObject({
  ready: z.boolean(),
  blockers: z.array(z.string()),
  remainingBeats: z.number().int().nonnegative(),
  maxBeats: z.number().int().nonnegative(),
  estimatedTokensPerBeat: z.number().int().nonnegative(),
  estimatedTokens: WriteForecastRangeSchema,
  /** 无计价时为 null：UI 只显示 token（PHASE-20 §5.2）。 */
  estimatedCostCny: WriteForecastRangeSchema.nullable(),
  forecastBasis: z.enum(['recent', 'default']),
  forecastSamples: z.number().int().nonnegative(),
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
  confirmedCount: z.number().int().nonnegative(),
  /** 章内正文合计字数（不含 superseded），列表不发正文（PHASE-11 M1-9）。 */
  wordCount: z.number().int().nonnegative(),
  /** 蓝图变更标脏（PHASE-15）：非空时 G2 前提示「待重审」，可忽略。 */
  invalidatedAt: z.string().nullable()
})
export type WriteChapterSummary = z.infer<typeof WriteChapterSummarySchema>

/** 场景库一行（PHASE-12 M1-1）：项目级场景 + 链接与演出归属。 */
export const WriteSceneLibraryItemSchema = z.strictObject({
  id: z.string(),
  ord: z.number().int(),
  location: z.string(),
  goal: z.string(),
  status: z.string(),
  timeline: z.enum(['main', 'flashback', 'dream']),
  storyStart: z.string().nullable(),
  storyEnd: z.string().nullable(),
  /** 场景 live 拍数（= 已演出）。 */
  liveBeats: z.number().int().nonnegative(),
  /** 演出章序；未演出 null。 */
  ownerChapterOrd: z.number().int().nullable(),
  /** 链接到的章序（升序）。 */
  linkedChapterOrds: z.array(z.number().int()),
  linkedToCurrent: z.boolean(),
  ownedByCurrent: z.boolean()
})
export type WriteSceneLibraryItem = z.infer<typeof WriteSceneLibraryItemSchema>

/** 时间三轴视图（T23 的只读投影，供创作台与 E2E 使用）。 */
export const WriteTimelineSchema = z.strictObject({
  chapterId: z.string(),
  /** 叙事顺序 = chapter.ord（全书统一编号）。 */
  idx: z.number().int(),
  /** 章内第一个 main 场景的故事时间范围；没有 main 场景时为 null。 */
  storyStart: z.string().nullable(),
  storyEnd: z.string().nullable(),
  scenes: z.array(
    z.strictObject({
      sceneId: z.string(),
      ord: z.number().int(),
      timeline: z.enum(['main', 'flashback', 'dream']),
      storyStart: z.string().nullable(),
      storyEnd: z.string().nullable()
    })
  ),
  /** 按 beat.seq 排序：故事时间取所属场景的 story_start，另带该场景时间轴。 */
  timeline: z.array(
    z.strictObject({
      seq: z.number().int(),
      storyTime: z.string().nullable(),
      timeline: z.enum(['main', 'flashback', 'dream'])
    })
  )
})
export type WriteTimeline = z.infer<typeof WriteTimelineSchema>

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
  /** 项目级场景库（PHASE-12 M1-1）：链接、fork 与时间轴编辑的数据源。 */
  library: z.array(WriteSceneLibraryItemSchema),
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

/**
 * 上下文检查器（PHASE-13 M1-17 / UI-DESIGN §5.4）。
 *
 * 数据源是 `turn_metric.context_json`：拍生成时写进去的块清单、裁剪与 prefix hash。
 * 这里**只读**，不提供「改预算」按钮（预算在设置页）；也不回传被裁掉的正文。
 */
export const WriteContextBlockSchema = z.strictObject({
  id: z.string(),
  layer: z.enum(['L0', 'L1', 'L2', 'L3']),
  stable: z.boolean(),
  priority: z.number(),
  tokens: z.number().int().nonnegative(),
  role: z.string(),
  order: z.number().int().nullable(),
  refType: z.string().nullable(),
  /** 该块在裁剪清单里。 */
  trimmed: z.boolean()
})
export type WriteContextBlock = z.infer<typeof WriteContextBlockSchema>

export const WriteContextInspectionSchema = z.strictObject({
  beatId: z.string(),
  chapterId: z.string(),
  /** false = 这一拍还没生成过（没有 turn_metric 行）。 */
  found: z.boolean(),
  turnId: z.string().nullable(),
  agentKey: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** 这一轮实际使用的 as_of 水位（来自 context_json，不是重新推算的）。 */
  asOf: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative(),
  blocks: z.array(WriteContextBlockSchema),
  trimmed: z.array(z.string()),
  degraded: z.array(z.string()),
  prefixHash: z.string().nullable(),
  usage: z.strictObject({
    tokensIn: z.number().int().nonnegative().nullable(),
    tokensOut: z.number().int().nonnegative().nullable(),
    /**
     * 供应商报告的缓存命中 token（PHASE-22）：null = 未报告，
     * UI 显示「未报告」而不是 0%。不因缓存命中跳过 grounding。
     */
    cachedTokens: z.number().int().nonnegative().nullable(),
    costCny: z.number(),
    latencyMs: z.number().int().nonnegative().nullable(),
    firstTokenMs: z.number().int().nonnegative().nullable()
  }),
  /** 稳定前缀与缓存（PHASE-22 §5.6）：`hitRate = cached / tokensIn`。 */
  cache: z.strictObject({
    stableTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    hitRate: z.number().min(0).max(1).nullable()
  }),
  /** 估算 vs 上次实际 prompt tokens：不显示假精确值（DEV-PLAN §7.4）。 */
  estimate: z.strictObject({
    totalTokens: z.number().int().nonnegative(),
    actualPromptTokens: z.number().int().nonnegative().nullable(),
    ratio: z.number().nullable()
  }),
  budget: WriteBudgetSchema,
  pauseReason: z.string().nullable()
})
export type WriteContextInspection = z.infer<typeof WriteContextInspectionSchema>

export const WriteContextInputSchema = z.strictObject({ beatId: z.string().min(1) })

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

/** 场景库（PHASE-12 M1-1）：链接/解链/排序/fork/删除/时间三轴。 */
export const WriteSceneLinkInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  sceneId: z.string().min(1)
})
export const WriteSceneReorderInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  sceneIds: z.array(z.string().min(1)).min(1).max(20)
})
export const WriteSceneTimeInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  sceneId: z.string().min(1),
  /** 省略 = 不改；null = 清空。 */
  storyStart: z.string().max(80).nullable().optional(),
  storyEnd: z.string().max(80).nullable().optional(),
  timeline: z.enum(['main', 'flashback', 'dream']).optional()
})
export const WriteTimelineInputSchema = z.strictObject({ chapterId: z.string().min(1) })
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
  /** 只给性能/文件树 E2E 用：一次铺 N 章（默认只有第一章带分镜）。 */
  chapters: z.number().int().min(1).max(40).optional(),
  /** 每章都带同一套分镜草案（PHASE-12 的多章时间线 E2E 用）。 */
  seedEveryChapter: z.boolean().optional(),
  /** 角色数（1–5，默认 1）；M1 长跑用 2，避免关系边退化成自环。 */
  characters: z.number().int().min(1).max(5).optional(),
  /** 卷数（1–3）与每卷章数（1–10）；M1 长跑 3 × 10。 */
  volumes: z.number().int().min(1).max(3).optional(),
  chaptersPerVolume: z.number().int().min(1).max(10).optional(),
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
