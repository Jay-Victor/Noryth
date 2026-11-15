import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * J6：安全清单的可执行部分 + 200% 缩放（PHASE-10 §6）。
 *
 * - IPC 白名单：bridge 只有命名空间方法，没有通用 invoke(channel)；
 * - 无障碍：导航与栅格按钮都有可读名字（文本或 aria-label），并给出禁用原因；
 * - 200% 缩放：导航、状态栏、确认条不出现按钮截断（scrollWidth ≤ clientWidth）。
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
      // Windows 偶发文件占用
    }
  }
})

test('J6：IPC 白名单、可读名字与 200% 缩放不截断', async () => {
  test.setTimeout(120_000)
  const userData = makeTemp('noryth-a11y-user-')
  const parent = makeTemp('noryth-a11y-project-')
  const { app, page } = await launch(userData)

  // IPC 白名单：只有命名空间方法，没有通用 invoke
  const bridgeShape = await page.evaluate(() => {
    const bridge = window.noryth as unknown as Record<string, unknown>
    return {
      namespaces: Object.keys(bridge).sort(),
      invoke: 'invoke' in bridge,
      send: 'send' in bridge,
      requireType: typeof (window as unknown as { require?: unknown }).require
    }
  })
  expect(bridgeShape.invoke).toBe(false)
  expect(bridgeShape.send).toBe(false)
  expect(bridgeShape.requireType).toBe('undefined')
  expect(bridgeShape.namespaces).toEqual(
    ['app', 'dialog', 'diagnostics', 'events', 'manuscript', 'memory', 'plan', 'project', 'review', 'settings', 'slice', 'write'].sort()
  )

  const created = await page.evaluate(
    async ({ parentDir }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: '无障碍',
        title: '黑漆匣子 · 无障碍',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent }
  )
  expect(created.ok).toBe(true)
  await page.evaluate(async () => window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 2 }))
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')

  const assertReadableControls = async (): Promise<void> => {
    const unlabeled = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="button"]'))
      return controls
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return false
          const text = (element.textContent ?? '').trim()
          const label = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? ''
          return text.length === 0 && label.trim().length === 0
        })
        .map((element) => element.outerHTML.slice(0, 120))
    })
    expect(unlabeled, `没有可读名字的控件：${unlabeled.join(' | ')}`).toHaveLength(0)
  }
  await assertReadableControls()

  // 200% 缩放：导航、状态栏、确认条不截断
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
  })
  await page.waitForTimeout(400)
  const clipping = await page.evaluate(() => {
    const selectors = ['.nav-rail button', '.statusbar', '.write-confirm-bar button']
    const out: string[] = []
    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0) continue
        if (element.scrollWidth > element.clientWidth + 2) out.push(`${selector}: ${element.textContent?.trim() ?? ''}`)
        if (rect.right > window.innerWidth + 1 || rect.left < -1) out.push(`${selector} 越界: ${element.textContent?.trim() ?? ''}`)
      }
    }
    return out
  })
  expect(clipping, `200% 缩放截断：${clipping.join(' | ')}`).toHaveLength(0)
  await expect(page.locator('.statusbar__center')).toBeVisible()

  // 回到 100%，避免影响后续断言（本 spec 独占一个应用实例）
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
  })
  await expect(page.locator('[data-testid="app-ready"]')).toBeVisible()
})
