import { afterEach, describe, expect, it } from 'vitest'
import { buildCalibrationReport, decideHeteroDefault } from '../../../src/main/review/calibration'
import { openReviewWorld, type ReviewTestWorld } from '../../support/review-world'

/**
 * 异构校准（PHASE-21 §5.4 / M2-8）。
 *
 * 代理指标口径：报告的每条 issue 按 `(revision_id, issue_ref)` 找 patch 决策；
 * 没有作者决策不进分母；费用只从 turn_metric 汇总。
 */

const worlds: ReviewTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.world.cleanup()
})

function open(): ReviewTestWorld {
  const world = openReviewWorld()
  worlds.push(world)
  return world
}

function issue(issueId: string, type: string) {
  return {
    issue_id: issueId,
    type,
    beat_id: 'b1',
    evidence: '原文',
    why: '理由',
    suggestion: '',
    downgraded: null
  }
}

function metric(
  world: ReviewTestWorld,
  input: {
    turnId: string
    agentKey: string
    provider: string
    tokensIn: number
    tokensOut: number
    costCny: number | null
    beatId?: string | null
  }
): void {
  world.world.repos.turnMetric.insert({
    turnId: input.turnId,
    projectId: world.world.projectId,
    jobId: `job_${input.turnId}`,
    beatId: input.beatId ?? null,
    chapterId: world.world.chapterId,
    agentKey: input.agentKey,
    provider: input.provider,
    model: 'm',
    bindingVersion: 1,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    costCny: input.costCny,
    latencyMs: 10,
    firstTokenMs: 5,
    contextJson: '{}'
  })
}

describe('buildCalibrationReport', () => {
  it('同家 / 异构两组、阻断接受率、维度均值与费用；第二家未定价时 delta=null', () => {
    const w = open()
    const repos = w.world.repos
    const chapter = repos.chapter.get(w.world.chapterId)!
    const revisionId = chapter.currentRevisionId!
    const projectId = w.world.projectId

    metric(w, {
      turnId: 't_gen',
      agentKey: 'character',
      provider: 'deepseek',
      tokensIn: 1_000,
      tokensOut: 100,
      costCny: 0.0028,
      beatId: repos.beat.listLiveByChapter(w.world.chapterId)[0]?.id ?? null
    })
    metric(w, { turnId: 't_rev_1', agentKey: 'reviewer', provider: 'deepseek', tokensIn: 2_000, tokensOut: 200, costCny: 0.0056 })
    metric(w, { turnId: 't_rev_2', agentKey: 'reviewer', provider: 'openai', tokensIn: 2_000, tokensOut: 200, costCny: 0.0056 })

    repos.review.insertReport({
      projectId,
      chapterId: chapter.id,
      revisionId,
      round: 1,
      verdict: 'fail',
      provider: 'deepseek',
      model: 'deepseek-flash',
      blockingJson: JSON.stringify([issue('iss_01', 'timeline'), issue('iss_02', 'knowledge_leak')]),
      suggestionsJson: JSON.stringify([issue('iss_03', 'prose')]),
      dimensionsJson: JSON.stringify({
        character_consistency: 4,
        plot_logic: 3,
        outline_alignment: null,
        prose: 2
      })
    })
    repos.review.insertReport({
      projectId,
      chapterId: chapter.id,
      revisionId,
      round: 2,
      verdict: 'fail',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      blockingJson: JSON.stringify([issue('iss_11', 'timeline'), issue('iss_12', 'outline_conflict')]),
      suggestionsJson: JSON.stringify([issue('iss_13', 'voice')]),
      dimensionsJson: JSON.stringify({
        character_consistency: 5,
        plot_logic: 4,
        outline_alignment: 3,
        prose: null
      })
    })

    const beatId = repos.beat.listLiveByChapter(w.world.chapterId)[0]!.id
    const patch = (issueRef: string, status: 'applied' | 'rejected') =>
      repos.patch.insert({
        projectId,
        proposalId: `prop_${issueRef}`,
        revisionId,
        beatId,
        before: '旧句',
        after: '新句',
        reason: '理由',
        issueRef,
        status
      })
    patch('iss_01', 'applied')
    patch('iss_03', 'rejected')
    patch('iss_11', 'rejected')
    patch('iss_13', 'applied')

    const report = buildCalibrationReport(repos, projectId, { now: () => new Date('2026-11-21T00:00:00.000Z') })
    expect(report.reports).toBe(2)
    expect(report.blocking.total).toBe(4)
    expect(report.blocking.accepted).toBe(1)
    expect(report.blocking.rejected).toBe(1)
    expect(report.blocking.acceptanceRate).toBeCloseTo(0.5)
    expect(report.suggestions.total).toBe(2)
    expect(report.suggestions.accepted).toBe(1)
    expect(report.suggestions.rejected).toBe(1)
    expect(report.suggestions.acceptanceRate).toBe(0.5)
    expect(report.cohorts.sameProvider.reports).toBe(1)
    expect(report.cohorts.heteroProvider.reports).toBe(1)
    expect(report.cohorts.sameProvider.blocking.total).toBe(2)
    expect(report.cohorts.heteroProvider.blocking.total).toBe(2)
    expect(report.cohorts.sameProvider.blockingPerReport).toBe(2)
    expect(report.cohorts.heteroProvider.blockingPerReport).toBe(2)

    const plot = report.byDimension.find((row) => row.dimension === 'plot_logic')!
    expect(plot.meanScore).toBe(3.5)
    expect(plot.samples).toBe(2)
    expect(report.byDimension.find((row) => row.dimension === 'outline_alignment')?.meanScore).toBe(3)
    expect(report.byDimension.find((row) => row.dimension === 'outline_alignment')?.samples).toBe(1)

    expect(report.cost.reviewCny).toBeCloseTo(0.0112)
    expect(report.cost.generationCny).toBeCloseTo(0.0028)
    expect(report.cost.heteroDeltaPct).toBeNull()
    expect(report.decision.recommended).toBe('off')
    expect(report.decision.reasons.join('｜')).toContain('费用差无法估算')
    expect(report.limitations.join('｜')).toContain('代理指标')
    expect(report.generatedAt).toBe('2026-11-21T00:00:00.000Z')
  })

  it('没有报告时不给默认开启建议', () => {
    const w = open()
    const report = buildCalibrationReport(w.world.repos, w.world.projectId)
    expect(report.reports).toBe(0)
    expect(report.blocking.acceptanceRate).toBeNull()
    expect(report.decision.recommended).toBe('off')
    expect(report.decision.reasons.length).toBeGreaterThan(0)
  })
})

