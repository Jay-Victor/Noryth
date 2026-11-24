import type {
  CalibrationCohort,
  CalibrationDecision,
  CalibrationDimension,
  CalibrationReport
} from '../../shared/schema/calibration'
import { DIMENSION_KEYS, ISSUE_DIMENSIONS, type DimensionKey, type Issue } from '../../shared/schema/report'
import type { Repos } from '../db/repos'
import type { PatchRecord } from '../db/repos/patch'
import type { ProjectRecord } from '../db/repos/project'
import { PROVIDER_PRESETS } from '../model/presets'
import { generationProviderOf } from './hetero'
import { parseReportRecord } from './report'

/**
 * 异构复检校准（PHASE-21 §5.4 / M2-8）。
 *
 * 只读三张表：`approval_report` / `patch` / `gate_record`。
 * 「阻断被作者接受（patch 应用）」是代理指标；没有作者决策的报告不进分母。
 * 费用只从 `turn_metric` 汇总；第二家没计价时 `heteroDeltaPct=null`，
 * 不做「看起来精确」的估算。
 */

function emptyCohort(): CalibrationCohort {
  return {
    reports: 0,
    blocking: { total: 0, accepted: 0, rejected: 0, acceptanceRate: null },
    blockingPerReport: null
  }
}

function rate(accepted: number, rejected: number): number | null {
  const total = accepted + rejected
  return total === 0 ? null : accepted / total
}

