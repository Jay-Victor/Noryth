import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M2-COST-01（PHASE-20 §6 / M2-5）。
 *
 * 状态栏打开报表 → 按章/按 Agent 数字与 `report.cost` 一致 → 每万字与字数口径一致
 * → 无计价显示「下限」→ 空项目空态。另做一次 COST-M2-01 对账：
 * 报表合计 = `turn_metric` 直接汇总，byChapter + projectLevel = total。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '0'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: '成本报表',
        title: '黑漆匣子 · 成本',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  return { projectId: result.data.projectId, path: result.data.path }
}

function openDb(path: string): Database.Database {
  return new Database(join(path, 'noryth.db'), { timeout: 5_000 })
}

function cny(value: number): string {
  return `¥${value > 0 && value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`
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
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用
    }
  }
})

test('E2E-M2-COST-01：状态栏报表与 IPC/DB 对账，空态与下限', async () => {
  test.setTimeout(300_000)
  const userData = makeTemp('noryth-cost-user-')
  const parent = makeTemp('noryth-cost-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent)

  const seeded = await page.evaluate(async () => window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 6, chapters: 3 }))
  expect(seeded.ok).toBe(true)
  const chapterId = seeded.ok ? seeded.data.chapterId : ''

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')

  // ── 空态：还没有任何模型调用 ──
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await expect(page.locator('[data-testid="cost-empty"]')).toBeVisible()
  await expect(page.locator('[data-testid="cost-total-cost"]')).toHaveText('¥0.00')
  await page.locator('[data-testid="cost-close"]').click()

  // ── G2 → 2 拍逐拍确认 → 自动跑完 ──
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible()
  await page.locator('[data-testid="write-tab-prose"]').click()

  for (let index = 0; index < 2; index += 1) {
    await page.locator('[data-testid="write-generate"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
    await page.locator('[data-testid="write-confirm"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeDisabled({ timeout: 10_000 })
  }
  await page.locator('[data-testid="write-auto"]').click()
  await page.locator('[data-testid="write-auto-confirm"]').click()
  await expect
    .poll(
      async () => {
        const state = (await page.evaluate(async () => window.noryth!.write.state())) as
          | { ok: true; data: { chapterStatus: string } }
          | { ok: false }
        return state.ok ? state.data.chapterStatus : 'unknown'
      },
      { timeout: 120_000 }
    )
    .toBe('draft_complete')

  // ── IPC 报表 = DB 直接汇总（COST-M2-01） ──
  const reportResult = await page.evaluate(async () => window.noryth!.report.cost({}))
  expect(reportResult.ok).toBe(true)
  if (!reportResult.ok) throw new Error(reportResult.error.code)
  const report = reportResult.data

  const db = openDb(project.path)
  let direct: { tokens_in: number; tokens_out: number; cost_cny: number; calls: number }
  let words: number
  try {
    direct = db
      .prepare(
        `SELECT COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
                COALESCE(SUM(cost_cny),0) AS cost_cny, COUNT(*) AS calls
         FROM turn_metric WHERE project_id = ?`
      )
      .get(project.projectId) as typeof direct
    words = (
      db
        .prepare(
          `SELECT COALESCE(SUM(beat.word_count), 0) AS words
           FROM chapter
           JOIN revision_beat ON revision_beat.revision_id = chapter.current_revision_id
           JOIN beat ON beat.id = revision_beat.beat_id
           WHERE chapter.project_id = ?`
        )
        .get(project.projectId) as { words: number }
    ).words
  } finally {
    db.close()
  }
  expect(report.total.tokensIn).toBe(direct.tokens_in)
  expect(report.total.tokensOut).toBe(direct.tokens_out)
  expect(report.total.costCny).toBeCloseTo(direct.cost_cny, 6)
  expect(report.total.pricedCalls + report.total.unpricedCalls).toBe(direct.calls)
  expect(report.total.words).toBe(words)
  expect(report.total.costPer10k).toBeCloseTo((direct.cost_cny / words) * 10_000, 3)
  const byChapterCost = report.byChapter.reduce((sum, row) => sum + row.costCny, 0)
  expect(byChapterCost + report.projectLevel.costCny).toBeCloseTo(report.total.costCny, 6)
  // 无规划调用：项目级桶为空。
  expect(report.projectLevel.calls).toBe(0)
  // 每拍确认耗时来自 scheduler_event：2 拍作者确认。
  expect(report.confirm.samples).toBe(2)
  expect(report.confirm.p50).not.toBeNull()

  // ── 状态栏 → 报表：数字与 IPC 一致 ──
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await expect(page.locator('[data-testid="cost-total-cost"]')).toHaveText(cny(report.total.costCny))
  await expect(page.locator('[data-testid="cost-total-words"]')).toHaveText(String(report.total.words))
  await expect(page.locator('[data-testid="cost-total-per10k"]')).toHaveText(cny(report.total.costPer10k!))
  await expect(page.locator(`[data-testid="cost-row-${chapterId}"]`)).toBeVisible()
  const chapterRow = report.byChapter.find((row) => row.chapterId === chapterId)!
  await expect(page.locator(`[data-testid="cost-row-${chapterId}"]`)).toContainText(String(chapterRow.words))

  // 按 Agent：至少旁白/角色一行，占比合计接近 100%。
  await page.locator('[data-testid="cost-tab-agent"]').click()
  const agentKeys = report.byAgent.map((row) => row.agentKey)
  for (const key of agentKeys) {
    await expect(page.locator(`[data-testid="cost-agent-${key}"]`)).toBeVisible()
  }
  await expect(page.locator('[data-testid="cost-agent-narrator"], [data-testid="cost-agent-character"]').first()).toBeVisible()

  // 本章范围：项目级归零，数字与 chapter 范围 IPC 一致。
  await page.locator('[data-testid="cost-tab-chapter"]').click()
  await page.locator('[data-testid="cost-scope-chapter"]').click()
  const chapterReportResult = await page.evaluate(
    async (id) => window.noryth!.report.cost({ chapterId: id }),
    chapterId
  )
  expect(chapterReportResult.ok).toBe(true)
  if (!chapterReportResult.ok) throw new Error(chapterReportResult.error.code)
  const chapterReport = chapterReportResult.data
  expect(chapterReport.projectLevel).toEqual({ tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0 })
  await expect(page.locator('[data-testid="cost-total-words"]')).toHaveText(String(chapterReport.total.words))
  await expect(page.locator('[data-testid="cost-total-cost"]')).toHaveText(cny(chapterReport.total.costCny))
  await expect(page.locator('[data-testid="cost-scope-book"]')).toBeEnabled()
  await page.locator('[data-testid="cost-scope-book"]').click()
  await page.locator('[data-testid="cost-close"]').click()

  // ── 无计价：把一条指标的费用置空 → 报表显示「下限」 ──
  const writer = openDb(project.path)
  try {
    writer
      .prepare(
        `UPDATE turn_metric SET cost_cny = NULL
         WHERE turn_id = (SELECT turn_id FROM turn_metric WHERE project_id = ? ORDER BY created_at LIMIT 1)`
      )
      .run(project.projectId)
  } finally {
    writer.close()
  }
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')
  await expect(page.locator('[data-testid="status-budget"]')).toContainText('≥')
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-unpriced-note"]')).toBeVisible()
  const after = await page.evaluate(async () => window.noryth!.report.cost({}))
  expect(after.ok).toBe(true)
  if (after.ok) expect(after.data.total.unpricedCalls).toBeGreaterThanOrEqual(1)
  await page.locator('[data-testid="cost-close"]').click()
})
