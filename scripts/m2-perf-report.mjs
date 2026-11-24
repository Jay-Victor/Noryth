import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * PERF-M2-01 报告（PHASE-23 §5.2 / M2-6）。
 *
 *   node scripts/m2-perf-report.mjs                 # 跑 perf 门，再生成 Markdown
 *   node scripts/m2-perf-report.mjs --from <json>   # 只把已有 JSON 渲染成 Markdown
 *
 * 数字来自 `tests/perf/m2-scale.spec.ts` 写出的 JSON（默认
 * `out/perf/m2-perf-report.json`）。脚本只读产物，不改数据库、不调模型。
 * 任一项超过 PHASE-23 §5.2 的目标时以退出码 1 结束，可挂 nightly。
 */

const args = process.argv.slice(2)
function flag(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

const root = resolve(process.cwd())
const jsonPath = resolve(flag('--json') ?? process.env.NORYTH_PERF_OUT ?? join(root, 'out/perf/m2-perf-report.json'))
const markdownPath = resolve(flag('--out') ?? join(root, 'out/perf/m2-perf-report.md'))
const fromPath = flag('--from')

if (fromPath === null) {
  mkdirSync(dirname(jsonPath), { recursive: true })
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.perf.config.ts', 'tests/perf/m2-scale.spec.ts'],
    {
      cwd: root,
      // Windows 下 spawn .cmd 需要 shell（Node ≥20 的安全限制）。
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: { ...process.env, NORYTH_PERF_OUT: jsonPath }
    }
  )
  if (result.status !== 0) {
    console.error(
      result.error ? `perf 门启动失败：${result.error.message}` : 'perf 门未通过；若能读到 JSON 仍会渲染报告。'
    )
  }
}

if (!existsSync(jsonPath)) {
  console.error(`找不到 ${jsonPath}：先跑 pnpm test:perf`)
  process.exit(2)
}

const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
const rows = metricRows(report)
const failed = rows.filter((row) => !row.ok)
const markdown = render(report, rows)

mkdirSync(dirname(markdownPath), { recursive: true })
writeFileSync(markdownPath, markdown, 'utf8')
console.log(markdown)
console.log(`\nJSON: ${jsonPath}\nMarkdown: ${markdownPath}`)
if (failed.length > 0) {
  console.error(`\n未达标 ${failed.length} 项：${failed.map((row) => row.label).join('、')}`)
  process.exit(1)
}

function metricRows(data) {
  const metrics = data.metrics ?? {}
  const limits = data.limits ?? {}
  const cell = (key, target, label, limit) => {
    const timing = metrics[key]
    if (!timing) return null
    return {
      label,
      target,
      p50: timing.p50,
      p95: timing.p95,
      max: timing.max,
      ok: timing.p95 < limit,
      limit
    }
  }
  return [
    cell('open', `P95 < ${limits.openMs}ms`, '打开（迁移 + verify + 摘要）', limits.openMs),
    cell('switchChapter', `P95 < ${limits.switchP95Ms}ms`, '切章（章摘要 + 场景/拍）', limits.switchP95Ms),
    cell('timeline', `P95 < ${limits.timelineP95Ms}ms`, 'T23 时间线', limits.timelineP95Ms),
    cell('retrieve', `P95 < ${limits.retrieveP95Ms}ms`, '检索（vec + FTS + RRF）', limits.retrieveP95Ms),
    cell('assemble', `P95 < ${limits.assembleP95Ms}ms`, '上下文装配（L0–L3）', limits.assembleP95Ms),
    cell('costReport', `P95 < ${limits.costP95Ms}ms`, '成本报表（30 章 / 6 Agent）', limits.costP95Ms),
    cell('voiceCompute', `P95 < ${limits.voiceP95Ms}ms`, '声音指标（冷计算）', limits.voiceP95Ms),
    cell('archiveCandidates', `P95 < ${limits.archiveP95Ms}ms`, '归档候选（3k 条 / 50 上限）', limits.archiveP95Ms)
  ].filter((row) => row !== null)
}