function finishCohort(cohort: CalibrationCohort): CalibrationCohort {
  return {
    ...cohort,
    blocking: { ...cohort.blocking, acceptanceRate: rate(cohort.blocking.accepted, cohort.blocking.rejected) },
    blockingPerReport: cohort.reports === 0 ? null : cohort.blocking.total / cohort.reports
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** patch 决策按 revision + issue_ref 归组；只有 applied/accepted 与 rejected 进分母。 */
function decisionIndex(patches: readonly PatchRecord[]): Map<string, Map<string, 'accepted' | 'rejected' | 'pending'>> {
  const index = new Map<string, Map<string, 'accepted' | 'rejected' | 'pending'>>()
  for (const patch of patches) {
    const byIssue = index.get(patch.revisionId) ?? new Map<string, 'accepted' | 'rejected' | 'pending'>()
    const current = byIssue.get(patch.issueRef)
    const next: 'accepted' | 'rejected' | 'pending' =
      patch.status === 'applied' || patch.status === 'accepted'
        ? 'accepted'
        : patch.status === 'rejected'
          ? 'rejected'
          : 'pending'
    // accepted 优先（同一 issue 的多条 patch 取最终有效决策）；rejected 不覆盖 accepted。
    if (current === undefined || (current === 'pending' && next !== 'pending') || (current === 'rejected' && next === 'accepted')) {
      byIssue.set(patch.issueRef, next)
    }
    index.set(patch.revisionId, byIssue)
  }
  return index
}

function dimensionScoresOf(issue: Issue): DimensionKey[] {
  return [...ISSUE_DIMENSIONS[issue.type]]
}

export function buildCalibrationReport(
  repos: Repos,
  projectId: string,
  options: { now?: () => Date } = {}
): CalibrationReport {
  const project = repos.project.get()
  if (!project || project.id !== projectId) {
    throw new Error('project mismatch')
  }
  const reports = repos.review.listByProject(projectId)
  const patches = repos.patch.listByProject(projectId)
  const decisions = decisionIndex(patches)
  const chapters = repos.chapter.listByProject(projectId)
  const generationByChapter = new Map<string, string | null>()
  for (const chapter of chapters) {
    generationByChapter.set(chapter.id, generationProviderOf(repos, project, chapter))
  }

  const cohorts = { sameProvider: emptyCohort(), heteroProvider: emptyCohort() }
  const blocking = { total: 0, accepted: 0, rejected: 0 }
  const suggestions = { total: 0, accepted: 0, rejected: 0 }
  const dimensionStats = new Map<
    DimensionKey,
    { sum: number; samples: number; acceptedSum: number; acceptedCount: number; rejectedSum: number; rejectedCount: number }
  >()
  for (const key of DIMENSION_KEYS) {
    dimensionStats.set(key, { sum: 0, samples: 0, acceptedSum: 0, acceptedCount: 0, rejectedSum: 0, rejectedCount: 0 })
  }

  for (const record of reports) {
    const parsed = parseReportRecord(record)
    const generation = generationByChapter.get(record.chapterId) ?? null
    const cohortKey =
      record.provider === null || generation === null
        ? null
        : record.provider === generation
          ? 'sameProvider'
          : 'heteroProvider'
    if (cohortKey !== null) cohorts[cohortKey].reports += 1

    const byIssue = decisions.get(record.revisionId) ?? new Map<string, 'accepted' | 'rejected' | 'pending'>()
    const decisionOf = (issue: Issue): 'accepted' | 'rejected' | null => {
      const value = byIssue.get(issue.issue_id)
      return value === 'accepted' || value === 'rejected' ? value : null
    }

    for (const issue of parsed.blocking) {
      blocking.total += 1
      if (cohortKey !== null) cohorts[cohortKey].blocking.total += 1
      const decision = decisionOf(issue)
      if (decision === 'accepted') {
        blocking.accepted += 1
        if (cohortKey !== null) cohorts[cohortKey].blocking.accepted += 1
      } else if (decision === 'rejected') {
        blocking.rejected += 1
        if (cohortKey !== null) cohorts[cohortKey].blocking.rejected += 1
      }
    }
    for (const issue of parsed.suggestions) {
      suggestions.total += 1
      const decision = decisionOf(issue)
      if (decision === 'accepted') suggestions.accepted += 1
      else if (decision === 'rejected') suggestions.rejected += 1
    }

    for (const key of DIMENSION_KEYS) {
      const score = parsed.dimensions[key]
      if (score === null) continue
      const stats = dimensionStats.get(key)!
      stats.sum += score
      stats.samples += 1
      let accepted = false
      let rejected = false
      for (const issue of [...parsed.blocking, ...parsed.suggestions]) {
        if (!dimensionScoresOf(issue).includes(key)) continue
        const decision = decisionOf(issue)
        if (decision === 'accepted') accepted = true
        else if (decision === 'rejected') rejected = true
      }
      if (accepted) {
        stats.acceptedSum += score
        stats.acceptedCount += 1
      }
      if (rejected) {
        stats.rejectedSum += score
        stats.rejectedCount += 1
      }
    }
  }

  const byDimension: CalibrationDimension[] = DIMENSION_KEYS.map((key) => {
    const stats = dimensionStats.get(key)!
    return {
      dimension: key,
      meanScore: stats.samples === 0 ? null : round(stats.sum / stats.samples),
      acceptedMean: stats.acceptedCount === 0 ? null : round(stats.acceptedSum / stats.acceptedCount),
      rejectedMean: stats.rejectedCount === 0 ? null : round(stats.rejectedSum / stats.rejectedCount),
      samples: stats.samples
    }
  })

  const aggregate = repos.turnMetric.aggregate(projectId)
  let reviewCny = 0
  let generationCny = 0
  let reviewTokensIn = 0
  let reviewTokensOut = 0
  for (const row of aggregate) {
    if (row.agentKey === 'reviewer') {
      reviewCny += row.costCny
      reviewTokensIn += row.tokensIn
      reviewTokensOut += row.tokensOut
    } else if (row.agentKey === 'character' || row.agentKey === 'narrator') {
      generationCny += row.costCny
    }
  }

  const { deltaPct, simulated } = simulateHeteroDelta(project, reviewCny, reviewTokensIn, reviewTokensOut)
  const finalized = repos.gate.listByProject(projectId, 'G6').filter((gate) => gate.decision === 'approve')
  const finalizedChapters = new Set(finalized.map((gate) => gate.entityId)).size

  const limitations: string[] = [
    '阻断接受率来自作者对 patch 的决策，是代理指标，不是人工标注的召回率。',
    '费用取自 turn_metric 的预设计价，不是供应商账单；假模型 usage 不是报价。',
    '没有作者决策的报告不计入分母；被拒绝的建议不视为「漏报」。'
  ]
  if (simulated) {
    limitations.push('heteroDeltaPct 用预设计价模拟（第二家未接真实 Key），只作量级参考。')
  } else {
    limitations.push('第二家预设未定价或没有审批用量，heteroDeltaPct 为 null；不能据此判定费用条件。')
  }
  if (cohorts.heteroProvider.reports === 0) {
    limitations.push('没有异构审批样本，D4 无法用真实对照证明「阻断接受率不降、漏报代理下降」。')
  }
  if (cohorts.sameProvider.reports === 0) {
    limitations.push('没有同家审批样本，缺少对照组。')
  }
  limitations.push('真实第二家 Key 未补测时不伪造默认开启；数据不足时保持 review.hetero=off。')

  const baseReport = {
    reports: reports.length,
    blocking: {
      total: blocking.total,
      accepted: blocking.accepted,
      rejected: blocking.rejected,
      acceptanceRate: rate(blocking.accepted, blocking.rejected)
    },
    suggestions: {
      total: suggestions.total,
      accepted: suggestions.accepted,
      rejected: suggestions.rejected,
      acceptanceRate: rate(suggestions.accepted, suggestions.rejected)
    },
    byDimension,
    cost: { reviewCny: round(reviewCny), generationCny: round(generationCny), heteroDeltaPct: deltaPct },
    cohorts: {
      sameProvider: finishCohort(cohorts.sameProvider),
      heteroProvider: finishCohort(cohorts.heteroProvider)
    },
    finalizedChapters,
    limitations
  }

  return {
    ...baseReport,
    decision: decideHeteroDefault(baseReport),
    generatedAt: (options.now ?? (() => new Date()))().toISOString()
  }
}

/**
 * 费用差：用「第二家预设计价 × 当前审批 token」替换当前审批费用。
 * 第二家没价格 → null（不假装 0）。
 */
function simulateHeteroDelta(
  project: ProjectRecord,
  reviewCny: number,
  tokensIn: number,
  tokensOut: number
): { deltaPct: number | null; simulated: boolean } {
  if (reviewCny <= 0 || (tokensIn === 0 && tokensOut === 0)) return { deltaPct: null, simulated: false }
  const alternative = PROVIDER_PRESETS.find(
    (preset) => preset.preset !== project.defaultPreset && preset.models.some((model) => model.capabilities.pricing.in > 0 || model.capabilities.pricing.out > 0)
  )
  const pricing = alternative?.models[0]?.capabilities.pricing
  if (!alternative || !pricing) return { deltaPct: null, simulated: false }
  const simulatedCost = (tokensIn * pricing.in + tokensOut * pricing.out) / 1_000_000
  return { deltaPct: round(((simulatedCost - reviewCny) / reviewCny) * 100), simulated: true }
}

/**
 * D4 判定（DEV-PLAN §17）：费用增加 <20%，且阻断代理指标改善
 * （接受率不降、漏报代理下降）才推荐默认 prefer。
 * 任何一组样本缺失 → 不推荐，记录原因。
 */
export function decideHeteroDefault(input: {
  reports: number
  blocking: { acceptanceRate: number | null }
  cost: { heteroDeltaPct: number | null }
  cohorts: { sameProvider: CalibrationCohort; heteroProvider: CalibrationCohort }
}): CalibrationDecision {
  const reasons: string[] = []
  let ok = true

  if (input.cost.heteroDeltaPct === null) {
    ok = false
    reasons.push('费用差无法估算（第二家未定价或没有审批用量）')
  } else if (input.cost.heteroDeltaPct >= 20) {
    ok = false
    reasons.push(`费用增加 ${input.cost.heteroDeltaPct.toFixed(1)}% ≥ 20%`)
  } else {
    reasons.push(`费用增加 ${input.cost.heteroDeltaPct.toFixed(1)}% < 20%`)
  }

  const same = input.cohorts.sameProvider
  const hetero = input.cohorts.heteroProvider
  if (same.reports === 0 || hetero.reports === 0) {
    ok = false
    reasons.push('同家 / 异构两组样本不齐，无法做对照')
  } else if (
    same.blocking.acceptanceRate === null ||
    hetero.blocking.acceptanceRate === null
  ) {
    ok = false
    reasons.push('任一组没有作者决策的阻断样本')
  } else if (hetero.blocking.acceptanceRate < same.blocking.acceptanceRate) {
    ok = false
    reasons.push('异构组阻断接受率低于同家组')
  } else {
    reasons.push('异构组阻断接受率不低于同家组')
  }

  if (same.blockingPerReport !== null && hetero.blockingPerReport !== null) {
    if (hetero.blockingPerReport <= same.blockingPerReport) {
      ok = false
      reasons.push('异构组每份报告的阻断数没有增加（漏报代理未改善）')
    } else {
      reasons.push('异构组每份报告的阻断数增加（漏报代理改善）')
    }
  }

  return { recommended: ok ? 'prefer' : 'off', reasons }
}
