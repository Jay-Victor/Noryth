import { z } from 'zod'

/**
 * 记忆台（PHASE-09 H1–H5）的 IPC 契约。
 *
 * 与创作台/审批台同构：状态里只放 UI 需要的东西；所有请求 strictObject。
 * 三个动作必须分开，因为失败语义不同：
 *   extract  只写 job + 提案（不写记忆库）
 *   decide   只写 decision/edited_text（不改长期状态）
 *   apply    唯一写记忆/世界状态的入口（需要 G7 令牌）
 */

export const MEMORY_KINDS = ['experience', 'fact', 'relationship', 'cognition'] as const
export type MemoryKindValue = (typeof MEMORY_KINDS)[number]

export const PROPOSAL_KINDS = [...MEMORY_KINDS, 'world_fact', 'belief'] as const
export type ProposalKindValue = (typeof PROPOSAL_KINDS)[number]

export const MEMORY_KIND_LABELS: Record<string, string> = {
  experience: '经历',
  fact: '事实',
  relationship: '关系',
  cognition: '认知',
  belief: '信念',
  world_fact: '世界事实'
}

export const MEMORY_STATUS_LABELS: Record<string, string> = {
  active: '生效',
  inactive: '已失效',
  superseded: '被取代'
}

/** 服务端改写原因（提案上的「已降级」文案）。 */
export const MEMORY_DOWNGRADE_LABELS: Record<string, string> = {
  dialogue_objective_to_claim: '台词证据：客观事实已降级为「声称」',
  relationship_payload_to_experience: '关系提案缺目标/轴/值：按经历记录',
  missing_character: '缺角色身份：已丢弃',
  world_fact_payload: '缺事实三元组：已丢弃',
  relationship_payload: '关系字段不完整',
  empty_text: '空条目',
  evidence_mismatch: '证据不是原文子串：已丢弃',
  missing_beat: '缺来源拍：已丢弃',
  missing_quote: '缺证据原文：已丢弃',
  beat_not_in_revision: '来源拍不在定稿清单：已丢弃',
  quote_not_substring: '证据不是原文子串：已丢弃',
  duplicate: '重复条目：已丢弃',
  unknown_character: '角色不在本项目：已丢弃'
}

export const MEMORY_JOB_LABELS: Record<string, string> = {
  queued: '待抽取',
  running: '抽取中',
  proposed: '待审阅',
  applied: '已固化',
  failed: '失败',
  cancelled: '已取消'
}

export const MemoryEvidenceSchema = z.strictObject({
  beatId: z.string(),
  quote: z.string()
})
export type MemoryEvidenceState = z.infer<typeof MemoryEvidenceSchema>

export const MemoryProposalStateSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(PROPOSAL_KINDS),
  characterId: z.string().nullable(),
  characterName: z.string().nullable(),
  text: z.string(),
  editedText: z.string().nullable(),
  decision: z.enum(['pending', 'accept', 'edit', 'reject']),
  evidence: MemoryEvidenceSchema,
  sourceChapterId: z.string(),
  sourceRevisionId: z.string(),
  sourceBeatId: z.string().nullable(),
  importance: z.number(),
  pinned: z.boolean(),
  /** 服务端改写（台词 objective → claim、关系字段缺失 → 经历）。 */
  downgrades: z.array(z.string()),
  truth: z.enum(['objective', 'claim']).nullable(),
  payload: z.record(z.string(), z.unknown())
})
export type MemoryProposalState = z.infer<typeof MemoryProposalStateSchema>

export const MemoryEntryStateSchema = z.strictObject({
  id: z.string(),
  characterId: z.string(),
  characterName: z.string(),
  kind: z.enum(MEMORY_KINDS),
  text: z.string(),
  learnedSeq: z.number().int(),
  sourceChapterId: z.string(),
  sourceChapterTitle: z.string(),
  sourceBeatId: z.string().nullable(),
  sourceRevisionId: z.string(),
  importance: z.number(),
  pinned: z.boolean(),
  validFromSeq: z.number().int().nullable(),
  validToSeq: z.number().int().nullable(),
  status: z.enum(['active', 'inactive', 'superseded']),
  embeddingModel: z.string(),
  createdAt: z.string()
})
export type MemoryEntryState = z.infer<typeof MemoryEntryStateSchema>

