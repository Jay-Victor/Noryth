import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * M2 质量基线（PHASE-19 §5.5 / M2-1）。
 *
 *   node scripts/m2-baseline.mjs <项目目录或 noryth.db>
 *
 * 只读打开项目库（`readonly`），输出声音区分度与伏笔回收率 JSON：
 *   - 声音：threshold + 场景数 / 角色对数 / 低于阈值数 / 最低一对；
 *     同人误报与异人检出取自校准结果（语料级，不是项目级）。
 *   - 伏笔：planted / closed / open / payoffRate / overdue，复用 M1 标注。
 *
 * 不写库、不调模型、不改文档；数字由作者抄进 docs/M2-METRICS-BASELINE.md。
 */

const target = process.argv[2] ?? process.env.NORYTH_PROJECT_DB
if (!target) {
  console.error('用法：node scripts/m2-baseline.mjs <项目目录 | noryth.db>')
  process.exit(2)
}

const resolved = resolve(target)
const dbPath = statSync(resolved).isDirectory() ? join(resolved, 'noryth.db') : resolved
const calibration = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'voice', 'calibration-result.json'), 'utf8')
)

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  const voice = voiceBaseline(db, calibration)
  const foreshadow = foreshadowBaseline(db)
  console.log(JSON.stringify({ project: dbPath, voice, foreshadow }, null, 2))
} finally {
  db.close()
}

function voiceBaseline(handle, calibrationResult) {
  const rows = handle
    .prepare(
      `SELECT scene_id, revision_id, metrics_json, threshold_version, created_at
       FROM voice_metric
       ORDER BY scene_id, created_at DESC`
    )
    .all()
  // 同一场景可能有多版；只取最新一行，避免旧 revision 重复计数。
  const latest = new Map()
  for (const row of rows) {
    if (!latest.has(row.scene_id)) latest.set(row.scene_id, row)
  }
  const scenes = [...latest.values()].map((row) => {
    try {
      return { ...row, metrics: JSON.parse(row.metrics_json) }
    } catch {
      return { ...row, metrics: null }
    }
  })
  const usable = scenes.filter((scene) => scene.metrics !== null && !scene.metrics.insufficientData)
  const threshold = {
    version: calibrationResult.version,
    distinctnessMin: calibrationResult.threshold
  }
  const pairs = usable.flatMap((scene) =>
    (scene.metrics.pairs ?? []).map((pair) => ({
      scene: scene.scene_id,
      a: pair.aName,
      b: pair.bName,
      score: pair.score
    }))
  )
  const below = usable.filter(
    (scene) => scene.metrics.aggregate.pairwiseDistinctness < threshold.distinctnessMin
  )
  const minPair = pairs.length === 0 ? null : pairs.reduce((min, pair) => (pair.score < min.score ? pair : min))
  return {
    threshold,
    scenes: latest.size,
    scenesWithMetrics: usable.length,
    insufficient: latest.size - usable.length,
    pairs: pairs.length,
    belowThreshold: below.length,
    minPair,
    sameCharacterFalseAlarm: calibrationResult.sameCharacterFalseAlarm,
    differentCharacterDetection: calibrationResult.differentCharacterDetection,
    calibration: {
      corpus: calibrationResult.corpus,
      corpusHash: calibrationResult.corpusHash,
      calibratedAt: calibrationResult.calibratedAt,
      note: '误报/检出是夹具语料级指标，不是本项目的准确率'
    }
  }
}

function foreshadowBaseline(handle) {
  const counts = handle
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
         COUNT(*) AS planted
       FROM foreshadow`
    )
    .get()
  const maxChapter = handle.prepare('SELECT COALESCE(MAX(ord), 0) AS ord FROM chapter').get()
  const overdue = handle
    .prepare(
      `SELECT COUNT(*) AS count
       FROM foreshadow f
       JOIN chapter c ON c.id = f.planned_payoff_chapter_id
       WHERE f.status = 'open' AND c.ord <= ?`
    )
    .get(maxChapter.ord)
  const closed = Number(counts.closed ?? 0)
  const open = Number(counts.open ?? 0)
  const planted = Number(counts.planted ?? 0)
  return {
    planted,
    closed,
    open,
    payoffRate: planted === 0 ? 0 : round3(closed / (open + closed)),
    overdue: Number(overdue.count ?? 0)
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}
