import { z } from 'zod'

/**
 * 审批报告契约（PRD §5.3 / 附录 B / PHASE-08 §5.1）。
 *
 * 三条硬规则，全部由 `normalizeReport` 在服务端执行，不依赖模型自觉：
 *   1. 阻断项必须同时有 `beat_id` 与 `evidence`；缺一个就降级为建议。
 *   2. 只有「硬问题」类型可以阻断；文笔/节奏类即使被模型标成 blocking 也降级。
 *   3. `verdict` 由条目反推：有阻断 = fail；只有建议 = pass_with_notes；都没有 = pass。
 *      模型不能在没有阻断时给 fail，也不能在有阻断时给 pass。
 *
 * `issue_id` 由服务端补齐（`iss_01` 起），模型给的不合法就重编号，保证 UI 与
 * patch 的 `issue_ref` 永远能对上。
 */

export const ISSUE_TYPES = [
  'knowledge_leak',
  'unauthorized_speech',
  'outline_conflict',
  'missing_event',
  'character_conflict',
  'timeline',
  'continuity',
  'reference_missing',
  'voice',
  'prose',
  'pacing',
  'other'
] as const
export type IssueType = (typeof ISSUE_TYPES)[number]
export const IssueTypeSchema = z.enum(ISSUE_TYPES)

/** PRD §5.3「阻断项」；其余类型只能进建议。 */
export const BLOCKING_ISSUE_TYPES: readonly IssueType[] = [
  'knowledge_leak',
  'unauthorized_speech',
  'outline_conflict',
  'missing_event',
  'character_conflict',
  'timeline',
  'continuity',
  'reference_missing'
]

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  knowledge_leak: '知识越界',
  unauthorized_speech: '越权发言',
  outline_conflict: '章纲冲突',
  missing_event: '关键事件缺失',
  character_conflict: '人物硬冲突',
  timeline: '时间线',
  continuity: '连续性',
  reference_missing: '引用不存在',
  voice: '声音区分',
  prose: '文笔',
  pacing: '节奏',
  other: '未分类'
}

export const VERDICTS = ['pass', 'pass_with_notes', 'fail'] as const
export type Verdict = (typeof VERDICTS)[number]
export const VerdictSchema = z.enum(VERDICTS)

export const VERDICT_LABELS: Record<Verdict, string> = {
  pass: '通过',
  pass_with_notes: '通过（有建议）',
  fail: '未通过'
}

export const DIMENSION_KEYS = ['character_consistency', 'plot_logic', 'outline_alignment', 'prose'] as const
export type DimensionKey = (typeof DIMENSION_KEYS)[number]
export const DimensionKeySchema = z.enum(DIMENSION_KEYS)

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  character_consistency: '人物一致性',
  plot_logic: '剧情逻辑',
  outline_alignment: '纲要对齐',
  prose: '文笔质量'
}

/** DEV-PLAN §9.7：issue 类型 → 复检维度。未分类按全维度（保守）。 */
export const ISSUE_DIMENSIONS: Record<IssueType, readonly DimensionKey[]> = {
  knowledge_leak: ['character_consistency', 'plot_logic'],
  unauthorized_speech: ['character_consistency', 'plot_logic'],
  outline_conflict: ['outline_alignment'],
  missing_event: ['outline_alignment'],
  character_conflict: ['character_consistency'],
  timeline: ['plot_logic'],
  continuity: ['plot_logic'],
  reference_missing: ['plot_logic'],
  voice: ['prose'],
  prose: ['prose'],
  pacing: ['prose'],
  other: [...DIMENSION_KEYS]
}

export function allDimensions(): DimensionKey[] {
  return [...DIMENSION_KEYS]
}

/** 一组 issue 类型对应的复检维度（去重、按 DIMENSION_KEYS 顺序）。 */
export function dimensionsForIssueTypes(types: readonly IssueType[]): DimensionKey[] {
  if (types.length === 0) return allDimensions()
  const wanted = new Set<DimensionKey>()
  for (const type of types) {
    for (const dimension of ISSUE_DIMENSIONS[type]) wanted.add(dimension)
  }
  return DIMENSION_KEYS.filter((key) => wanted.has(key))
}

/** 复检默认范围：上一份报告里阻断项的类型 → 维度；没有阻断则全维度。 */
export function dimensionsForBlocking(types: readonly IssueType[]): DimensionKey[] {
  return types.length === 0 ? allDimensions() : dimensionsForIssueTypes(types)
}

export const REVIEW_ROUND_LIMIT = 3

/** 模型可见的报告草稿：字段名按 PRD 附录 B；beat_id 可空（建议类允许全局）。 */
export const ReportIssueDraftSchema = z.object({
  issue_id: z.string().min(1).max(60).optional(),
  type: IssueTypeSchema,
  beat_id: z.string().max(80).optional(),
  evidence: z.string().max(1000).optional(),
  why: z.string().max(1000).optional(),
  suggestion: z.string().max(1000).optional()
})
export type ReportIssueDraft = z.infer<typeof ReportIssueDraftSchema>

export const ReportDraftSchema = z.object({
  verdict: VerdictSchema,
  blocking: z.array(ReportIssueDraftSchema).max(30).default([]),
  suggestions: z.array(ReportIssueDraftSchema).max(30).default([]),
  dimensions: z.record(z.string(), z.number()).optional(),
  model: z.string().max(120).optional()
})
export type ReportDraft = z.infer<typeof ReportDraftSchema>

