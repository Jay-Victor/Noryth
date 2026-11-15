import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-CONTEXT-01（PHASE-13 §5.4 / M1-17）：
 *
 * 生成一拍 → 打开上下文检查器 → 显示的块 / token 与 `turn_metric.context_json` 对齐；
 * 检查器占用对话栅（正文可见），Esc 关闭后回到对话。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string): Promise<Page> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_WRITE_API_KEY

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return page
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 上下文检查',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parentDir: parent, name: folder }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  return { path: result.data.path }
}

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

test('E2E-M1-CONTEXT-01：上下文检查器数值与 turn_metric 一致', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-context-user-')
  const parent = makeTemp('noryth-context-project-')
  const page = await launch(userData)
  const { path } = await createProject(page, parent, '上下文')

  const seeded = await page.evaluate(
    async (input) => window.noryth!.write.devSeed(input),
    { scenes: 1, beatsPerScene: 2, exit: 'beats(2)' }
  )
  expect(seeded.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // G2 → 生成第一拍
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible()
  await page.locator('[data-testid="write-tab-prose"]').click()
  await page.locator('[data-testid="write-generate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })

  // 打开检查器：拍还没有被确认，但已经有 turn_metric。
  await page.locator('[data-testid="write-context-checker"]').click()
  await expect(page.locator('[data-testid="context-inspector"]')).toBeVisible()
  await expect(page.locator('[data-testid="context-blocks"]')).toBeVisible()
  await expect(page.locator('[data-testid="context-budget-bar"]')).toBeVisible()
  // 检查器占用对话栅：正文列仍然可见（不遮正文）。
  await expect(page.locator('[data-testid="pane-preview"]')).toBeVisible()
  await expect(page.locator('[data-testid="write-prose"]')).toBeVisible()

  const blockRows = page.locator('[data-testid="context-blocks"] tbody tr')
  expect(await blockRows.count()).toBeGreaterThan(0)
  await expect(blockRows.first()).toHaveAttribute('data-layer', /L[0-3]/)

  // 与 turn_metric 对齐：total_tokens / tokens_in / prefix_hash / as_of。
  const db = new Database(join(path, 'noryth.db'), { readonly: true })
  try {
    const metric = db
      .prepare(
        `SELECT tm.context_json AS context_json, tm.tokens_in AS tokens_in
         FROM turn_metric tm
         JOIN beat b ON b.id = tm.beat_id
         WHERE b.chapter_id = (SELECT id FROM chapter ORDER BY ord LIMIT 1)
         ORDER BY tm.created_at DESC LIMIT 1`
      )
      .get() as { context_json: string; tokens_in: number | null } | undefined
    expect(metric).toBeDefined()
    const snapshot = JSON.parse(metric!.context_json) as {
      total_tokens: number
      blocks: Array<{ id: string; layer: string; tokens: number }>
      trimmed: string[]
      as_of: number
      prefix_hash: string
    }

    await expect(page.locator('[data-testid="context-total"]')).toContainText(
      `估算 ${snapshot.total_tokens} tokens`
    )
    await expect(page.locator('[data-testid="context-asof"]')).toContainText(`as_of ${snapshot.as_of}`)
    expect(await blockRows.count()).toBe(snapshot.blocks.length)
    if (metric!.tokens_in !== null) {
      await expect(page.locator('[data-testid="context-ratio"]')).toContainText(
        `上次实际 prompt ${metric!.tokens_in}`
      )
    }
  } finally {
    db.close()
  }

  // Esc 关闭：回到对话栏。
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="context-inspector"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="write-composer"]')).toBeVisible()
})
