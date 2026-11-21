import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * M2 成本基线（PHASE-20 §5.6 / M2-5）。
 *
 *   node scripts/m2-cost-baseline.mjs <项目目录或 noryth.db>
 *
 * 只读打开项目库，输出与 `report.cost` 同口径的 JSON：
 *   - 总费用 / token / 字数 / 每万字；
 *   - 按 Agent（费用或 token 占比）；
 *   - 按章（字数、费用、每万字、P50/P95）；
 *   - 项目级（规划，chapter_id IS NULL）；
 *   - 每拍确认耗时（作者确认）。
 *
 * 不写库、不调模型、不改文档；数字由作者抄进 docs/M2-COST-BASELINE.md。
 * 夹具用假模型（固定 usage + DeepSeek 预设计价），不是报价。
 */

const target = process.argv[2] ?? process.env.NORYTH_PROJECT_DB
if (!target) {
  console.error('用法：node scripts/m2-cost-baseline.mjs <项目目录 | noryth.db>')
  process.exit(2)
}

const resolved = resolve(target)
const dbPath = statSync(resolved).isDirectory() ? join(resolved, 'noryth.db') : resolved

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  console.log(JSON.stringify(baseline(db, dbPath), null, 2))
} finally {
  db.close()
}

function baseline(handle, path) {
  const project = handle.prepare('SELECT id, title, default_preset FROM project LIMIT 1').get()
  if (!project) throw new Error('项目库为空：没有 project 行')

  const aggregates = handle
    .prepare(
      `SELECT chapter_id, agent_key,
              COALESCE(SUM(tokens_in),0) AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(cost_cny),0) AS cost_cny,
              COUNT(*) AS calls,
              COUNT(cost_cny) AS priced_calls
         FROM turn_metric WHERE project_id = ? GROUP BY chapter_id, agent_key`
    )
    .all(project.id)

  const chapters = handle
    .prepare(
      `SELECT c.id, c.ord, COALESCE(o.title, '第 ' || c.ord || ' 章') AS title,
              COALESCE(SUM(b.word_count), 0) AS words
         FROM chapter c
         LEFT JOIN outline_node o ON o.id = c.outline_node_id
         LEFT JOIN revision_beat rb
                ON rb.revision_id = COALESCE(c.final_revision_id, c.current_revision_id)
         LEFT JOIN beat b ON b.id = rb.beat_id
        WHERE c.project_id = ?
        GROUP BY c.id, c.ord, o.title
        ORDER BY c.ord`
    )
    .all(project.id)

  const latencyRows = handle
    .prepare(
      `SELECT chapter_id, agent_key, latency_ms FROM turn_metric
        WHERE project_id = ? AND latency_ms IS NOT NULL`
    )
    .all(project.id)

  const chapterBuckets = new Map()
  const agentBuckets = new Map()
  const projectLevel = { tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0 }
  for (const row of aggregates) {
    const bucket = {
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costCny: row.cost_cny,
      calls: row.calls,
      pricedCalls: row.priced_calls
    }
    if (row.chapter_id !== null) add(chapterBuckets, row.chapter_id, bucket)
    add(agentBuckets, row.agent_key, bucket)
    if (row.chapter_id === null) {
      projectLevel.tokensIn += bucket.tokensIn
      projectLevel.tokensOut += bucket.tokensOut
      projectLevel.costCny += bucket.costCny
      projectLevel.calls += bucket.calls
    }
  }

  const byChapter = chapters.map((chapter) => {
    const bucket = chapterBuckets.get(chapter.id) ?? empty()
    const latency = latencyOf(latenciesFor(latencyRows, (row) => row.chapter_id === chapter.id))
    return {
      chapterId: chapter.id,
      ord: chapter.ord,
      title: chapter.title,
      words: chapter.words,
      tokensIn: bucket.tokensIn,
      tokensOut: bucket.tokensOut,
      costCny: round(bucket.costCny),
      costPer10k: per10k(bucket.costCny, chapter.words),
      calls: bucket.calls,
      unpricedCalls: Math.max(0, bucket.calls - bucket.pricedCalls),
      latencyP50: latency.p50,
      latencyP95: latency.p95
    }
  })

  const total = { tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0, pricedCalls: 0 }
  for (const bucket of agentBuckets.values()) {
    total.tokensIn += bucket.tokensIn
    total.tokensOut += bucket.tokensOut
    total.costCny += bucket.costCny
    total.calls += bucket.calls
    total.pricedCalls += bucket.pricedCalls
  }
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.words, 0)
  const shareBasis = total.costCny > 0 ? 'cost' : 'tokens'
  const byAgent = [...agentBuckets.entries()]
    .map(([agentKey, bucket]) => {
      const latency = latencyOf(latenciesFor(latencyRows, (row) => row.agent_key === agentKey))
      const share =
        shareBasis === 'cost'
          ? total.costCny > 0
            ? bucket.costCny / total.costCny
            : 0
          : total.tokensIn + total.tokensOut > 0
            ? (bucket.tokensIn + bucket.tokensOut) / (total.tokensIn + total.tokensOut)
            : 0
      return {
        agentKey,
        tokensIn: bucket.tokensIn,
        tokensOut: bucket.tokensOut,
        costCny: round(bucket.costCny),
        calls: bucket.calls,
        share: round(share, 4),
        latencyP50: latency.p50,
        latencyP95: latency.p95
      }
    })
    .sort((left, right) => right.costCny - left.costCny || right.calls - left.calls)

  return {
    project: { path, title: project.title, defaultPreset: project.default_preset },
    fixture: {
      chapters: chapters.length,
      beats: handle.prepare('SELECT COUNT(*) AS count FROM beat WHERE status <> ?').get('superseded').count,
      words: totalWords,
      memories: handle.prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE status = 'active'").get().count,
      pricing: 'DeepSeek 预设：¥2 / ¥8 每百万 token（本地估算，以供应商账单为准）'
    },
    total: {
      tokensIn: total.tokensIn,
      tokensOut: total.tokensOut,
      costCny: round(total.costCny),
      pricedCalls: total.pricedCalls,
      unpricedCalls: Math.max(0, total.calls - total.pricedCalls),
      words: totalWords,
      costPer10k: per10k(total.costCny, totalWords)
    },
    projectLevel: {
      tokensIn: projectLevel.tokensIn,
      tokensOut: projectLevel.tokensOut,
      costCny: round(projectLevel.costCny),
      calls: projectLevel.calls
    },
    byAgent,
    byChapter,
    confirm: confirmLatency(handle, project.id),
    generatedAt: new Date().toISOString()
  }
}

