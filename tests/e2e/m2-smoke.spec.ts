import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { memoryMb, verifyProject } from './m1-flow'
import { createM2Project, launchM2, runChapterM2, seedLongrun } from './m2-flow'

/**
 * E2E-M2-SMOKE（PHASE-24 §5.2）：3 章闭环，进提交门。
 *
 * 与 `E2E-M1-SMOKE` 分开，避免 M1 的验收口径被 M2 新步骤污染。每章：
 *   G2 → 2 拍（第 2 拍含 1 次重生成）→ 自动（章预算 ¥1）→ G4 → G5（2 接受 1 拒绝）
 *   → 复检 → G6 → G7。
 * 额外覆盖 M2 面：章预算生效且未误暂停、场景声音徽标、成本报表对话框、
 * 归档候选面板（只打开，不执行）。
 *
 * 断言：3 final / `db.verify()` 绿 / 记忆 active > 0 / 3 章声音指标 /
 *   归档候选 ≥1 / 无 `auto_budget_pause` / 无孤儿 / 私有内存 < 600MB。
 * 30 章版本是 `tests/e2e-long/m2-a.spec.ts`（nightly），两者共用 `m2-flow.ts`。
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
    console.warn(`E2E-M2-SMOKE kept temp dirs: ${tempDirs.join(' ; ')}`)
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

test('E2E-M2-SMOKE：3 章闭环 + 预算 / 声音 / 成本 / 归档候选', async () => {
  test.setTimeout(600_000)
  const userData = makeTemp('noryth-m2smoke-user-')
  const parent = makeTemp('noryth-m2smoke-project-')
  const { app, page } = await launchM2(ROOT, userData)
  apps.push(app)
  const project = await createM2Project(page, parent, 'M2 冒烟', '黑漆匣子 · M2 冒烟')

  const chapters = await seedLongrun(page, { volumes: 1, chaptersPerVolume: 3, characters: 5 })
  expect(chapters.map((chapter) => chapter.ord)).toEqual([1, 2, 3])

  const results = []
  for (const chapter of chapters) {
    const result = await runChapterM2(page, chapter, {
      ...(chapter.ord === 1 ? { budgetCny: 1, orchestratorTurn: true } : {})
    })
    const verified = await verifyProject(page)
    expect(verified.ok, `ch${chapter.ord} verify: ${verified.errors.join('; ')}`).toBe(true)
    results.push(result)
  }

  expect(results.map((result) => result.reportVerdict)).toEqual(['fail', 'fail', 'fail'])
  expect(results.every((result) => result.patches === 3)).toBe(true)
  expect(results.every((result) => result.accepted === 2)).toBe(true)
  expect(results.every((result) => result.memoryApplied > 0)).toBe(true)
  // 长文本夹具：3 章 × 24 拍，每拍 ≥150 字（重生成的那一版也计入 word_count）。
  expect(results.reduce((sum, result) => sum + result.words, 0)).toBeGreaterThan(9_000)

  const dbPath = join(project.path, 'noryth.db')

  // ── 数据库断言 ─────────────────────────────────────────────────────────
  const db = new Database(dbPath, { readonly: true })
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const finals = db
      .prepare("SELECT COUNT(*) AS count FROM chapter WHERE status = 'finalized' AND final_revision_id IS NOT NULL")
      .get() as { count: number }
    expect(finals.count).toBe(3)
    const finalRevisions = db.prepare("SELECT COUNT(*) AS count FROM revision WHERE kind = 'final'").get() as {
      count: number
    }
    expect(finalRevisions.count).toBe(3)

    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS count FROM beat
         WHERE status IN ('generating','regenerating')
            OR (status <> 'superseded' AND chapter_id NOT IN (SELECT id FROM chapter))`
      )
      .get() as { count: number }
    expect(orphans.count).toBe(0)

    const overflow = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE error_code = 'context_overflow'")
      .get() as { count: number }
    expect(overflow.count).toBe(0)

    const failed = db.prepare("SELECT COUNT(*) AS count FROM job WHERE status = 'failed'").get() as { count: number }
    expect(failed.count).toBe(0)

    const active = db
      .prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE status = 'active'")
      .get() as { count: number }
    expect(active.count).toBeGreaterThan(0)

    const summaries = db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }
    expect(summaries.count).toBeGreaterThanOrEqual(3)

    // 3 章 × 3 场 = 9 行声音指标（G4 时同步；阈值版本 zh-v1）。
    const voice = db
      .prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT chapter_id) AS chapters FROM voice_metric WHERE threshold_version = 'zh-v1'")
      .get() as { count: number; chapters: number }
    expect(voice.chapters).toBe(3)
    expect(voice.count).toBeGreaterThanOrEqual(9)

    // 章预算：第 1 章显式 ¥1；该章没有预算暂停账本行。
    const budget = db
      .prepare('SELECT budget_cny FROM chapter WHERE ord = 1')
      .get() as { budget_cny: number | null }
    expect(budget.budget_cny).toBeCloseTo(1, 5)
    const pauses = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE payload_json LIKE '%auto_budget_pause%'")
      .get() as { count: number }
    expect(pauses.count).toBe(0)
    const spent = db
      .prepare('SELECT COALESCE(SUM(cost_cny), 0) AS cost FROM turn_metric WHERE chapter_id = (SELECT id FROM chapter WHERE ord = 1)')
      .get() as { cost: number }
    expect(spent.cost).toBeGreaterThan(0)
    expect(spent.cost).toBeLessThan(1)
  } finally {
    db.close()
  }

  // ── 归档候选：3 章 G7 后至少 1 条重复经历；UI 打开面板但不执行 ──────────
  const candidates = await page.evaluate(async () => window.noryth!.memory.archiveCandidates())
  expect(candidates.ok).toBe(true)
  if (candidates.ok) expect(candidates.data.items.length).toBeGreaterThan(0)

  // ── UI：声音徽标（第 1 章第 1 场） + 成本报表 + 归档面板 ───────────────
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator(`[data-testid="write-chapter-${chapters[0]!.id}"]`).click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')

  const sceneId = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    return state.ok ? (state.data.scenes[0]?.id ?? '') : ''
  }, chapters[0]!.id)
  expect(sceneId).not.toBe('')
  const badge = page.locator(`[data-testid="write-voice-badge-${sceneId}"]`)
  await expect(badge).toBeVisible({ timeout: 30_000 })
  await badge.click()
  await expect(page.locator(`[data-testid="write-voice-panel-${sceneId}"]`)).toContainText('zh-v1')

  // 成本报表：状态栏预算段 → 本章 / 全书两档可切换 → 关闭。
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid="cost-scope-chapter"]').click()
  await page.locator('[data-testid="cost-scope-book"]').click()
  await page.locator('[data-testid="cost-close"]').click()

  // 记忆台「维护 → 归档」：候选可见，不执行归档。
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="memory-tab-archive"]').click()
  await expect(page.locator('[data-testid="archive-candidate-0"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="archive-candidates-empty"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="archive-counts"]')).toContainText('已归档 0')

  const usage = await memoryMb(page, app)
  // eslint-disable-next-line no-console
  console.log(`E2E-M2-SMOKE ws=${usage.workingSet}MB priv=${usage.privateBytes}MB`)
  expect(usage.privateBytes).toBeLessThan(600)

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  const reopened = await verifyProject(page)
  expect(reopened.ok).toBe(true)
})
