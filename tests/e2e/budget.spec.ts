import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M2-BUDGET-01（PHASE-20 §6 / M2-3）。
 *
 * 真实 UI + 假适配器：G2 → 状态栏打开成本报表把本章预算改成 ¥0.01 →
 * 自动模式跑到费用上限 → 暂停横幅显示原因与两套数字 → 提高预算 → 恢复 →
 * 已完成拍逐字不变 → 出口满足后场景关闭（草稿完成）。
 *
 * DB 断言：暂停 job 的 status=paused 且 result_json.budget 有 token/费用两套数字。
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
        folderName: '预算化自动模式',
        title: '黑漆匣子 · 预算',
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

function readDb<T>(path: string, run: (db: Database.Database) => T): T {
  const handle = new Database(join(path, 'noryth.db'), { timeout: 5_000 })
  try {
    return run(handle)
  } finally {
    handle.close()
  }
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

test('E2E-M2-BUDGET-01：费用预算暂停 → 提高预算 → 恢复后收束', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-budget-user-')
  const parent = makeTemp('noryth-budget-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent)

  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({
      scenes: 1,
      beatsPerScene: 6,
      exit: 'all(fact("black_box","location"), beats(6))'
    })
  )
  expect(seeded.ok).toBe(true)
  const chapterId = seeded.ok ? seeded.data.chapterId : ''

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')

  // G2
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible()
  await page.locator('[data-testid="write-tab-prose"]').click()

  // 状态栏 → 成本报表 → 本章预算改成 ¥0.01
  await expect(page.locator('[data-testid="status-budget"]')).toBeVisible()
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await page.locator('[data-testid="cost-scope-chapter"]').click()
  await page.locator('[data-testid="cost-budget-input"]').fill('0.01')
  await page.locator('[data-testid="cost-budget-save"]').click()
  await expect
    .poll(
      async () =>
        readDb(project.path, (db) =>
          (db.prepare('SELECT budget_cny FROM chapter WHERE id = ?').get(chapterId) as { budget_cny: number | null })
            .budget_cny
        ),
      { timeout: 10_000 }
    )
    .toBeCloseTo(0.01, 5)
  await page.locator('[data-testid="cost-close"]').click()

  // 自动模式 → 预检 → 开跑
  await page.locator('[data-testid="write-auto"]').click()
  await expect(page.locator('[data-testid="write-preflight"]')).toBeVisible()
  await page.locator('[data-testid="write-auto-confirm"]').click()

  // 预算暂停：横幅显示原因与两套数字
  const banner = page.locator('[data-testid="write-pause-banner"]')
  await expect(banner).toBeVisible({ timeout: 60_000 })
  await expect(banner).toHaveAttribute('data-reason', 'budget_exceeded')
  await expect(page.locator('[data-testid="write-budget-pause-detail"]')).toContainText('费用预算已用尽')
  await expect(page.locator('[data-testid="write-budget-pause-detail"]')).toContainText('tokens')

  const before = readDb(project.path, (db) =>
    db
      .prepare("SELECT id, body FROM beat WHERE chapter_id = ? AND status IN ('confirmed','author_edited')")
      .all(chapterId) as Array<{ id: string; body: string }>
  )
  expect(before.length).toBeGreaterThan(0)
  expect(before.length).toBeLessThan(6)
  expect(before.every((beat) => beat.body.length > 0)).toBe(true)

  const pausedJob = readDb(project.path, (db) =>
    db
      .prepare(
        "SELECT status, result_json FROM job WHERE payload_json LIKE '%auto_budget_pause%' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { status: string; result_json: string } | undefined
  )
  expect(pausedJob?.status).toBe('paused')
  const jobBudget = (JSON.parse(pausedJob!.result_json) as {
    budget: { tokens_limit: number; tokens_used: number; cost_limit: number; cost_used: number; reason: string }
  }).budget
  expect(jobBudget.reason).toBe('cost')
  expect(jobBudget.cost_limit).toBeCloseTo(0.01, 5)
  expect(jobBudget.cost_used).toBeGreaterThanOrEqual(0.01)
  expect(jobBudget.tokens_limit).toBe(120_000)
  expect(jobBudget.tokens_used).toBeGreaterThan(0)

  // 从横幅「提高预算」→ 改成 ¥100 → 保存 → 关闭 → 继续
  await page.locator('[data-testid="write-budget-open"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await page.locator('[data-testid="cost-budget-input"]').fill('100')
  await page.locator('[data-testid="cost-budget-save"]').click()
  await expect
    .poll(
      async () =>
        readDb(project.path, (db) =>
          (db.prepare('SELECT budget_cny FROM chapter WHERE id = ?').get(chapterId) as { budget_cny: number | null })
            .budget_cny
        ),
      { timeout: 10_000 }
    )
    .toBe(100)
  await page.locator('[data-testid="cost-close"]').click()

  await page.locator('[data-testid="write-resume"]').click()
  await expect
    .poll(
      async () =>
        readDb(project.path, (db) =>
          (db.prepare('SELECT status FROM chapter WHERE id = ?').get(chapterId) as { status: string }).status
        ),
      { timeout: 90_000 }
    )
    .toBe('draft_complete')

  // 已确认拍逐字不变，且没有被重生成（无 supersede）。
  const after = readDb(project.path, (db) =>
    db
      .prepare("SELECT id, body FROM beat WHERE chapter_id = ? AND status IN ('confirmed','author_edited')")
      .all(chapterId) as Array<{ id: string; body: string }>
  )
  expect(after.length).toBe(6)
  for (const beat of before) {
    const match = after.find((entry) => entry.id === beat.id)
    expect(match?.body).toBe(beat.body)
  }
  // 已确认拍没有被重生成（没有新拍 supersede 它们）；6 条 superseded 是 G2 占位。
  const supersededOnly = readDb(project.path, (db) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM beat WHERE supersedes_id IN (${before.map(() => '?').join(',')})`
        )
        .get(...before.map((beat) => beat.id)) as { count: number }
    ).count
  )
  expect(supersededOnly).toBe(0)

  // 恢复后横幅消失；状态栏预算数字仍可点开报表。
  await expect(page.locator('[data-testid="write-pause-banner"]')).toHaveCount(0)
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await page.locator('[data-testid="cost-close"]').click()
})
