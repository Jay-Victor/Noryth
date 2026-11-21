import { AppError } from '../../shared/domain/app-error'
import type { CostAgentRow, CostChapterRow, CostConfirmLatency, CostReport, CostReportInput, CostTotals } from '../../shared/schema/cost'
import { agentLabelFor } from '../../shared/schema/settings'
import type { Repos } from '../db/repos'
import type { TurnMetricAggregateRow, TurnMetricLatencyRow } from '../db/repos/model'

/**
 * 成本/耗时报表（PHASE-20 §5.5 / M2-5）。
 *
 * 口径：
 *   - 费用来自 `turn_metric.cost_cny`（有计价才累计），token 来自同表；
 *   - 字数来自 revision 清单（定稿读 final，草稿读 current），不读 live 拍；
 *   - 项目级 = `chapter_id IS NULL`（规划），单列不摊到章；
 *   - P50/P95 线性插值；样本 <5 时 P95 为 null（UI 只显示中位数）；
 *   - 每拍确认耗时 = 同一 beatId 的 `beat_committed` → `beat_confirmed` 时间差，
 *     自动模式不写 beat_confirmed，因此自动确认的拍计为缺失，不补 0。
 *
 * 查询次数固定（不随章数增长）：章 / 纲标题 / 字数 ×2 / 聚合 / 耗时样本 / 事件。
 */

/** 线性插值百分位；空样本返回 null。 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 1) return Math.round(sorted[0]!)
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, fraction))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return Math.round(sorted[lower]!)
  const value = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  return Math.round(value)
}

/** 样本 <5 时只给中位数（PHASE-20 §5.5）。 */
export function latencyOf(values: readonly number[]): { p50: number | null; p95: number | null } {
  return {
    p50: percentile(values, 0.5),
    p95: values.length >= 5 ? percentile(values, 0.95) : null
  }
}

function round6(value: number): number {
  // 分以下还有厘/毫：对账要求「报表合计 = 直接汇总」，保留 6 位（微元）。
  return Math.round(value * 1_000_000) / 1_000_000
}

function costPer10k(costCny: number, words: number): number | null {
  if (words <= 0) return null
  return round6((costCny / words) * 10_000)
}

function parseTime(value: string | undefined, field: string): number | null {
  if (value === undefined) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new AppError('invalid_args', `${field} 不是合法时间`, { [field]: value })
  return parsed
}

interface Bucket {
  tokensIn: number
  tokensOut: number
  costCny: number
  calls: number
  pricedCalls: number
}

function emptyBucket(): Bucket {
  return { tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0, pricedCalls: 0 }
}

function addTo(bucket: Bucket, row: TurnMetricAggregateRow): void {
  bucket.tokensIn += row.tokensIn
  bucket.tokensOut += row.tokensOut
  bucket.costCny += row.costCny
  bucket.calls += row.calls
  bucket.pricedCalls += row.pricedCalls
}

function unpricedOf(bucket: Bucket): number {
  return Math.max(0, bucket.calls - bucket.pricedCalls)
}

/** 每拍确认耗时（只统计作者确认；自动确认不写 beat_confirmed）。 */
export function confirmLatencyOf(
  events: ReadonlyArray<{ kind: string; payloadJson: string; createdAt: string }>
): CostConfirmLatency {
  const committed = new Map<string, number>()
  const confirmed = new Map<string, number>()
  for (const event of events) {
    let beatId: string | null = null
    try {
      const payload = JSON.parse(event.payloadJson) as { beatId?: unknown }
      if (typeof payload.beatId === 'string') beatId = payload.beatId
    } catch {
      beatId = null
    }
    if (beatId === null) continue
    const at = Date.parse(event.createdAt)
    if (Number.isNaN(at)) continue
    if (event.kind === 'beat_committed' && !committed.has(beatId)) committed.set(beatId, at)
    if (event.kind === 'beat_confirmed' && !confirmed.has(beatId)) confirmed.set(beatId, at)
  }
  const durations: number[] = []
  let missingBeats = 0
  for (const [beatId, committedAt] of committed) {
    const confirmedAt = confirmed.get(beatId)
    if (confirmedAt === undefined) {
      missingBeats += 1
      continue
    }
    const delta = confirmedAt - committedAt
    if (delta < 0) {
      missingBeats += 1
      continue
    }
    durations.push(delta)
  }
  const { p50, p95 } = latencyOf(durations)
  return { samples: durations.length, p50, p95, missingBeats }
}

