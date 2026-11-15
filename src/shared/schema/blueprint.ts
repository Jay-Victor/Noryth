import { z } from 'zod'

/**
 * 覆盖检查 / 影响分析 / 蓝图变更契约（PHASE-15 M1-8 / M1-11）。
 *
 * 边界：
 * - 覆盖检查只做确定性规则，不调模型；阻断项才禁 G1，建议项只计数。
 * - 影响分析只读；变更必须「先分析、再应用」，未分析一律拒绝。
 * - 应用变更不改正文、不改章状态，只把受影响章标 `invalidated_at`。
 */

/** outline_node.meta_json 的唯一形状：未知字段丢弃，不写库（PHASE-15 §5.1）。 */
export const BlueprintKeyEventSchema = z.strictObject({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(300),
  chapter_node_id: z.string().min(1).optional()
})
export type BlueprintKeyEvent = z.infer<typeof BlueprintKeyEventSchema>

export const BlueprintMetaSchema = z.strictObject({
  key_events: z.array(BlueprintKeyEventSchema).max(50).optional(),
  character_ids: z.array(z.string().min(1)).max(50).optional(),
  pov_character_id: z.string().min(1).optional(),
  mainline: z.boolean().optional()
})
export type BlueprintMeta = z.infer<typeof BlueprintMetaSchema>

/** 宽松解析：只保留已知字段；返回值一定符合 BlueprintMetaSchema。 */
export function parseBlueprintMeta(json: string | null | undefined): BlueprintMeta {
  if (!json || json.trim().length === 0) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const meta: BlueprintMeta = {}
  if (Array.isArray(record.key_events)) {
    const events: BlueprintKeyEvent[] = []
    for (const item of record.key_events) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id.slice(0, 40) : ''
      const text = typeof entry.text === 'string' ? entry.text.slice(0, 300) : ''
      if (id.length === 0 || text.length === 0) continue
      const event: BlueprintKeyEvent = { id, text }
      if (typeof entry.chapter_node_id === 'string' && entry.chapter_node_id.length > 0) {
        event.chapter_node_id = entry.chapter_node_id
      }
      events.push(event)
      if (events.length >= 50) break
    }
    meta.key_events = events
  }
  if (Array.isArray(record.character_ids)) {
    meta.character_ids = record.character_ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 50)
  }
  if (typeof record.pov_character_id === 'string' && record.pov_character_id.length > 0) {
    meta.pov_character_id = record.pov_character_id
  }
  if (typeof record.mainline === 'boolean') meta.mainline = record.mainline
  return meta
}

export const COVERAGE_GAP_CODES = [
  'key_event_unlanded',
  'character_uncast',
  'mainline_gap',
  'pov_missing',
  'meta_unannotated'
] as const
export type CoverageGapCode = (typeof COVERAGE_GAP_CODES)[number]

export const COVERAGE_GAP_LABELS: Record<CoverageGapCode, string> = {
  key_event_unlanded: '卷纲关键事件无章落点',
  character_uncast: '主要角色无出场章',
  mainline_gap: '主线推进间隔过大',
  pov_missing: '章纲 POV 不在角色表',
  meta_unannotated: '尚未标注结构化纲要素'
}

export const CoverageGapSchema = z.strictObject({
  code: z.enum(COVERAGE_GAP_CODES),
  severity: z.enum(['error', 'warn']),
  /** 定位：卷 / 章节点 id，或 'project'。 */
  node_id: z.string(),
  node_title: z.string(),
  /** 角色类问题的目标 id（点「定位」跳角色卡）；其余为 null。 */
  character_id: z.string().nullable(),
  message: z.string()
})
export type CoverageGap = z.infer<typeof CoverageGapSchema>

export const PlanCoverageSchema = z.strictObject({
  /** 本项目的覆盖检查开关（PHASE-15 §7 回退）：关闭后阻断项不再禁 G1。 */
  gate: z.boolean(),
  /** 是否已过 G1：过锁后覆盖检查只读展示，不再影响确认。 */
  locked: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  gaps: z.array(CoverageGapSchema)
})
export type PlanCoverageState = z.infer<typeof PlanCoverageSchema>

/** T26 的输出形状（契约变更：PRD §4.10 T26 行已同步）。 */
export const CoverageCheckOutputSchema = z.strictObject({
  scope: z.enum(['volume', 'chapter', 'project']),
  error_count: z.number().int().nonnegative(),
  warn_count: z.number().int().nonnegative(),
  gaps: z.array(
    z.strictObject({
      code: z.enum(COVERAGE_GAP_CODES),
      severity: z.enum(['error', 'warn']),
      node_id: z.string(),
      message: z.string()
    })
  )
})
export type CoverageCheckOutput = z.infer<typeof CoverageCheckOutputSchema>

/** 蓝图变更的 op（T31 与 G1 后变更流程共用同一套）。 */
export const BlueprintMetaPatchSchema = z.strictObject({
  key_events: z.array(BlueprintKeyEventSchema).max(50).optional(),
  character_ids: z.array(z.string().min(1)).max(50).optional(),
  pov_character_id: z.string().min(1).nullable().optional(),
  mainline: z.boolean().optional()
})
export type BlueprintMetaPatch = z.infer<typeof BlueprintMetaPatchSchema>

