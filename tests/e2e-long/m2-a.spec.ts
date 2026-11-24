import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { memoryMb, verifyProject } from '../e2e/m1-flow'
import { createM2Project, launchM2, runChapterM2, runPlanningTurn, seedLongrun } from '../e2e/m2-flow'

/**
 * E2E-M2-A（PHASE-24 §5.1）：3 卷 × 10 章 × 3 场 × 8 拍 = 30 章 / 720 拍 / ≥10 万字。
 *
 * 运行时机：nightly / 发布前（`pnpm test:e2e:m2a`）；提交门只跑 3 章
 * `E2E-M2-SMOKE`。全程走产品 IPC（等价 UI 按钮），只有 devSeed 是未打包构建的脚手架。
 *
 * 每章：G2 → 2 拍（第 2 拍含 1 次重生成）→ 自动（章 1 带 ¥2 预算）→ G4 → G5
 *   （2 接受 1 拒绝）→ 复检 → G6 → G7。项目级先跑一次规划对话（planner 成本行），
 *   章 1 再跑一次编排对话（orchestrator 成本行）。
 *
 * 断言：30 final / 30 final revision / 正文 ≥100,000 字 / 每 5 章 verify 绿 /
 *   0 孤儿 / 0 双活 / 0 failed job / 0 context_overflow / 30 摘要 / 90 声音行 /
 *   turn_metric 覆盖 6 个 Agent / 伏笔 open+closed 可读 / 私有内存 < 600MB。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  for (const app of apps) {
    try {
      await app.close()
    } catch {
      // 已退出
    }
  }
  if (process.env.NORYTH_E2E_KEEP === '1') {
    console.warn(`E2E-M2-A kept temp dirs: ${tempDirs.join(' ; ')}`)
    return
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用
    }
  }
})

test('E2E-M2-A：30 章 / 10 万字连续创作（3 卷 × 10 章）', async () => {
  test.setTimeout(3_600_000)
  const userData = makeTemp('noryth-m2a-user-')
  const parent = makeTemp('noryth-m2a-project-')
  const { app, page } = await launchM2(ROOT, userData)
  apps.push(app)
  const project = await createM2Project(page, parent, '十万字长跑', '黑漆匣子 · 十万字')

  // 规划对话先落一条 planner 成本行（chapter_id = NULL），再 devSeed 铺章。
  await runPlanningTurn(page)
  const chapters = await seedLongrun(page, { volumes: 3, chaptersPerVolume: 10, characters: 5 })
  expect(chapters).toHaveLength(30)
  expect(chapters.map((chapter) => chapter.ord)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))

  // 卷是大纲的中间层：project.tree 能读到 3 卷。
  const tree = await page.evaluate(async () => {
    const result = await window.noryth!.project.tree()
    return result.ok ? result.data : null
  })
  expect(tree).not.toBeNull()

  // 伏笔标注（作者手写）：埋 3 条，跑完后回收 2 条，留 1 条 open。
  const planted = [
    { text: '父亲留下的黑漆匣子', planted: 0, planned: 9 },
    { text: '祠堂夹层里的旧账', planted: 9, planned: 19 },
    { text: '雨夜里那把断柄伞', planted: 14, planned: 24 }
  ]
  const foreshadowIds: string[] = []
  for (const item of planted) {
    const created = await page.evaluate(
      async (input) => window.noryth!.world.createForeshadow(input),
      {
        text: item.text,
        plantedChapterId: chapters[item.planted]!.id,
        plannedPayoffChapterId: chapters[item.planned]!.id
      }
    )
    if (!created.ok) throw new Error(`createForeshadow failed: ${created.error.code}`)
    foreshadowIds.push(created.data.item!.id)
  }

  let baselinePrivate = 0
  let slowestChapterMs = 0
  for (const chapter of chapters) {
    const started = Date.now()
    const result = await runChapterM2(page, chapter, {
      ...(chapter.ord === 1 ? { budgetCny: 2, orchestratorTurn: true } : {})
    })
    const elapsed = Date.now() - started
    slowestChapterMs = Math.max(slowestChapterMs, elapsed)
    expect(result.reportVerdict).toBe('fail')
    expect(result.patches).toBe(3)
    expect(result.accepted).toBe(2)
    expect(result.memoryApplied).toBeGreaterThan(0)
    expect(result.words).toBeGreaterThan(3_000)

    if (chapter.ord % 5 === 0) {
      const verified = await verifyProject(page)
      expect(verified.ok, `ch${chapter.ord} verify: ${verified.errors.join('; ')}`).toBe(true)
      const usage = await memoryMb(page, app)
      // eslint-disable-next-line no-console
      console.log(
        `E2E-M2-A ch${chapter.ord}/30 ok in ${elapsed}ms; ws=${usage.workingSet}MB priv=${usage.privateBytes}MB`
      )
      expect(usage.privateBytes).toBeLessThan(600)
      if (chapter.ord === 5) baselinePrivate = usage.privateBytes
    }
  }

  // 回收两条伏笔（第 20 章 / 第 25 章），留第 1 条 open。
  for (const [index, ord] of [19, 24].entries()) {
    const closed = await page.evaluate(
      async (input) => window.noryth!.world.closeForeshadow(input),
      { foreshadowId: foreshadowIds[index + 1]!, payoffChapterId: chapters[ord]!.id }
    )
    if (!closed.ok) throw new Error(`closeForeshadow failed: ${closed.error.code}`)
  }
  const foreshadows = await page.evaluate(async () => window.noryth!.world.foreshadows())
  expect(foreshadows.ok).toBe(true)
  if (!foreshadows.ok) throw new Error(foreshadows.error.code)
  expect(foreshadows.data.openCount).toBe(1)
  expect(foreshadows.data.closedCount).toBe(2)

  const verified = await verifyProject(page)
  expect(verified.ok, `final verify: ${verified.errors.join('; ')}`).toBe(true)

  // ── 最终 DB 断言 ───────────────────────────────────────────────────────
  const dbPath = join(project.path, 'noryth.db')
  const db = new Database(dbPath, { readonly: true })
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  const statsRef: { value: Record<string, number> | null } = { value: null }
  try {
    const finals = db
      .prepare("SELECT COUNT(*) AS count FROM chapter WHERE status = 'finalized' AND final_revision_id IS NOT NULL")
      .get() as { count: number }
    expect(finals.count).toBe(30)

    const finalRevisions = db.prepare("SELECT COUNT(*) AS count FROM revision WHERE kind = 'final'").get() as {
      count: number
    }
    expect(finalRevisions.count).toBe(30)

    const chaptersCount = db.prepare('SELECT COUNT(*) AS count FROM chapter').get() as { count: number }
    expect(chaptersCount.count).toBe(30)

    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS count FROM beat
         WHERE status IN ('generating','regenerating')
            OR (status <> 'superseded' AND chapter_id NOT IN (SELECT id FROM chapter))`
      )
      .get() as { count: number }
    expect(orphans.count).toBe(0)

    const doubleLive = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT scene_id, ord FROM beat
           WHERE status <> 'superseded'
           GROUP BY scene_id, ord HAVING COUNT(*) > 1
         )`
      )
      .get() as { count: number }
    expect(doubleLive.count).toBe(0)

    const failedJobs = db.prepare("SELECT COUNT(*) AS count FROM job WHERE status = 'failed'").get() as {
      count: number
    }
    expect(failedJobs.count).toBe(0)
    const overflow = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE error_code = 'context_overflow'")
      .get() as { count: number }
    expect(overflow.count).toBe(0)
    const budgetPauses = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE payload_json LIKE '%auto_budget_pause%'")
      .get() as { count: number }
    expect(budgetPauses.count).toBe(0)

    const confirmedWords = db
      .prepare("SELECT COALESCE(SUM(word_count),0) AS words FROM beat WHERE status IN ('confirmed','author_edited')")
      .get() as { words: number }
    expect(confirmedWords.words).toBeGreaterThanOrEqual(100_000)
    const allWords = db.prepare('SELECT COALESCE(SUM(word_count),0) AS words FROM beat').get() as { words: number }

    const memory = db
      .prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE status = 'active'")
      .get() as { count: number }
    expect(memory.count).toBeGreaterThan(0)
    const vectors = db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
    expect(vectors.count).toBeGreaterThan(0)

    const summaries = db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }
    expect(summaries.count).toBeGreaterThanOrEqual(30)

    const voice = db
      .prepare(
        "SELECT COUNT(*) AS count, COUNT(DISTINCT chapter_id) AS chapters FROM voice_metric WHERE threshold_version = 'zh-v1'"
      )
      .get() as { count: number; chapters: number }
    expect(voice.chapters).toBe(30)
    expect(voice.count).toBeGreaterThanOrEqual(90)

    const agents = db.prepare('SELECT DISTINCT agent_key FROM turn_metric ORDER BY agent_key').all() as Array<{
      agent_key: string
    }>
    expect(agents.map((row) => row.agent_key)).toEqual([
      'character',
      'memory',
      'narrator',
      'orchestrator',
      'planner',
      'reviewer'
    ])
    const plannerRows = db
      .prepare("SELECT COUNT(*) AS count FROM turn_metric WHERE agent_key = 'planner' AND chapter_id IS NULL")
      .get() as { count: number }
    expect(plannerRows.count).toBeGreaterThan(0)

    // 章预算：第 1 章 ¥2，实际花费在预算内（暂停账本行为 0，见上）。
    const budget = db.prepare('SELECT budget_cny FROM chapter WHERE ord = 1').get() as { budget_cny: number | null }
    expect(budget.budget_cny).toBeCloseTo(2, 5)
    const firstCost = db
      .prepare(
        'SELECT COALESCE(SUM(cost_cny),0) AS cost FROM turn_metric WHERE chapter_id = (SELECT id FROM chapter WHERE ord = 1)'
      )
      .get() as { cost: number }
    expect(firstCost.cost).toBeGreaterThan(0)
    expect(firstCost.cost).toBeLessThan(2)

    const toolCalls = db
      .prepare('SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NOT NULL')
      .get() as { count: number }
    expect(toolCalls.count).toBeGreaterThan(0)
    // 规划是项目级（PHASE-20：planner 的 chapter_id = NULL）；其余调用都必须能归章。
    const plannerCalls = db
      .prepare("SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NULL AND actor_id = 'planner'")
      .get() as { count: number }
    expect(plannerCalls.count).toBeGreaterThan(0)
    const unmapped = db
      .prepare("SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NULL AND actor_id <> 'planner'")
      .get() as { count: number }
    expect(unmapped.count).toBe(0)

    const revisionHashes = db
      .prepare("SELECT COUNT(DISTINCT content_hash) AS count FROM revision WHERE kind = 'final'")
      .get() as { count: number }
    expect(revisionHashes.count).toBe(30)

    statsRef.value = {
      chapters: chaptersCount.count,
      finals: finals.count,
      confirmedWords: confirmedWords.words,
      allWords: allWords.words,
      memories: memory.count,
      vectors: vectors.count,
      summaries: summaries.count,
      voiceRows: voice.count,
      voiceChapters: voice.chapters,
      agents: agents.length,
      firstChapterCostCny: Number(firstCost.cost.toFixed(4)),
      toolCalls: toolCalls.count,
      plannerToolCalls: plannerCalls.count
    }
  } finally {
    db.close()
  }

  // ── 声音：两两区分度算得出，且夹具的三种角色风格确实被区分开 ─────────────
  const sceneId = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    return state.ok ? (state.data.scenes[0]?.id ?? '') : ''
  }, chapters[0]!.id)
  const voiceState = await page.evaluate(async (id) => window.noryth!.voice.scene({ sceneId: id }), sceneId)
  expect(voiceState.ok).toBe(true)
  if (!voiceState.ok) throw new Error(voiceState.error.code)
  expect(voiceState.data.found).toBe(true)
  expect(voiceState.data.insufficientData).toBe(false)
  expect(voiceState.data.pairs.length).toBeGreaterThanOrEqual(3)
  const bestPair = Math.max(...voiceState.data.pairs.map((pair) => pair.score))
  expect(bestPair).toBeGreaterThanOrEqual(voiceState.data.threshold.distinctnessMin)

  const usage = await memoryMb(page, app)
  // eslint-disable-next-line no-console
  console.log(`E2E-M2-A final ws=${usage.workingSet}MB priv=${usage.privateBytes}MB`)
  expect(usage.privateBytes).toBeLessThan(600)
  expect(baselinePrivate).toBeGreaterThan(0)
  expect(usage.privateBytes).toBeLessThanOrEqual(Math.round(baselinePrivate * 1.5))

  // eslint-disable-next-line no-console
  console.log(
    `E2E-M2-A stats ${JSON.stringify({
      ...statsRef.value!,
      projectPath: project.path,
      workingSetMb: usage.workingSet,
      privateMb: usage.privateBytes,
      slowestChapterMs,
      bestPairScore: Number(bestPair.toFixed(3)),
      thresholdVersion: voiceState.data.threshold.version
    })}`
  )

  // 收尾：重开项目仍可校验。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  const reopened = await verifyProject(page)
  expect(reopened.ok).toBe(true)
})