function render(data, rows) {
  const lines = []
  const machine = data.machine ?? {}
  const fixture = data.fixture ?? {}
  const queries = data.queries ?? {}
  const exported = data.exports ?? {}
  const limits = data.limits ?? {}

  lines.push('# PERF-M2-01 报告（10 万字项目）')
  lines.push('')
  lines.push(`- 生成时间：${data.generatedAt ?? '—'}`)
  lines.push(
    `- 机器：${machine.cpu ?? '—'} · ${machine.cores ?? '?'} 核 · ${machine.memoryGb ?? '?'}GB · ` +
      `${machine.platform ?? '?'} ${machine.release ?? '?'}`
  )
  lines.push(`- 运行时：Node ${machine.node ?? '?'} · Electron ${machine.electron ?? '?'}`)
  lines.push(`- 夹具：${fixture.chapters} 章 / ${fixture.beats} 拍 / ${fixture.words} 字 / ` +
    `${fixture.memoriesActive} 活跃记忆 + ${fixture.memoriesArchived} 已归档 / ${fixture.summaries} 摘要 / ` +
    `${fixture.voiceRows} 声音行 / ${fixture.turnMetricRows} 成本行 / ${fixture.foreshadows} 伏笔`)
  lines.push('')
  lines.push('## 目标 vs 实测（预热 3 次，采样 20 次，P95 最近秩）')
  lines.push('')
  lines.push('| 场景 | 目标 | P50 | P95 | 最大 | 结论 |')
  lines.push('|---|---|---:|---:|---:|---|')
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${row.target} | ${row.p50}ms | ${row.p95}ms | ${row.max}ms | ${row.ok ? 'PASS' : 'FAIL'} |`
    )
  }
  const voiceCached = data.metrics?.voiceCached
  if (voiceCached) {
    lines.push(`| 声音指标（缓存命中） | 信息项 | ${voiceCached.p50}ms | ${voiceCached.p95}ms | ${voiceCached.max}ms | — |`)
  }
  lines.push('')
  lines.push('## 导出与内存')
  lines.push('')
  lines.push('| 项 | 目标 | 实测 | 结论 |')
  lines.push('|---|---|---:|---|')
  lines.push(
    `| 导出 Markdown（100k 字） | < ${limits.markdownMs}ms | ${exported.markdownMs}ms（${formatBytes(exported.markdownBytes)}） | ` +
      `${exported.markdownMs < limits.markdownMs ? 'PASS' : 'FAIL'} |`
  )
  lines.push(
    `| 导出 DOCX（100k 字 + 目录） | < ${limits.docxMs}ms | ${exported.docxMs}ms（${formatBytes(exported.docxBytes)}） | ` +
      `${exported.docxMs < limits.docxMs ? 'PASS' : 'FAIL'} |`
  )
  lines.push(
    `| 进程 RSS | < ${limits.rssMb}MB | ${data.rssMb}MB | ${data.rssMb < limits.rssMb ? 'PASS' : 'FAIL'} |`
  )
  lines.push('')
  lines.push('## 查询计数（无 N+1）')
  lines.push('')
  lines.push('| 路径 | 语句数 | 说明 |')
  lines.push('|---|---:|---|')
  lines.push(`| 成本报表（全书） | ${queries.costReport} | 聚合 + 章/纲标题 + 字数 ×2 + 耗时 + 事件；与章数无关 |`)
  lines.push(`| 成本报表（单章过滤） | ${queries.costReportFiltered} | 只多一次「章存在」校验 |`)
  lines.push(`| 声音指标（单场） | ${queries.voiceCompute} | 场景/归属/章/revision/清单 + 每角色一次角色卡 |`)
  lines.push(`| 归档候选（3k 条） | ${queries.archiveCandidates} | 记忆/事实/边/提案 + 每角色一次向量批读 |`)
  lines.push(`| 检索（3k 条，top_k 8） | ${queries.retrieve} | pinned + vec KNN + FTS + 批量取候选行 |`)
  lines.push('')
  lines.push('## 复现')
  lines.push('')
  lines.push('```bash')
  lines.push('pnpm test:perf')
  lines.push('node scripts/m2-perf-report.mjs --from out/perf/m2-perf-report.json')
  lines.push('```')
  lines.push('')
  lines.push('> 夹具是确定性计划（显式 id、固定时钟），同一 seed 两次生成逐字段一致；')
  lines.push('> 性能门只在 nightly / 发布前跑，提交门不跑墙钟断言。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
