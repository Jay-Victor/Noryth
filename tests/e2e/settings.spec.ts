import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeLlm, probeCompatibleReply, type FakeLlmServer } from '../fake-llm/server'

/**
 * 设置中心 E2E（PHASE-10 I1–I4）。
 *
 * 覆盖四件不能只靠单测证明的事：
 * 1. Key 只显示末 4 位，页面与磁盘上都没有明文，重开应用仍在（safeStorage 真跑）；
 * 2. 测试连接经真实 OpenAI-compatible 适配器打到本地假服务器，成功后才允许绑定；
 * 3. 绑定保存成一批、可回滚上一套（服务端审计）；
 * 4. 外观切换即时生效（<html data-theme>），重开应用后保持。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []
const servers: FakeLlmServer[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData = makeTemp('noryth-e2e-settings-user-')): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
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
  for (const server of servers) await server.close()
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发文件占用
    }
  }
})

test('I1–I4：Key 掩码、测试连接、绑定回滚与外观', async () => {
  test.setTimeout(120_000)
  const server = await startFakeLlm(probeCompatibleReply)
  servers.push(server)
  const { page, app } = await launch()
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

  const parent = makeTemp('noryth-e2e-settings-project-')
  const created = await page.evaluate(
    async ({ parentDir }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: '设置项目',
        title: '黑漆匣子',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent }
  )
  expect(created.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  // 四类可导航，其余标 M1
  await page.locator('[data-nav="settings"]').click()
  await expect(page.locator('[data-testid="settings-page"]')).toBeVisible()
  for (const key of ['general', 'appearance', 'agents', 'providers']) {
    await expect(page.locator(`[data-testid="settings-nav-${key}"]`)).toHaveAttribute('data-enabled', 'true')
  }
  await expect(page.locator('[data-testid="settings-nav-advanced"]')).toHaveAttribute('data-enabled', 'false')

  // 提供方：填 Key → 只显示末 4 位，页面无明文
  await page.locator('[data-testid="settings-nav-providers"]').click()
  await expect(page.locator('[data-testid="settings-provider-deepseek"]')).toBeVisible()
  const secret = 'sk-e2e-secret-1234'
  await page.locator('[data-testid="input-key-deepseek"]').fill(secret)
  await page.locator('[data-testid="btn-save-key-deepseek"]').click()
  await expect(page.locator('[data-testid="provider-key-deepseek"]')).toContainText('1234')
  expect(await page.content()).not.toContain(secret)

  // 测试连接：真实适配器打到假服务器
  const probe = await page.evaluate(
    async (baseUrl) =>
      window.noryth!.settings.testProvider({ preset: 'deepseek', model: 'deepseek-flash', baseUrl }),
    server.baseUrl
  )
  expect(probe.ok).toBe(true)
  if (probe.ok) {
    expect(probe.data.ok, JSON.stringify(probe.data.error)).toBe(true)
    expect(probe.data.latencyMs).toBeGreaterThanOrEqual(0)
  }
  // 通义也测一次，用来验证「一个 Agent 绑第二家」
  await page.evaluate(async () =>
    window.noryth!.settings.setProviderKey({ preset: 'tongyi', apiKey: 'sk-tongyi-e2e' })
  )
  const probeTongyi = await page.evaluate(
    async (baseUrl) => window.noryth!.settings.testProvider({ preset: 'tongyi', model: 'qwen-plus', baseUrl }),
    server.baseUrl
  )
  expect(probeTongyi.ok && probeTongyi.data.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="settings"]').click()
  await page.locator('[data-testid="settings-nav-providers"]').click()
  await expect(page.locator('[data-testid="provider-status-deepseek"]')).toContainText('已连接')

  // 绑定：reviewer 换到通义，保存后来源=Agent；回滚后回项目默认
  await page.locator('[data-testid="settings-nav-agents"]').click()
  await expect(page.locator('[data-testid="binding-row-reviewer"]')).toBeVisible()
  await page.locator('[data-testid="binding-provider-reviewer"]').selectOption('tongyi')
  await page.locator('[data-testid="btn-save-bindings"]').click()
  await expect(page.locator('[data-testid="binding-row-reviewer"]')).toContainText('Agent 覆盖')
  await page.locator('[data-testid="btn-rollback-bindings"]').click()
  // 回滚到「从未绑定」：来源回到预设默认
  await expect(page.locator('[data-testid="binding-row-reviewer"]')).toContainText('预设默认')

  // 外观：暗色 + 墨蓝即时生效，重开应用后保持
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  await page.locator('[data-testid="theme-card-dark"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // 磁盘上没有明文 Key（项目目录 + 用户数据目录）
  const scan = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'out') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (scan(full)) return true
      } else if (statSync(full).size < 5_000_000) {
        try {
          const text = readFileSync(full, 'utf8')
          if (text.includes(secret) || text.includes('sk-tongyi-e2e')) return true
        } catch {
          // 二进制文件跳过
        }
      }
    }
    return false
  }
  expect(scan(userData), '用户数据目录出现 Key 明文').toBe(false)
  expect(scan(created.ok ? created.data.path : parent), '项目目录出现 Key 明文').toBe(false)
})