export const IssueSchema = z.strictObject({
  issue_id: z.string().min(1),
  type: IssueTypeSchema,
  /** 空串 = 全局建议（不定位到某一拍）。 */
  beat_id: z.string(),
  evidence: z.string(),
  why: z.string(),
  suggestion: z.string(),
  /** 非空表示被服务端降级（missing_evidence / advisory_type / missing_why）。 */
  downgraded: z.string().nullable()
})
export type Issue = z.infer<typeof IssueSchema>

export const DimensionScoresSchema = z.strictObject({
  character_consistency: z.number().int().min(1).max(5).nullable(),
  plot_logic: z.number().int().min(1).max(5).nullable(),
  outline_alignment: z.number().int().min(1).max(5).nullable(),
  prose: z.number().int().min(1).max(5).nullable()
})
export type DimensionScores = z.infer<typeof DimensionScoresSchema>

export const ReviewReportSchema = z.strictObject({
  verdict: VerdictSchema,
  blocking: z.array(IssueSchema),
  suggestions: z.array(IssueSchema),
  dimensions: DimensionScoresSchema
})
export type ReviewReport = z.infer<typeof ReviewReportSchema>

function emptyDimensions(): DimensionScores {
  return {
    character_consistency: null,
    plot_logic: null,
    outline_alignment: null,
    prose: null
  }
}

export function parseDimensions(raw: unknown): DimensionScores {
  const result = emptyDimensions()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const key of DIMENSION_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const score = Math.round(value)
    if (score >= 1 && score <= 5) result[key] = score
  }
  return result
}

function cleanIssueId(raw: string | undefined, index: number): string {
  const trimmed = (raw ?? '').trim()
  if (/^iss_[A-Za-z0-9_-]{1,40}$/.test(trimmed)) return trimmed
  return `iss_${String(index + 1).padStart(2, '0')}`
}

interface NormalizedIssue extends Issue {
  /** 原始分组：模型请求它做阻断还是建议。 */
  requested: 'blocking' | 'suggestion'
}

function normalizeOne(
  draft: ReportIssueDraft,
  requested: 'blocking' | 'suggestion',
  index: number
): NormalizedIssue {
  const type = draft.type
  const beatId = (draft.beat_id ?? '').trim()
  const evidence = (draft.evidence ?? '').trim()
  const why = (draft.why ?? '').trim()
  const suggestion = (draft.suggestion ?? '').trim()

  let downgraded: string | null = null
  if (!BLOCKING_ISSUE_TYPES.includes(type)) downgraded = 'advisory_type'
  else if (requested === 'suggestion') downgraded = null
  else if (beatId.length === 0) downgraded = 'missing_beat'
  else if (evidence.length === 0) downgraded = 'missing_evidence'
  else if (why.length === 0) downgraded = 'missing_why'

  return {
    issue_id: cleanIssueId(draft.issue_id, index),
    type,
    beat_id: beatId,
    evidence,
    why,
    suggestion,
    downgraded,
    requested
  }
}

/**
 * 归一化 + 降级 + 去重。纯函数：不查库。
 * 拍是否存在由 `submitReport` 查库后再降级（这一层拿不到 repos）。
 */
export function normalizeReport(draft: ReportDraft): ReviewReport {
  const seen = new Set<string>()
  const blocking: Issue[] = []
  const suggestions: Issue[] = []
  const usedIds = new Set<string>()
  let seq = 0

  const push = (issue: NormalizedIssue): void => {
    let issueId = issue.issue_id
    while (usedIds.has(issueId)) {
      seq += 1
      issueId = `iss_${String(seq).padStart(2, '0')}`
    }
    usedIds.add(issueId)
    const finalIssue: Issue = {
      issue_id: issueId,
      type: issue.type,
      beat_id: issue.beat_id,
      evidence: issue.evidence,
      why: issue.why.length > 0 ? issue.why : ISSUE_TYPE_LABELS[issue.type],
      suggestion: issue.suggestion,
      downgraded: issue.downgraded
    }
    const key = `${finalIssue.type}|${finalIssue.beat_id}|${finalIssue.evidence}`
    if (seen.has(key)) return
    seen.add(key)
    if (issue.requested === 'blocking' && finalIssue.downgraded === null) blocking.push(finalIssue)
    else suggestions.push(finalIssue)
  }

  draft.blocking.forEach((item, index) => push(normalizeOne(item, 'blocking', index)))
  draft.suggestions.forEach((item, index) =>
    push(normalizeOne(item, 'suggestion', draft.blocking.length + index))
  )

  const verdict: Verdict =
    blocking.length > 0 ? 'fail' : suggestions.length > 0 ? 'pass_with_notes' : 'pass'

  return { verdict, blocking, suggestions, dimensions: parseDimensions(draft.dimensions) }
}

/** UI 侧反推（报告已存库时不需要再跑归一化）：只看条目，不信 verdict。 */
export function verdictOf(blocking: readonly Issue[], suggestions: readonly Issue[]): Verdict {
  if (blocking.length > 0) return 'fail'
  return suggestions.length > 0 ? 'pass_with_notes' : 'pass'
}

export const ISSUE_REF_PREFIX = 'iss_'

/** patch.propose 的 issue_ref 归一：只接受 `iss_xx` 或 `type:beat_id` 形式。 */
export function normalizeIssueRef(ref: string): string {
  return ref.trim()
}
