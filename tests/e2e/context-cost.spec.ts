import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * COST-M2-02（PHASE-22 §5.5 / §5.6，M2-9）：
 *
 * 1. 供应商报告缓存字段（假适配器注入 640）→ `turn_metric.cached_tokens=640`、
 *    `context_json.cache` 有 stable_tokens/cached_tokens、上下文检查器与成本报表
 *    都显示「缓存命中 640 · 64%」。
 * 2. 供应商未报告 → `cached_tokens IS NULL`，报表/检查器显示「未报告」，不是 0%。
 *
 * 单拍提示词 token 的 15% 下降用同一夹具的纯函数对照测（`tests/unit/context/cost.test.ts`），
 * 这里只验证端到端落库与 UI 口径。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string, cachedTokens: number | null): Promise<Page> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  if (cachedTokens === null) delete env.NORYTH_WRITE_FAKE_CACHED_TOKENS
  else env.NORYTH_WRITE_FAKE_CACHED_TOKENS = String(cachedTokens)
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_REVIEW_API_KEY

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
        title: '黑漆匣子 · 上下文成本',
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

async function generateFirstBeat(page: Page): Promise<void> {
  const seeded = await page.evaluate(
    async (input) => window.noryth!.write.devSeed(input),
    { scenes: 1, beatsPerScene: 2, exit: 'beats(2)' }
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible({ timeout: 30_000 })
  await page.locator('[data-testid="write-tab-prose"]').click()
  await page.locator('[data-testid="write-generate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
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

test('COST-M2-02：缓存命中落库、检查器与报表显示 640 · 64%', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-ctxcost-user-')
  const parent = makeTemp('noryth-ctxcost-project-')
  const page = await launch(userData, 640)
  const { path } = await createProject(page, parent, '缓存命中')
  await generateFirstBeat(page)

  // 上下文检查器：缓存 640 · 64%（prompt_tokens 1000）。
  await page.locator('[data-testid="write-context-checker"]').click()
  await expect(page.locator('[data-testid="context-inspector"]')).toBeVisible()
  await expect(page.locator('[data-testid="context-cache"]')).toContainText('640', { timeout: 30_000 })
  await expect(page.locator('[data-testid="context-cache"]')).toContainText('64%')

  // write.context：稳定前缀 token > 0，命中率来自实际 usage。
  const inspection = await page.evaluate(async () => {
    const state = await window.noryth!.write.state()
    if (!state.ok) return null
    const beats = state.data.scenes.flatMap((scene) => scene.beats)
    const beat = beats.find((item) => item.body !== null) ?? beats[0]
    if (!beat) return null
    return window.noryth!.write.context(beat.id)
  })
  expect(inspection).not.toBeNull()
  expect(inspection!.ok).toBe(true)
  if (!inspection!.ok) throw new Error(inspection!.error.code)
  expect(inspection!.data.usage.cachedTokens).toBe(640)
  expect(inspection!.data.cache.cachedTokens).toBe(640)
  expect(inspection!.data.cache.hitRate).toBe(0.64)
  expect(inspection!.data.cache.stableTokens).toBeGreaterThan(0)
  expect(inspection!.data.prefixHash).not.toBeNull()

  // 成本报表：只统计报告了缓存的调用。
  const report = await page.evaluate(async () => window.noryth!.report.cost({}))
  expect(report.ok).toBe(true)
  if (!report.ok) throw new Error(report.error.code)
  expect(report.data.cache).toMatchObject({ cachedTokens: 640, cacheCalls: 1, hitRate: 0.64 })
  expect(report.data.total.cachedTokens).toBe(640)

  // 成本对话框显示「缓存命中」。
  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await expect(page.locator('[data-testid="cost-cache"]')).toContainText('640', { timeout: 30_000 })
  await expect(page.locator('[data-testid="cost-cache"]')).toContainText('64%')
  await page.locator('[data-testid="cost-close"]').click()

  const db = new Database(join(path, 'noryth.db'), { readonly: true })
  try {
    const row = db
      .prepare(
        'SELECT cached_tokens, tokens_in, context_json FROM turn_metric WHERE beat_id IS NOT NULL ORDER BY created_at DESC LIMIT 1'
      )
      .get() as { cached_tokens: number | null; tokens_in: number | null; context_json: string }
    expect(row.cached_tokens).toBe(640)
    expect(row.tokens_in).toBe(1000)
    const context = JSON.parse(row.context_json) as {
      cache?: { stable_tokens?: number; cached_tokens?: number; prefix_hash?: string }
      blocks?: Array<{ id: string }>
    }
    expect(context.cache?.cached_tokens).toBe(640)
    expect(context.cache?.stable_tokens).toBeGreaterThan(0)
    expect(context.cache?.prefix_hash).toBeTruthy()
    // 块 id 唯一（去重后不会出现同一 (type,id) 两份）。
    const ids = (context.blocks ?? []).map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
  } finally {
    db.close()
  }
})

test('COST-M2-02：供应商未报告缓存 → NULL 与「未报告」，不显示 0%', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-ctxcost-null-user-')
  const parent = makeTemp('noryth-ctxcost-null-project-')
  const page = await launch(userData, null)
  const { path } = await createProject(page, parent, '未报告')
  await generateFirstBeat(page)

  await page.locator('[data-testid="write-context-checker"]').click()
  await expect(page.locator('[data-testid="context-cache"]')).toContainText('未报告', { timeout: 30_000 })

  const report = await page.evaluate(async () => window.noryth!.report.cost({}))
  expect(report.ok).toBe(true)
  if (!report.ok) throw new Error(report.error.code)
  expect(report.data.cache).toEqual({ cachedTokens: 0, cacheCalls: 0, calls: 1, hitRate: null })

  await page.locator('[data-testid="status-budget"]').click()
  await expect(page.locator('[data-testid="cost-dialog"]')).toBeVisible()
  await expect(page.locator('[data-testid="cost-cache"]')).toContainText('未报告')
  await page.locator('[data-testid="cost-close"]').click()

  const db = new Database(join(path, 'noryth.db'), { readonly: true })
  try {
    const row = db
      .prepare(
        'SELECT cached_tokens FROM turn_metric WHERE beat_id IS NOT NULL ORDER BY created_at DESC LIMIT 1'
      )
      .get() as { cached_tokens: number | null }
    expect(row.cached_tokens).toBeNull()
  } finally {
    db.close()
  }
})
