import { AppError } from '../../shared/domain/app-error'
import type { DimensionKey, Issue, ReportDraft, ReviewReport, Verdict } from '../../shared/schema/report'
import {
  DimensionScoresSchema,
  IssueSchema,
  normalizeReport,
  parseDimensions,
  verdictOf
} from '../../shared/schema/report'
import { normalizedIncludes } from '../../shared/text/normalize'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { ApprovalReportRecord } from '../db/repos/review'
import { withTransaction } from '../db/tx'

/**
 * 报告的**唯一写入路径**（PHASE-08 §5.1）。
 *
 * 两条入口都收敛到这里：
 *   - 审批 Agent 调用 T35 `report.submit`；
 *   - 运行时把最终答复里的 JSON 报告解析后直接提交（模型没调工具时的兜底）。
 *
 * 归一化在这里做，不信任模型：缺证据的阻断降级为建议、未定位的阻断降级、
 * verdict 由条目反推。这样「每条阻断都有 beat 与证据」是写库不变量，
 * 而不是提示词里的口头约定。
 */

export interface SubmitReportInput {
  projectId: string
  chapterId: string
  revisionId: string
  /** 不传 = 本章下一轮。 */
  round?: number
  draft: ReportDraft
  /** 复检范围；空数组 = 全量。 */
  scope?: readonly DimensionKey[]
  degraded?: string | null
  model?: string | null
  provider?: string | null
}

export interface SubmitReportResult {
  report: ApprovalReportRecord
  /** 被服务端降级的条目数（用于 UI 提示与审计）。 */
  downgraded: number
}

function assertRevision(
  repos: Repos,
  input: { projectId: string; chapterId: string; revisionId: string }
) {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter || chapter.projectId !== input.projectId) {
    throw new AppError('invalid_args', 'chapter not in project', { chapterId: input.chapterId })
  }
  if (chapter.status === 'finalized') {
    throw new AppError('already_finalized', '本章已定稿，不能再出报告', { chapterId: chapter.id })
  }
  const revision = repos.revision.get(input.revisionId)
  if (!revision || revision.chapterId !== chapter.id) {
    throw new AppError('stale_revision', 'revision mismatch', { revisionId: input.revisionId })
  }
  if (chapter.currentRevisionId !== revision.id) {
    throw new AppError('stale_revision', 'revision is not the current draft', {
      expected: chapter.currentRevisionId,
      actual: revision.id
    })
  }
  return { chapter, revision }
}

/**
 * 阻断项必须能定位：拍存在、且 evidence 真的是该拍正文的子串。
 * 不满足就降级为建议——报告仍要产出，但不能假装定位成功（PHASE-08 §6）。
 */
function demoteUnusableBlocking(
  report: ReviewReport,
  repos: Repos,
  chapterId: string
): { report: ReviewReport; downgraded: number } {
  let downgraded = 0
  const blocking: Issue[] = []
  const suggestions: Issue[] = [...report.suggestions]
  for (const issue of report.blocking) {
    const beat = issue.beat_id.length > 0 ? repos.beat.get(issue.beat_id) : null
    if (!beat || beat.chapterId !== chapterId) {
      downgraded += 1
      suggestions.push({ ...issue, downgraded: 'unknown_beat' })
      continue
    }
    if (issue.evidence.trim().length < 4 || !normalizedIncludes(beat.body, issue.evidence)) {
      downgraded += 1
      suggestions.push({ ...issue, downgraded: 'evidence_not_found' })
      continue
    }
    blocking.push(issue)
  }
  return {
    report: {
      verdict: verdictOf(blocking, suggestions),
      blocking,
      suggestions,
      dimensions: report.dimensions
    },
    downgraded
  }
}