function add(map, key, bucket) {
  const existing = map.get(key) ?? empty()
  existing.tokensIn += bucket.tokensIn
  existing.tokensOut += bucket.tokensOut
  existing.costCny += bucket.costCny
  existing.calls += bucket.calls
  existing.pricedCalls += bucket.pricedCalls
  map.set(key, existing)
}

function empty() {
  return { tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0, pricedCalls: 0 }
}

function latenciesFor(rows, predicate) {
  return rows.filter(predicate).map((row) => row.latency_ms)
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return Math.round(sorted[0])
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return Math.round(sorted[lower])
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower))
}

function latencyOf(values) {
  return { p50: percentile(values, 0.5), p95: values.length >= 5 ? percentile(values, 0.95) : null }
}

function confirmLatency(handle, projectId) {
  const rows = handle
    .prepare(
      `SELECT kind, payload_json AS payload, created_at AS createdAt FROM scheduler_event
        WHERE project_id = ? AND kind IN ('beat_committed','beat_confirmed')
        ORDER BY created_at`
    )
    .all(projectId)
  const committed = new Map()
  const confirmed = new Map()
  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = {}
    }
    if (typeof payload.beatId !== 'string') continue
    const at = Date.parse(row.createdAt)
    if (Number.isNaN(at)) continue
    if (row.kind === 'beat_committed' && !committed.has(payload.beatId)) committed.set(payload.beatId, at)
    if (row.kind === 'beat_confirmed' && !confirmed.has(payload.beatId)) confirmed.set(payload.beatId, at)
  }
  const durations = []
  let missing = 0
  for (const [beatId, at] of committed) {
    const end = confirmed.get(beatId)
    if (end === undefined || end < at) {
      missing += 1
      continue
    }
    durations.push(end - at)
  }
  const latency = latencyOf(durations)
  return { samples: durations.length, p50: latency.p50, p95: latency.p95, missingBeats: missing }
}

function per10k(cost, words) {
  return words > 0 ? round((cost / words) * 10_000) : null
}

function round(value, digits = 6) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
