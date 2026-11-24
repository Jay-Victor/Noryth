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

/** 归档原因（0014 / PHASE-22）：候选原因与落库原因都映射成中文。 */
export const MEMORY_ARCHIVE_REASON_LABELS: Record<string, string> = {
  duplicate_experience: '重复经历',
  redundant: '重复经历（软归档）'
}

/** 归档候选不可执行的原因（执行时 skipped 的人话说明）。 */
export const MEMORY_ARCHIVE_BLOCK_LABELS: Record<string, string> = {
  missing: '条目已不存在',
  not_experience: '不是经历类记忆',
  already_archived: '已经归档',
  not_active: '条目已失效',
  pinned: '条目已 pin',
  important: '重要度高于归档门槛',
  referenced: '被有效事实或关系引用',
  pending_proposal: '仍有待决策提案',
  no_keeper: '没有可保留的相似条目'
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
  /** 软归档（PHASE-22）：非空 = 不参与检索，但仍在浏览器里可见、可恢复。 */
  archivedAt: z.string().nullable(),
  archiveReason: z.string().nullable(),
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
  action: z.enum(['extract', 'apply', 'invalidate', 'rebuild', 'supersede', 'evidence_mismatch', 'archive', 'restore']),
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

/**
 * 工具调用审计（PHASE-18 M1-23 / PRD §4.9.7 / UI-DESIGN §7.4 审计）。
 *
 * 只读：tool、版本、actor、耗时、degraded、错误码、归属章。
 * **不返回 args**——审计表只存 `args_hash`；面板也不提供「重放工具」。
 */
export const ToolCallStateSchema = z.strictObject({
  id: z.string(),
  tool: z.string(),
  toolVersion: z.string(),
  actorId: z.string(),
  /** actor 的人话标签（planner → 规划；character:x → 角色名）。 */
  actorLabel: z.string(),
  jobId: z.string(),
  chapterId: z.string().nullable(),
  chapterTitle: z.string().nullable(),
  status: z.enum(['ok', 'error']),
  errorCode: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  degraded: z.string(),
  createdAt: z.string()
})
export type ToolCallState = z.infer<typeof ToolCallStateSchema>

export const ToolCallListInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  status: z.enum(['ok', 'error']).optional(),
  /** 1 起；每页 50（主进程固定页大小）。 */
  page: z.number().int().min(1).max(1000).optional()
})
export type ToolCallListInput = z.infer<typeof ToolCallListInputSchema>

export const ToolCallListStateSchema = z.strictObject({
  projectId: z.string(),
  readOnly: z.boolean(),
  items: z.array(ToolCallStateSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  /** 过滤下拉的可选项（只含本项目出现过的章与 actor，避免下拉里堆空项）。 */
  chapters: z.array(z.strictObject({ id: z.string(), ord: z.number().int(), title: z.string() })),
  actors: z.array(z.strictObject({ id: z.string(), label: z.string() }))
})
export type ToolCallListState = z.infer<typeof ToolCallListStateSchema>

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

/** 按章重建（PHASE-14 M1-4）：作者点按钮 → author_confirm → 整章重建。 */
export const MemoryRebuildStateSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  chapterId: z.string().nullable(),
  revisionId: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  factCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  jobId: z.string().nullable(),
  jobStatus: z.enum(['queued', 'running', 'applied', 'failed', 'cancelled']).nullable(),
  /** 失败原因（PHASE-16：自动重建失败时 UI 能解释，不只显示「失败」）。 */
  errorCode: z.string().nullable(),
  inactiveCount: z.number().int().nonnegative(),
  rebuiltCount: z.number().int().nonnegative()
})
export type MemoryRebuildState = z.infer<typeof MemoryRebuildStateSchema>

export const MemoryRebuildPreviewSchema = z.strictObject({
  chapterId: z.string(),
  revisionId: z.string(),
  entryCount: z.number().int().nonnegative(),
  factCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  blockers: z.array(z.string())
})
export type MemoryRebuildPreview = z.infer<typeof MemoryRebuildPreviewSchema>

export const MemoryRebuildIssueResultSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.string(),
  preview: MemoryRebuildPreviewSchema
})
export type MemoryRebuildIssueResult = z.infer<typeof MemoryRebuildIssueResultSchema>

/** 索引重建（PHASE-14 M1-20）：向量通道按模型过滤，换模型后分批重算子集。 */
export const IndexRebuildStateSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  targetModel: z.string(),
  dim: z.number().int(),
  degraded: z.boolean(),
  /** `embedding_model != targetModel` 的 active 条目数。 */
  pendingCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  jobId: z.string().nullable(),
  jobStatus: z.enum(['queued', 'running', 'applied', 'failed', 'cancelled']).nullable(),
  rebuiltCount: z.number().int().nonnegative()
})
export type IndexRebuildState = z.infer<typeof IndexRebuildStateSchema>

export const IndexRebuildIssueResultSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.string(),
  preview: z.strictObject({
    targetModel: z.string(),
    pendingCount: z.number().int().nonnegative()
  })
})
export type IndexRebuildIssueResult = z.infer<typeof IndexRebuildIssueResultSchema>

/**
 * 归档（PHASE-22 M2-7）：只碰非事实类经历。
 *
 * 候选是主进程算好的确定性结果（keeper、相似度、原因），renderer 只勾选；
 * 执行要 `author_confirm` 一次性令牌（`memory.archive.issue` → `memory.archive.apply`），
 * 恢复不需要令牌但需要确认对话框。
 */
export const MemoryArchiveCandidateSchema = z.strictObject({
  id: z.string(),
  characterId: z.string(),
  characterName: z.string(),
  text: z.string(),
  importance: z.number(),
  learnedSeq: z.number().int(),
  keeperId: z.string(),
  keeperText: z.string(),
  similarity: z.number(),
  reason: z.enum(['duplicate_experience'])
})
export type MemoryArchiveCandidate = z.infer<typeof MemoryArchiveCandidateSchema>

export const MemoryArchiveCandidatesStateSchema = z.strictObject({
  projectId: z.string(),
  readOnly: z.boolean(),
  items: z.array(MemoryArchiveCandidateSchema),
  /** 与记忆台计数同口径：四个互斥值。 */
  counts: z.strictObject({
    active: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    inactive: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative()
  }),
  /** 每批最多 50 条（主进程固定）。 */
  batchLimit: z.number().int().positive(),
  /** 候选的判定门槛（UI 直接显示，不在 renderer 重复硬编码）。 */
  threshold: z.strictObject({
    importanceMax: z.number(),
    similarityMin: z.number()
  })
})
export type MemoryArchiveCandidatesState = z.infer<typeof MemoryArchiveCandidatesStateSchema>

export const MemoryArchiveIssueInputSchema = z.strictObject({
  ids: z.array(z.string().min(1)).min(1).max(50)
})
export type MemoryArchiveIssueInput = z.infer<typeof MemoryArchiveIssueInputSchema>

export const MemoryArchiveIssueResultSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.string(),
  preview: z.strictObject({
    batchId: z.string(),
    count: z.number().int().positive(),
    items: z.array(MemoryArchiveCandidateSchema)
  })
})
export type MemoryArchiveIssueResult = z.infer<typeof MemoryArchiveIssueResultSchema>

export const MemoryArchiveApplyInputSchema = z.strictObject({
  ids: z.array(z.string().min(1)).min(1).max(50),
  token: z.string().min(1)
})
export type MemoryArchiveApplyInput = z.infer<typeof MemoryArchiveApplyInputSchema>