/** meta 合并：给了就整体替换该字段；`pov_character_id: null` = 清空。 */
export function mergeBlueprintMeta(existing: BlueprintMeta, patch: BlueprintMetaPatch): BlueprintMeta {
  const next: BlueprintMeta = { ...existing }
  if (patch.key_events !== undefined) next.key_events = patch.key_events
  if (patch.character_ids !== undefined) next.character_ids = patch.character_ids
  if (patch.mainline !== undefined) next.mainline = patch.mainline
  if (patch.pov_character_id !== undefined) {
    if (patch.pov_character_id === null) delete next.pov_character_id
    else next.pov_character_id = patch.pov_character_id
  }
  return next
}

/** 序列化只写已知字段（未知字段永远不落库）。 */
export function blueprintMetaJson(meta: BlueprintMeta): string {
  const out: Record<string, unknown> = {}
  if (meta.key_events !== undefined) out.key_events = meta.key_events
  if (meta.character_ids !== undefined) out.character_ids = meta.character_ids
  if (meta.pov_character_id !== undefined) out.pov_character_id = meta.pov_character_id
  if (meta.mainline !== undefined) out.mainline = meta.mainline
  return JSON.stringify(out)
}

export const BlueprintOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    parent_id: z.string().min(1).nullable(),
    parent_ref: z.string().min(1).max(40).optional(),
    ref: z.string().min(1).max(40).optional(),
    kind: z.enum(['main', 'volume', 'chapter']),
    ord: z.number().int().min(0).max(10_000),
    title: z.string().min(1).max(200),
    content: z.string().max(20_000).optional(),
    meta: BlueprintMetaPatchSchema.optional()
  }),
  z.strictObject({
    op: z.literal('update'),
    node_id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(20_000).optional(),
    meta: BlueprintMetaPatchSchema.optional()
  }),
  z.strictObject({ op: z.literal('remove'), node_id: z.string().min(1) })
])
export type BlueprintOp = z.infer<typeof BlueprintOpSchema>

export const CharacterCardChangeSchema = z.strictObject({
  character_id: z.string().min(1),
  card: z.record(z.string(), z.unknown())
})
export type CharacterCardChange = z.infer<typeof CharacterCardChangeSchema>

/** 影响分析结果：影响面 + 计数（UI 显示计数与列表）。 */
export const ImpactCountsSchema = z.strictObject({
  chapters: z.number().int().nonnegative(),
  memory_entries: z.number().int().nonnegative(),
  relationships: z.number().int().nonnegative()
})

export const ImpactResultSchema = z.strictObject({
  /** 已分析标记：apply 必须看到它，否则视为「未跑 T29」。 */
  analyzed: z.literal(true),
  analyzed_at: z.string(),
  chapters: z.array(z.strictObject({ id: z.string(), ord: z.number().int(), title: z.string(), status: z.string() })),
  memory_entries: z.array(z.strictObject({ id: z.string(), character_id: z.string(), text: z.string() })),
  relationships: z.array(
    z.strictObject({ id: z.string(), from_id: z.string(), to_id: z.string(), axis: z.string() })
  ),
  counts: ImpactCountsSchema
})
export type ImpactResult = z.infer<typeof ImpactResultSchema>

export const BLUEPRINT_CHANGE_STATUSES = ['proposed', 'applied', 'rejected'] as const
export const BlueprintChangeStatusSchema = z.enum(BLUEPRINT_CHANGE_STATUSES)

export const BlueprintChangeViewSchema = z.strictObject({
  id: z.string(),
  status: BlueprintChangeStatusSchema,
  proposalId: z.string().nullable(),
  actor: z.string(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  ops: z.array(BlueprintOpSchema),
  impact: ImpactResultSchema.nullable(),
  summary: z.strictObject({
    added: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    characterCards: z.number().int().nonnegative()
  })
})
export type BlueprintChangeView = z.infer<typeof BlueprintChangeViewSchema>

export const PlanCoverageInputSchema = z.strictObject({})
export const PlanCoverageGateInputSchema = z.strictObject({ enabled: z.boolean() })

export const PlanImpactAnalyzeInputSchema = z.strictObject({
  proposalId: z.string().min(1).optional(),
  ops: z.array(BlueprintOpSchema).min(1).max(50).optional(),
  characterCard: CharacterCardChangeSchema.optional()
})
export type PlanImpactAnalyzeInput = z.infer<typeof PlanImpactAnalyzeInputSchema>

export const PlanChangeIdInputSchema = z.strictObject({ changeId: z.string().min(1) })

export const PlanChangeApplyInputSchema = z.strictObject({
  changeId: z.string().min(1),
  /** 作者确认后是否标记受影响章；默认 true（只标记，不改正文）。 */
  markChapters: z.boolean().default(true)
})
export type PlanChangeApplyInput = z.infer<typeof PlanChangeApplyInputSchema>

export const PlanChangeApplyResultSchema = z.strictObject({
  change: BlueprintChangeViewSchema,
  blueprintVersion: z.number().int().nonnegative(),
  invalidatedChapters: z.array(z.string())
})
export type PlanChangeApplyResult = z.infer<typeof PlanChangeApplyResultSchema>

export const PlanDismissValidationInputSchema = z.strictObject({ chapterId: z.string().min(1) })