export const WorldFactStateSchema = z.strictObject({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  truth: z.enum(['objective', 'claim']),
  visibility: z.enum(['public', 'secret']),
  knownBy: z.array(z.string()),
  revealSeq: z.number().int().nullable(),
  validFromSeq: z.number().int(),
  validToSeq: z.number().int().nullable(),
  sourceType: z.string(),
  sourceId: z.string().nullable()
})
export type WorldFactState = z.infer<typeof WorldFactStateSchema>

export const BeliefStateSchema = z.strictObject({
  id: z.string(),
  characterId: z.string(),
  characterName: z.string(),
  beliefText: z.string(),
  confidence: z.number(),
  learnedSeq: z.number().int(),
  sourceType: z.string(),
  status: z.enum(['active', 'inactive', 'superseded'])
})
export type BeliefState = z.infer<typeof BeliefStateSchema>

export const RelationshipStateSchema = z.strictObject({
  id: z.string(),
  fromId: z.string(),
  fromName: z.string(),
  toId: z.string(),
  toName: z.string(),
  axis: z.enum(['trust', 'intimacy', 'tension']),
  value: z.number(),
  sinceSeq: z.number().int(),
  validToSeq: z.number().int().nullable()
})
export type RelationshipState = z.infer<typeof RelationshipStateSchema>

export const MemoryAuditStateSchema = z.strictObject({
  id: z.string(),
  action: z.enum(['extract', 'apply', 'invalidate', 'rebuild', 'supersede', 'evidence_mismatch']),
  actor: z.string(),
  entityType: z.enum(['memory_entry', 'world_fact', 'belief', 'relationship', 'proposal']),
  entityId: z.string(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string()
})
export type MemoryAuditState = z.infer<typeof MemoryAuditStateSchema>

export const MemoryMessageStateSchema = z.strictObject({
  id: z.string(),
  role: z.enum(['author', 'memory', 'system']),
  kind: z.enum(['text', 'proposal', 'apply', 'pause']),
  body: z.string(),
  createdAt: z.string()
})
export type MemoryMessageState = z.infer<typeof MemoryMessageStateSchema>

export const MemoryJobSummarySchema = z.strictObject({
  id: z.string(),
  chapterId: z.string().nullable(),
  chapterOrd: z.number().int().nonnegative(),
  chapterTitle: z.string(),
  revisionId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'proposed', 'applied', 'failed', 'cancelled']),
  itemCount: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  mismatches: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: z.string()
})
export type MemoryJobSummary = z.infer<typeof MemoryJobSummarySchema>

export const MemoryChapterSummarySchema = z.strictObject({
  id: z.string(),
  ord: z.number().int().positive(),
  title: z.string(),
  status: z.string(),
  finalRevisionId: z.string().nullable(),
  jobId: z.string().nullable(),
  jobStatus: z.enum(['queued', 'running', 'proposed', 'applied', 'failed', 'cancelled']).nullable(),
  itemCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative()
})
export type MemoryChapterSummary = z.infer<typeof MemoryChapterSummarySchema>

export const MemoryRecallItemSchema = z.strictObject({
  memoryId: z.string(),
  text: z.string(),
  kind: z.enum(MEMORY_KINDS),
  score: z.number(),
  channel: z.enum(['vector', 'keyword', 'both', 'pinned']),
  cosine: z.number().nullable()
})
export type MemoryRecallItem = z.infer<typeof MemoryRecallItemSchema>

export const MemoryRecallResultSchema = z.strictObject({
  characterId: z.string(),
  query: z.string(),
  asOf: z.number().int(),
  items: z.array(MemoryRecallItemSchema),
  pinned: z.array(MemoryRecallItemSchema),
  empty: z.boolean(),
  degraded: z.string(),
  model: z.string()
})
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>

export const MemoryGateSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  acceptedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative()
})
export type MemoryGateState = z.infer<typeof MemoryGateSchema>