export const MemoryArchiveRestoreInputSchema = z.strictObject({ entryId: z.string().min(1) })
export type MemoryArchiveRestoreInput = z.infer<typeof MemoryArchiveRestoreInputSchema>

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
  /** 记忆计数（PHASE-22 §5.3）：active / archived / inactive / superseded 互斥。 */
  counts: z.strictObject({
    active: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    inactive: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative()
  }),
  /** 按章重建（PHASE-14 M1-4）。 */
  rebuild: MemoryRebuildStateSchema,
  /** 索引重建（PHASE-14 M1-20）：换模型后的向量重算。 */
  index: IndexRebuildStateSchema,
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
    vectorCount: z.number().int().nonnegative(),
    /** `embedding_model != 当前模型` 的 active 条目数（>0 显示「索引待重建」）。 */
    pendingCount: z.number().int().nonnegative()
  })
})
export type MemoryState = z.infer<typeof MemoryStateSchema>

export const MemoryArchiveApplyResultSchema = z.strictObject({
  state: MemoryStateSchema,
  detail: z.string().nullable(),
  archived: z.array(z.string()),
  /** 签发令牌后失效的候选：是校验结果，不是半写。 */
  skipped: z.array(z.strictObject({ id: z.string(), reason: z.string() }))
})
export type MemoryArchiveApplyResult = z.infer<typeof MemoryArchiveApplyResultSchema>

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
/** 按章重建（PHASE-14 M1-4）：author_confirm 一次性令牌（10 分钟）。 */
export const MemoryRebuildInputSchema = z.strictObject({
  chapterId: z.string().min(1),
  token: z.string().min(1)
})
/** 索引重建（PHASE-14 M1-20）：author_confirm 一次性令牌（10 分钟）。 */
export const IndexRebuildInputSchema = z.strictObject({
  token: z.string().min(1)
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

/**
 * 世界状态 as-of 投影（PHASE-13 M1-3 / M1-18）。
 *
 * 与 `MemoryState` 分开走一条 IPC：世界状态可以按任意 as_of 回放，
 * 而记忆台的状态是「当前章 + 当前提案」的快照。合并会让两边的语义互相污染。
 */
export const WorldFactViewSchema = z.strictObject({
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
  sourceId: z.string().nullable(),
  /** 读者在 as_of 已经看到这条事实（只影响旁白/读者视图）。 */
  readerKnown: z.boolean(),
  /** 公开但尚未揭示：读者不知道，不代表事实不存在。 */
  pendingReveal: z.boolean()
})
export type WorldFactView = z.infer<typeof WorldFactViewSchema>

export const WorldBeliefViewSchema = z.strictObject({
  id: z.string(),
  characterId: z.string(),
  factId: z.string().nullable(),
  beliefText: z.string(),
  confidence: z.number(),
  learnedSeq: z.number().int(),
  sourceType: z.string(),
  status: z.string()
})
export type WorldBeliefView = z.infer<typeof WorldBeliefViewSchema>

export const WorldEdgeViewSchema = z.strictObject({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  axis: z.enum(['trust', 'intimacy', 'tension']),
  value: z.number(),
  sinceSeq: z.number().int(),
  validToSeq: z.number().int().nullable(),
  sourceType: z.string(),
  /** 来源（记忆条目 / 拍）；关系图「点边看来源」用它回到章与拍。 */
  sourceId: z.string().nullable()
})
export type WorldEdgeView = z.infer<typeof WorldEdgeViewSchema>

export const WorldProjectionCountsSchema = z.strictObject({
  facts: z.number().int().nonnegative(),
  objective: z.number().int().nonnegative(),
  claim: z.number().int().nonnegative(),
  beliefs: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  /** as_of 之后才产生的事实：不算「隐藏」，是「还不存在」。 */
  futureFacts: z.number().int().nonnegative(),
  /** 已存在但读者还没看到。 */
  notYetRevealed: z.number().int().nonnegative(),
  readerKnown: z.number().int().nonnegative()
})
export type WorldProjectionCounts = z.infer<typeof WorldProjectionCountsSchema>

export const WorldProjectionStateSchema = z.strictObject({
  projectId: z.string(),
  seqHead: z.number().int().nonnegative(),
  chapterId: z.string().nullable(),
  chapterOrd: z.number().int().positive().nullable(),
  /** 本章认知快照（covered_until_seq）；null = 没有选章。 */
  coverage: z.number().int().nonnegative().nullable(),
  readOnly: z.boolean(),
  characters: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  asOf: z.number().int().nonnegative(),
  facts: z.array(WorldFactViewSchema),
  beliefs: z.array(WorldBeliefViewSchema),
  edges: z.array(WorldEdgeViewSchema),
  counts: WorldProjectionCountsSchema
})
export type WorldProjectionState = z.infer<typeof WorldProjectionStateSchema>

export const WorldProjectionInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  asOf: z.number().int().min(0).optional()
})
export type WorldProjectionInput = z.infer<typeof WorldProjectionInputSchema>

