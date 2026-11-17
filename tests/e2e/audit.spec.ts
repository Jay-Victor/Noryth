import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * 工具调用审计面板（PHASE-18 §5.3 / M1-23）。
 *
 * 用审批台的真实回合产生 tool_call 行（假审批适配器会调 consistency.check 等工具），
 * 然后在记忆台「审计 → 工具调用」里断言：
 *   - 行来自本章、actor 与状态可过滤；
 *   - 每行只有 tool/版本/actor/耗时/degraded/错误码，没有参数原文；
 *   - API 返回的条目里没有 args/arguments/result 字段（审计表只存 args_hash）；
 *   - 分页控件只读边界正确（第 1 页「上一页」禁用）。
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
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  env.NORYTH_MEMORY_EMBED = 'hash'
  for (const name of ['NORYTH_DEEPSEEK_API_KEY', 'NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY', 'NORYTH_REVIEW_API_KEY', 'NORYTH_MEMORY_API_KEY']) {
    delete env[name]
  }
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
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

test('E2E-M1-TOOLCALL：审计面板只读、可按章/Agent 过滤、不显示参数', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-audit-user-')
  const parent = makeTemp('noryth-audit-project-')
  const { page } = await launch(userData)

  const created = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 审计',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parentDir: parent, name: '审计面板' }
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.code)
  const projectPath = created.data.path
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  const seeded = await page.evaluate(async () => window.noryth!.review.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId

  // 审批回合走真实工具流水线（假适配器 → consistency.check 等），落 tool_call。
  const reviewed = await page.evaluate(async (id) => window.noryth!.review.run(id), chapterId)
  expect(reviewed.ok).toBe(true)

  const total = await page.evaluate(async () => {
    const result = await window.noryth!.memory.toolCalls({})
    return result.ok ? result.data.total : -1
  })
  expect(total).toBeGreaterThan(0)

  // 只读契约：条目字段里没有参数原文/结果 JSON。
  const sample = await page.evaluate(async (id) => {
    const result = await window.noryth!.memory.toolCalls({ chapterId: id })
    if (!result.ok) return null
    const item = result.data.items[0] ?? null
    return item === null ? null : { keys: Object.keys(item), item, dataKeys: Object.keys(result.data) }
  }, chapterId)
  expect(sample).not.toBeNull()
  expect(sample!.dataKeys).not.toContain('args')
  expect(sample!.keys).not.toContain('args')
  expect(sample!.keys).not.toContain('arguments')
  expect(sample!.keys).not.toContain('resultJson')
  expect(sample!.item.chapterId).toBe(chapterId)
  expect(sample!.item.tool.length).toBeGreaterThan(0)

  // DB 侧只有 args_hash：面板不读正文/参数。
  const db = new Database(join(projectPath, 'noryth.db'), { readonly: true })
  try {
    const rows = db
      .prepare('SELECT tool, chapter_id, args_hash FROM tool_call WHERE project_id = ?')
      .all(created.data.projectId) as Array<{ tool: string; chapter_id: string | null; args_hash: string }>
    expect(rows.length).toBe(total)
    expect(rows.every((row) => row.chapter_id === chapterId)).toBe(true)
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.args_hash))).toBe(true)
    const columns = (db.prepare('PRAGMA table_info(tool_call)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
    expect(columns).not.toContain('args_json')
  } finally {
    db.close()
  }

  // ── UI：记忆台 → 审计 → 工具调用 ────────────────────────────────────────
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="memory-tab-audit"]', { timeout: 30_000 })
  await page.locator('[data-testid="memory-tab-audit"]').click()
  await expect(page.locator('[data-testid="audit-scope-memory"]')).toBeVisible()
  await expect(page.locator('[data-testid="audit-scope-memory"]')).toHaveAttribute('aria-selected', 'true')
  await page.locator('[data-testid="audit-scope-tools"]').click()
  await expect(page.locator('[data-testid="tool-call-list"]')).toBeVisible()
  await expect(page.locator('[data-testid="tool-call-row-0"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="tool-call-total"]')).toContainText(`共 ${total} 条`)
  await expect(page.locator('[data-testid="tool-call-prev"]')).toBeDisabled()
  await expect(page.locator('[data-testid="tool-call-filter-chapter"] option')).toHaveCount(2)

  // 章过滤：只剩本章的行，总数不变（都在本章）。
  await page.locator('[data-testid="tool-call-filter-chapter"]').selectOption(chapterId)
  await expect(page.locator('[data-testid="tool-call-total"]')).toContainText(`共 ${total} 条`)

  // Agent 过滤：审批（reviewer）有行；不存在的组合给空态并说明空结果不代表越权不存在。
  const actor = await page.evaluate(async (id) => {
    const result = await window.noryth!.memory.toolCalls({ chapterId: id })
    return result.ok ? (result.data.actors[0]?.id ?? null) : null
  }, chapterId)
  expect(actor).not.toBeNull()
  await page.locator('[data-testid="tool-call-filter-actor"]').selectOption(actor!)
  await expect(page.locator('[data-testid="tool-call-row-0"]')).toBeVisible()

  // 状态过滤：假审批全部成功 → 失败过滤是空态。
  await page.locator('[data-testid="tool-call-filter-status"]').selectOption('error')
  await expect(page.locator('[data-testid="tool-call-empty"]')).toBeVisible()
  await page.locator('[data-testid="tool-call-filter-status"]').selectOption('all')
  await expect(page.locator('[data-testid="tool-call-row-0"]')).toBeVisible()

  // 只读：面板里没有「重放」按钮，也不渲染参数文本容器。
  await expect(page.getByRole('button', { name: /重放/ })).toHaveCount(0)
  await expect(page.locator('[data-testid="tool-call-list"]')).toContainText('不显示参数')
})