export function submitReport(repos: Repos, input: SubmitReportInput, db?: Db): SubmitReportResult {
  const work = (): SubmitReportResult => {
    const { chapter } = assertRevision(repos, input)
    const normalized = normalizeReport(input.draft)
    const demoted = demoteUnusableBlocking(normalized, repos, chapter.id)
    const round = input.round ?? repos.review.listReportsByChapter(chapter.id).length + 1
    const scope = [...new Set(input.scope ?? [])]
    const record = repos.review.insertReport({
      projectId: input.projectId,
      chapterId: chapter.id,
      revisionId: input.revisionId,
      round,
      verdict: demoted.report.verdict,
      blockingJson: JSON.stringify(demoted.report.blocking),
      suggestionsJson: JSON.stringify(demoted.report.suggestions),
      dimensionsJson: JSON.stringify(demoted.report.dimensions),
      scopeJson: JSON.stringify(scope),
      degraded: input.degraded ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null
    })
    return { report: record, downgraded: demoted.downgraded }
  }
  return db ? withTransaction(db, work) : work()
}

/** 纯文本降级报告：schema 解析失败时使用，阻断无法定位是已知代价（UI 提示重试）。 */
export function submitPlainReport(
  repos: Repos,
  input: {
    projectId: string
    chapterId: string
    revisionId: string
    text: string
    model?: string | null
    provider?: string | null
    scope?: readonly DimensionKey[]
  },
  db?: Db
): SubmitReportResult {
  const work = (): SubmitReportResult => {
    const { chapter } = assertRevision(repos, input)
    const round = repos.review.listReportsByChapter(chapter.id).length + 1
    const record = repos.review.insertReport({
      projectId: input.projectId,
      chapterId: chapter.id,
      revisionId: input.revisionId,
      round,
      verdict: 'fail',
      blockingJson: '[]',
      suggestionsJson: JSON.stringify([
        {
          issue_id: 'iss_plain',
          type: 'other',
          beat_id: '',
          evidence: '',
          why: '报告 schema 解析失败，已降级为纯文本',
          suggestion: input.text.slice(0, 1000),
          downgraded: 'schema_fallback'
        }
      ]),
      dimensionsJson: JSON.stringify(parseDimensions(null)),
      scopeJson: JSON.stringify([...(input.scope ?? [])]),
      degraded: 'schema_fallback',
      model: input.model ?? null,
      provider: input.provider ?? null
    })
    return { report: record, downgraded: 0 }
  }
  return db ? withTransaction(db, work) : work()
}

function parseIssueArray(json: string): Issue[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      const result = IssueSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

function parseScope(json: string): DimensionKey[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const keys: DimensionKey[] = []
    for (const value of parsed) {
      if (value === 'character_consistency' || value === 'plot_logic' || value === 'outline_alignment' || value === 'prose') {
        keys.push(value)
      }
    }
    return keys
  } catch {
    return []
  }
}

export interface ParsedReport {
  id: string
  round: number
  verdict: Verdict
  revisionId: string
  blocking: Issue[]
  suggestions: Issue[]
  dimensions: ReturnType<typeof parseDimensions>
  scope: DimensionKey[]
  degraded: string | null
  model: string | null
  provider: string | null
  createdAt: string
}

export function parseReportRecord(record: ApprovalReportRecord): ParsedReport {
  const blocking = parseIssueArray(record.blockingJson)
  const suggestions = parseIssueArray(record.suggestionsJson)
  let rawDimensions: unknown
  try {
    rawDimensions = JSON.parse(record.dimensionsJson || '{}') as unknown
  } catch {
    rawDimensions = {}
  }
  const dimensionsParsed = DimensionScoresSchema.safeParse(rawDimensions)
  return {
    id: record.id,
    round: record.round,
    verdict: record.verdict,
    revisionId: record.revisionId,
    blocking,
    suggestions,
    dimensions: dimensionsParsed.success ? dimensionsParsed.data : parseDimensions(null),
    scope: parseScope(record.scopeJson),
    degraded: record.degraded,
    model: record.model,
    provider: record.provider,
    createdAt: record.createdAt
  }
}

/** 最新报告的选择口径：按 round 最大，其次创建时间。 */
export function latestReport(repos: Repos, chapterId: string): ApprovalReportRecord | null {
  const reports = repos.review.listReportsByChapter(chapterId)
  if (reports.length === 0) return null
  return reports.reduce((latest, item) => {
    if (item.round > latest.round) return item
    if (item.round === latest.round && item.createdAt > latest.createdAt) return item
    return latest
  }, reports[0]!)
}