export const WorldFactAddSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  asOf: z.number().int().min(0).optional(),
  subject: z.string().min(1).max(60),
  predicate: z.string().min(1).max(40),
  object: z.string().min(1).max(200),
  truth: z.enum(['objective', 'claim']),
  visibility: z.enum(['public', 'secret']),
  knownBy: z.array(z.string().min(1)).max(24).optional(),
  revealSeq: z.number().int().min(0).nullable().optional(),
  /** 省略 = 当前叙事序。单值槽不接受早于当前值的生效序（主进程校验）。 */
  validFromSeq: z.number().int().min(0).optional()
})
export type WorldFactAddInput = z.infer<typeof WorldFactAddSchema>

export const WorldFactCloseSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  asOf: z.number().int().min(0).optional(),
  factId: z.string().min(1),
  reason: z.string().min(2).max(200).optional()
})
export type WorldFactCloseInput = z.infer<typeof WorldFactCloseSchema>

export const WorldFactActionResultSchema = z.strictObject({
  projection: WorldProjectionStateSchema,
  factId: z.string(),
  detail: z.string().nullable()
})
export type WorldFactActionResult = z.infer<typeof WorldFactActionResultSchema>

/**
 * 关系图（PHASE-14 M1-5 / UI-DESIGN §7.4）。
 *
 * 只读：节点 = active 角色，边 = as-of 投影后的 `relationship_edge`；布局在主进程算好
 * （确定性圆环，同数据同坐标），renderer 只画 SVG。**不含任何私有记忆文本。**
 */
export const RelationNodeSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** 圆环布局坐标（viewBox 640×360，容差 1px）。 */
  x: z.number(),
  y: z.number()
})
export type RelationNode = z.infer<typeof RelationNodeSchema>

export const RelationGraphEdgeSchema = z.strictObject({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  axis: z.enum(['trust', 'intimacy', 'tension']),
  value: z.number(),
  sinceSeq: z.number().int(),
  validToSeq: z.number().int().nullable(),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  /** 来源的人话标签（章标题 · 记忆 / 拍）；不包含记忆正文。 */
  sourceLabel: z.string(),
  /** 没有反向边（同轴）= 单向未确认：UI 画虚线。 */
  bidirectional: z.boolean()
})
export type RelationGraphEdge = z.infer<typeof RelationGraphEdgeSchema>

export const RelationGraphSchema = z.strictObject({
  projectId: z.string(),
  seqHead: z.number().int().nonnegative(),
  chapterId: z.string().nullable(),
  chapterOrd: z.number().int().positive().nullable(),
  coverage: z.number().int().nonnegative().nullable(),
  readOnly: z.boolean(),
  asOf: z.number().int().nonnegative(),
  nodes: z.array(RelationNodeSchema),
  edges: z.array(RelationGraphEdgeSchema),
  counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    byAxis: z.strictObject({
      trust: z.number().int().nonnegative(),
      intimacy: z.number().int().nonnegative(),
      tension: z.number().int().nonnegative()
    }),
    oneWay: z.number().int().nonnegative()
  })
})
export type RelationGraph = z.infer<typeof RelationGraphSchema>

export const RelationGraphInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  asOf: z.number().int().min(0).optional(),
  /** 聚焦某角色邻域（角色多时用）；省略 = 全量节点。 */
  focusId: z.string().min(1).optional()
})
export type RelationGraphInput = z.infer<typeof RelationGraphInputSchema>

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
