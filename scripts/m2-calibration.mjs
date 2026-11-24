import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * 异构复检校准（PHASE-21 §5.4 / M2-8）。
 *
 *   node scripts/m2-calibration.mjs <项目目录或 noryth.db>
 *
 * 只读 `approval_report` / `patch` / `gate_record` / `turn_metric`，输出与
 * `review.calibration` 同口径的 JSON：
 *   - reports / blocking / suggestions 的代理接受率；
 *   - byDimension（均值、接受组均值、拒绝组均值、样本数）；
 *   - cost（审批 / 生成费用；第二家未定价时 heteroDeltaPct=null）；
 *   - cohorts（同家 / 异构对照）与 D4 建议。
 *
 * 不写库、不调模型、不改文档；数字由作者抄进 docs/M2-HETERO-CALIBRATION.md。
 * 阻断接受率是 patch 决策的代理指标，不是人工标注召回率。
 */

const target = process.argv[2] ?? process.env.NORYTH_PROJECT_DB
if (!target) {
  console.error('用法：node scripts/m2-calibration.mjs <项目目录 | noryth.db>')
  process.exit(2)
}

const resolved = resolve(target)
const dbPath = statSync(resolved).isDirectory() ? join(resolved, 'noryth.db') : resolved

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  console.log(JSON.stringify(calibrate(db), null, 2))
} finally {
  db.close()
}