export const MemoryStateSchema = z.strictObject({
  projectId: z.string(),
  projectTitle: z.string(),
  readOnly: z.boolean(),
  /** 当前预览的章；null = 还没有定稿章节。 */
  chapterId: z.string().nullable(),
  chapterOrd: z.number().int().nonnegative(),
  chapterTitle: z.string(),
  chapterStatus: z.string(),
  revisionId: z.string().nullable(),
  chapters: z.array(MemoryChapterSummarySchema),
  jobs: z.array(MemoryJobSummarySchema),
  jobId: z.string().nullable(),
  jobStatus: z.enum(['queued', 'running', 'proposed', 'applied', 'failed', 'cancelled']).nullable(),
  proposals: z.array(MemoryProposalStateSchema),
  entries: z.array(MemoryEntryStateSchema),
  worldFacts: z.array(WorldFactStateSchema),
  beliefs: z.array(BeliefStateSchema),
  relationships: z.array(RelationshipStateSchema),
  audit: z.array(MemoryAuditStateSchema),
  messages: z.array(MemoryMessageStateSchema),
  g7: MemoryGateSchema,
  running: z.boolean(),
  hasProposals: z.boolean(),
  model: z.strictObject({
    provider: z.string(),
    model: z.string(),
    label: z.string(),
    ready: z.boolean()
  }),
  embedding: z.strictObject({
    model: z.string(),
    dim: z.number().int(),
    degraded: z.boolean(),
    vectorCount: z.number().int().nonnegative()
  })
})
export type MemoryState = z.infer<typeof MemoryStateSchema>

/** 请求体。 */
export const MemoryChapterInputSchema = z.strictObject({ chapterId: z.string().min(1) })
export const MemoryStateInputSchema = z.strictObject({ chapterId: z.string().min(1).optional() })
export const MemoryDecideInputSchema = z.strictObject({
  itemId: z.string().min(1),
  decision: z.enum(['accept', 'edit', 'reject']),
  editedText: z.string().min(1).max(1000).optional()
})
export const MemoryDecideManyInputSchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        itemId: z.string().min(1),
        decision: z.enum(['accept', 'edit', 'reject']),
        editedText: z.string().min(1).max(1000).optional()
      })
    )
    .min(1)
    .max(80)
})
export const MemoryApplyInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  /** G7 一次性令牌（10 分钟）；只持有在 store 里，不构造 payload。 */
  token: z.string().min(1)
})
export const MemoryInvalidateInputSchema = z.strictObject({
  entryId: z.string().min(1),
  reason: z.string().min(2).max(200)
})
export const MemoryRecallInputSchema = z.strictObject({
  characterId: z.string().min(1),
  query: z.string().min(1).max(200),
  asOf: z.number().int().min(0).optional(),
  topK: z.number().int().min(1).max(8).optional()
})
export const MemorySendInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  text: z.string().min(1).max(4000)
})
export const MemoryDevSeedInputSchema = z.strictObject({
  scenes: z.number().int().min(1).max(3).optional(),
  beatsPerScene: z.number().int().min(2).max(8).optional(),
  /** 造第二、三章（第 2 章用于「跨章召回」验收）。 */
  extraChapters: z.number().int().min(0).max(3).optional()
})

export const MemoryActionResultSchema = z.strictObject({
  state: MemoryStateSchema,
  detail: z.string().nullable()
})
export type MemoryActionResult = z.infer<typeof MemoryActionResultSchema>

export const MemorySendResultSchema = z.strictObject({
  state: MemoryStateSchema,
  reply: z.string(),
  toolCalls: z.number().int().nonnegative()
})
export type MemorySendResult = z.infer<typeof MemorySendResultSchema>

export const MemoryApplyPreviewSchema = z.strictObject({
  chapterId: z.string().nullable(),
  jobId: z.string(),
  acceptedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  blockers: z.array(z.string())
})
export type MemoryApplyPreview = z.infer<typeof MemoryApplyPreviewSchema>

export const MemoryIssueResultSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.string(),
  preview: MemoryApplyPreviewSchema
})
export type MemoryIssueResult = z.infer<typeof MemoryIssueResultSchema>

/** 流式事件：抽取长任务的进度；提案以 state 为准。 */
export const MemoryEventSchema = z.strictObject({
  projectId: z.string(),
  chapterId: z.string(),
  jobId: z.string(),
  phase: z.enum(['start', 'delta', 'done', 'failed']),
  delta: z.string().optional(),
  full: z.string().optional(),
  code: z.string().optional()
})
export type MemoryEvent = z.infer<typeof MemoryEventSchema>