export function buildCostReport(repos: Repos, input: CostReportInput = {}): CostReport {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const fromMs = parseTime(input.from, 'from')
  const toMs = parseTime(input.to, 'to')
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new AppError('invalid_args', 'from 晚于 to', { from: input.from, to: input.to })
  }
  if (input.chapterId !== undefined && !repos.chapter.get(input.chapterId)) {
    throw new AppError('invalid_args', '章不存在', { chapterId: input.chapterId })
  }

  const filter = {
    ...(input.chapterId === undefined ? {} : { chapterId: input.chapterId }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to })
  }
  const aggregates = repos.turnMetric.aggregate(project.id, filter)
  const latencies = repos.turnMetric.latencySamples(project.id, filter)

  const chapters = repos.chapter.listByProject(project.id).filter(
    (chapter) => input.chapterId === undefined || chapter.id === input.chapterId
  )
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  const outlineTitles = new Map(repos.outline.listByProject(project.id).map((node) => [node.id, node.title]))
  const wordsByChapter = repos.chapter.wordCountsFromRevisions(project.id)

  // ── 按章 ────────────────────────────────────────────────────────────────
  const chapterBuckets = new Map<string, Bucket>()
  for (const row of aggregates) {
    if (row.chapterId === null) continue
    const bucket = chapterBuckets.get(row.chapterId) ?? emptyBucket()
    addTo(bucket, row)
    chapterBuckets.set(row.chapterId, bucket)
  }
  const chapterIds = new Set<string>([...chapters.map((chapter) => chapter.id), ...chapterBuckets.keys()])
  const chapterLatencies = new Map<string, number[]>()
  for (const sample of latencies) {
    if (sample.chapterId === null) continue
    const list = chapterLatencies.get(sample.chapterId) ?? []
    list.push(sample.latencyMs)
    chapterLatencies.set(sample.chapterId, list)
  }

  const byChapter: CostChapterRow[] = [...chapterIds].map((chapterId) => {
    const chapter = chapterById.get(chapterId) ?? null
    const bucket = chapterBuckets.get(chapterId) ?? emptyBucket()
    const words = wordsByChapter.get(chapterId) ?? 0
    const latency = latencyOf(chapterLatencies.get(chapterId) ?? [])
    return {
      chapterId,
      ord: chapter?.ord ?? 0,
      title: chapter
        ? (outlineTitles.get(chapter.outlineNodeId) ?? `第 ${chapter.ord} 章`)
        : '已删除章',
      words,
      tokensIn: bucket.tokensIn,
      tokensOut: bucket.tokensOut,
      costCny: round6(bucket.costCny),
      costPer10k: costPer10k(bucket.costCny, words),
      calls: bucket.calls,
      pricedCalls: bucket.pricedCalls,
      unpricedCalls: unpricedOf(bucket),
      latencyP50: latency.p50,
      latencyP95: latency.p95
    }
  })
  byChapter.sort((left, right) => {
    if (left.ord !== right.ord) return left.ord - right.ord
    return left.chapterId.localeCompare(right.chapterId)
  })

  // ── 按 Agent（含项目级规划） ─────────────────────────────────────────────
  const agentBuckets = new Map<string, Bucket>()
  const projectLevel = emptyBucket()
  for (const row of aggregates) {
    const bucket = agentBuckets.get(row.agentKey) ?? emptyBucket()
    addTo(bucket, row)
    agentBuckets.set(row.agentKey, bucket)
    if (row.chapterId === null) addTo(projectLevel, row)
  }
  const agentLatencies = new Map<string, number[]>()
  for (const sample of latencies) {
    const list = agentLatencies.get(sample.agentKey) ?? []
    list.push(sample.latencyMs)
    agentLatencies.set(sample.agentKey, list)
  }

  // ── 合计 ────────────────────────────────────────────────────────────────
  const totalBucket = emptyBucket()
  for (const bucket of agentBuckets.values()) {
    totalBucket.tokensIn += bucket.tokensIn
    totalBucket.tokensOut += bucket.tokensOut
    totalBucket.costCny += bucket.costCny
    totalBucket.calls += bucket.calls
    totalBucket.pricedCalls += bucket.pricedCalls
  }
  const totalWords = chapters.reduce((sum, chapter) => sum + (wordsByChapter.get(chapter.id) ?? 0), 0)
  const shareBasis: 'cost' | 'tokens' = totalBucket.costCny > 0 ? 'cost' : 'tokens'

  const byAgent: CostAgentRow[] = [...agentBuckets.entries()]
    .map(([agentKey, bucket]) => {
      const latency = latencyOf(agentLatencies.get(agentKey) ?? [])
      const share =
        shareBasis === 'cost'
          ? totalBucket.costCny > 0
            ? bucket.costCny / totalBucket.costCny
            : 0
          : totalBucket.tokensIn + totalBucket.tokensOut > 0
            ? (bucket.tokensIn + bucket.tokensOut) / (totalBucket.tokensIn + totalBucket.tokensOut)
            : 0
      return {
        agentKey,
        label: agentLabelFor(agentKey),
        tokensIn: bucket.tokensIn,
        tokensOut: bucket.tokensOut,
        costCny: round6(bucket.costCny),
        calls: bucket.calls,
        pricedCalls: bucket.pricedCalls,
        unpricedCalls: unpricedOf(bucket),
        share: Math.round(share * 10_000) / 10_000,
        latencyP50: latency.p50,
        latencyP95: latency.p95
      }
    })
    .sort((left, right) => right.costCny - left.costCny || right.calls - left.calls || left.agentKey.localeCompare(right.agentKey))

  const total: CostTotals = {
    tokensIn: totalBucket.tokensIn,
    tokensOut: totalBucket.tokensOut,
    costCny: round6(totalBucket.costCny),
    pricedCalls: totalBucket.pricedCalls,
    unpricedCalls: unpricedOf(totalBucket),
    words: totalWords,
    costPer10k: costPer10k(totalBucket.costCny, totalWords)
  }

  const confirm = confirmLatencyOf(
    repos.schedulerEvent.listBeatTiming(project.id, input.chapterId)
  )

  return {
    total,
    byChapter,
    byAgent,
    projectLevel: {
      tokensIn: projectLevel.tokensIn,
      tokensOut: projectLevel.tokensOut,
      costCny: round6(projectLevel.costCny),
      calls: projectLevel.calls
    },
    shareBasis,
    confirm,
    generatedAt: new Date().toISOString()
  }
}

/** 供测试使用：同一批聚合行的直接汇总（COST-M2-01 对账基准）。 */
export function sumAggregates(
  rows: readonly TurnMetricAggregateRow[]
): { tokensIn: number; tokensOut: number; costCny: number; calls: number } {
  return rows.reduce(
    (sum, row) => ({
      tokensIn: sum.tokensIn + row.tokensIn,
      tokensOut: sum.tokensOut + row.tokensOut,
      costCny: sum.costCny + row.costCny,
      calls: sum.calls + row.calls
    }),
    { tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0 }
  )
}

export type { TurnMetricLatencyRow }