describe('decideHeteroDefault（D4）', () => {
  const cohort = (input: {
    reports: number
    total: number
    accepted: number
    rejected: number
  }) => ({
    reports: input.reports,
    blocking: {
      total: input.total,
      accepted: input.accepted,
      rejected: input.rejected,
      acceptanceRate: input.accepted + input.rejected === 0 ? null : input.accepted / (input.accepted + input.rejected)
    },
    blockingPerReport: input.reports === 0 ? null : input.total / input.reports
  })

  it('费用 <20% 且接受率不降、每份阻断数增加 → prefer', () => {
    const decision = decideHeteroDefault({
      reports: 10,
      blocking: { acceptanceRate: 0.7 },
      cost: { heteroDeltaPct: 12 },
      cohorts: {
        sameProvider: cohort({ reports: 5, total: 5, accepted: 3, rejected: 2 }),
        heteroProvider: cohort({ reports: 5, total: 10, accepted: 5, rejected: 1 })
      }
    })
    expect(decision.recommended).toBe('prefer')
    expect(decision.reasons.join('｜')).toContain('费用增加 12.0%')
  })

  it('费用 ≥20% 或接受率下降或缺样本 → off', () => {
    const expensive = decideHeteroDefault({
      reports: 10,
      blocking: { acceptanceRate: 0.7 },
      cost: { heteroDeltaPct: 20 },
      cohorts: {
        sameProvider: cohort({ reports: 5, total: 5, accepted: 3, rejected: 2 }),
        heteroProvider: cohort({ reports: 5, total: 10, accepted: 5, rejected: 1 })
      }
    })
    expect(expensive.recommended).toBe('off')
    expect(expensive.reasons.join('｜')).toContain('≥ 20%')

    const worse = decideHeteroDefault({
      reports: 10,
      blocking: { acceptanceRate: 0.7 },
      cost: { heteroDeltaPct: 5 },
      cohorts: {
        sameProvider: cohort({ reports: 5, total: 5, accepted: 4, rejected: 1 }),
        heteroProvider: cohort({ reports: 5, total: 10, accepted: 1, rejected: 9 })
      }
    })
    expect(worse.recommended).toBe('off')
    expect(worse.reasons.join('｜')).toContain('接受率低于')

    const missing = decideHeteroDefault({
      reports: 10,
      blocking: { acceptanceRate: 0.7 },
      cost: { heteroDeltaPct: 5 },
      cohorts: {
        sameProvider: cohort({ reports: 5, total: 5, accepted: 3, rejected: 2 }),
        heteroProvider: cohort({ reports: 0, total: 0, accepted: 0, rejected: 0 })
      }
    })
    expect(missing.recommended).toBe('off')
    expect(missing.reasons.join('｜')).toContain('样本不齐')
  })
})