function calibrate(handle) {
  const project = handle.prepare('SELECT id, title, default_preset FROM project LIMIT 1').get()
  if (!project) throw new Error('项目库为空：没有 project 行')

  const reports = handle
    .prepare('SELECT * FROM approval_report WHERE project_id = ? ORDER BY created_at')
    .all(project.id)
  const patches = handle.prepare('SELECT * FROM patch WHERE project_id = ? ORDER BY created_at').all(project.id)

  const decisionByRevision = new Map()
  for (const patch of patches) {
    const byIssue = decisionByRevision.get(patch.revision_id) ?? new Map()
    const next =
      patch.status === 'applied' || patch.status === 'accepted'
        ? 'accepted'
        : patch.status === 'rejected'
          ? 'rejected'
          : 'pending'
    const current = byIssue.get(patch.issue_ref)
    if (
      current === undefined ||
      (current === 'pending' && next !== 'pending') ||
      (current === 'rejected' && next === 'accepted')
    ) {
      byIssue.set(patch.issue_ref, next)
    }
    decisionByRevision.set(patch.revision_id, byIssue)
  }

  const generationProvider = (chapterId) => {
    const chapter = handle.prepare('SELECT current_revision_id, final_revision_id FROM chapter WHERE id = ?').get(chapterId)
    const revisionId = chapter?.current_revision_id ?? chapter?.final_revision_id ?? null
    if (!revisionId) return project.default_preset
    const row = handle
      .prepare(
        `SELECT tm.provider FROM turn_metric tm
           JOIN revision_beat rb ON rb.beat_id = tm.beat_id
          WHERE rb.revision_id = ? AND tm.beat_id IS NOT NULL
          ORDER BY tm.created_at DESC LIMIT 1`
      )
      .get(revisionId)
    return row?.provider ?? project.default_preset
  }

  const emptyCohort = () => ({
    reports: 0,
    blocking: { total: 0, accepted: 0, rejected: 0, acceptanceRate: null },
    blockingPerReport: null
  })
  const cohorts = { sameProvider: emptyCohort(), heteroProvider: emptyCohort() }
  const blocking = { total: 0, accepted: 0, rejected: 0 }
  const suggestions = { total: 0, accepted: 0, rejected: 0 }
  const dimensions = new Map()
  const dimensionKeys = ['character_consistency', 'plot_logic', 'outline_alignment', 'prose']
  for (const key of dimensionKeys) {
    dimensions.set(key, {
      sum: 0,
      samples: 0,
      acceptedSum: 0,
      acceptedCount: 0,
      rejectedSum: 0,
      rejectedCount: 0
    })
  }

  for (const report of reports) {
    const blockingIssues = parseArray(report.blocking_json)
    const suggestionIssues = parseArray(report.suggestions_json)
    const scores = parseObject(report.dimensions_json)
    const generation = generationProvider(report.chapter_id)
    const cohort =
      report.provider === null || report.provider === undefined
        ? null
        : report.provider === generation
          ? 'sameProvider'
          : 'heteroProvider'
    if (cohort !== null) cohorts[cohort].reports += 1
    const byIssue = decisionByRevision.get(report.revision_id) ?? new Map()
    const decisionOf = (issueId) => {
      const value = byIssue.get(issueId)
      return value === 'accepted' || value === 'rejected' ? value : null
    }

    for (const issue of blockingIssues) {
      blocking.total += 1
      if (cohort !== null) cohorts[cohort].blocking.total += 1
      const decision = decisionOf(issue.issue_id)
      if (decision === 'accepted') {
        blocking.accepted += 1
        if (cohort !== null) cohorts[cohort].blocking.accepted += 1
      } else if (decision === 'rejected') {
        blocking.rejected += 1
        if (cohort !== null) cohorts[cohort].blocking.rejected += 1
      }
    }
    for (const issue of suggestionIssues) {
      suggestions.total += 1
      const decision = decisionOf(issue.issue_id)
      if (decision === 'accepted') suggestions.accepted += 1
      else if (decision === 'rejected') suggestions.rejected += 1
    }

    for (const key of dimensionKeys) {
      const score = scores[key]
      if (typeof score !== 'number' || !Number.isFinite(score)) continue
      const stats = dimensions.get(key)
      stats.sum += score
      stats.samples += 1
      let accepted = false
      let rejected = false
      for (const issue of [...blockingIssues, ...suggestionIssues]) {
        if (!(issueDimensions(issue.type) ?? []).includes(key)) continue
        const decision = decisionOf(issue.issue_id)
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

  for (const cohort of Object.values(cohorts)) {
    const decided = cohort.blocking.accepted + cohort.blocking.rejected
    cohort.blocking.acceptanceRate = decided === 0 ? null : cohort.blocking.accepted / decided
    cohort.blockingPerReport = cohort.reports === 0 ? null : cohort.blocking.total / cohort.reports
  }

  const byDimension = dimensionKeys.map((key) => {
    const stats = dimensions.get(key)
    return {
      dimension: key,
      meanScore: stats.samples === 0 ? null : round(stats.sum / stats.samples),
      acceptedMean: stats.acceptedCount === 0 ? null : round(stats.acceptedSum / stats.acceptedCount),
      rejectedMean: stats.rejectedCount === 0 ? null : round(stats.rejectedSum / stats.rejectedCount),
      samples: stats.samples
    }
  })

  const costRows = handle
    .prepare(
      `SELECT agent_key,
              COALESCE(SUM(cost_cny), 0) AS cost_cny,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out
         FROM turn_metric WHERE project_id = ? GROUP BY agent_key`
    )
    .all(project.id)
  let reviewCny = 0
  let generationCny = 0
  let reviewTokensIn = 0
  let reviewTokensOut = 0
  for (const row of costRows) {
    if (row.agent_key === 'reviewer') {
      reviewCny += row.cost_cny
      reviewTokensIn += row.tokens_in
      reviewTokensOut += row.tokens_out
    } else if (row.agent_key === 'character' || row.agent_key === 'narrator') {
      generationCny += row.cost_cny
    }
  }
  const delta = simulateDelta(project.default_preset, reviewCny, reviewTokensIn, reviewTokensOut)

  const finalized = handle
    .prepare("SELECT COUNT(DISTINCT entity_id) AS count FROM gate_record WHERE project_id = ? AND gate_id = 'G6' AND decision = 'approve'")
    .get(project.id)

  const limitations = [
    '阻断接受率来自作者对 patch 的决策，是代理指标，不是人工标注的召回率。',
    '费用取自 turn_metric 的预设计价，不是供应商账单；假模型 usage 不是报价。',
    '没有作者决策的报告不计入分母；被拒绝的建议不视为「漏报」。'
  ]
  if (delta.simulated) {
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

  const summary = {
    reports: reports.length,
    blocking: {
      total: blocking.total,
      accepted: blocking.accepted,
      rejected: blocking.rejected,
      acceptanceRate:
        blocking.accepted + blocking.rejected === 0 ? null : blocking.accepted / (blocking.accepted + blocking.rejected)
    },
    suggestions: {
      total: suggestions.total,
      accepted: suggestions.accepted,
      rejected: suggestions.rejected,
      acceptanceRate:
        suggestions.accepted + suggestions.rejected === 0
          ? null
          : suggestions.accepted / (suggestions.accepted + suggestions.rejected)
    },
    byDimension,
    cost: { reviewCny: round(reviewCny), generationCny: round(generationCny), heteroDeltaPct: delta.value },
    cohorts,
    finalizedChapters: finalized?.count ?? 0,
    limitations
  }
  return {
    ...summary,
    decision: decide(summary),
    generatedAt: new Date().toISOString()
  }
}

function parseArray(json) {
  try {
    const value = JSON.parse(json ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function parseObject(json) {
  try {
    const value = JSON.parse(json ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function issueDimensions(type) {
  return {
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
    other: ['character_consistency', 'plot_logic', 'outline_alignment', 'prose']
  }[type]
}

/** 与 src/main/model/presets.ts 保持同一张价目表；未核实的家保持 0（不假装精确）。 */
function pricingOf(preset) {
  if (preset === 'deepseek') return { in: 2, out: 8 }
  return { in: 0, out: 0 }
}

function simulateDelta(primaryPreset, reviewCny, tokensIn, tokensOut) {
  if (reviewCny <= 0 || (tokensIn === 0 && tokensOut === 0)) return { value: null, simulated: false }
  const alternatives = ['deepseek', 'openai', 'tongyi'].filter((preset) => preset !== primaryPreset)
  for (const preset of alternatives) {
    const price = pricingOf(preset)
    if (price.in <= 0 && price.out <= 0) continue
    const simulatedCost = (tokensIn * price.in + tokensOut * price.out) / 1_000_000
    return { value: round(((simulatedCost - reviewCny) / reviewCny) * 100), simulated: true }
  }
  return { value: null, simulated: false }
}

function decide(report) {
  const reasons = []
  let ok = true
  if (report.cost.heteroDeltaPct === null) {
    ok = false
    reasons.push('费用差无法估算（第二家未定价或没有审批用量）')
  } else if (report.cost.heteroDeltaPct >= 20) {
    ok = false
    reasons.push(`费用增加 ${report.cost.heteroDeltaPct.toFixed(1)}% ≥ 20%`)
  } else {
    reasons.push(`费用增加 ${report.cost.heteroDeltaPct.toFixed(1)}% < 20%`)
  }
  const same = report.cohorts.sameProvider
  const hetero = report.cohorts.heteroProvider
  if (same.reports === 0 || hetero.reports === 0) {
    ok = false
    reasons.push('同家 / 异构两组样本不齐，无法做对照')
  } else if (same.blocking.acceptanceRate === null || hetero.blocking.acceptanceRate === null) {
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

function round(value) {
  return Math.round(value * 10_000) / 10_000
}
