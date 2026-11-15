import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-TREE-01（PHASE-11 §6 / UI-DESIGN §11）：
 * 1440×900 打开文件树抽屉不改变正文列宽；焦点可进入、Esc 回到触发元素；
 * 30+ 章列表走虚拟列表（DOM 行数远小于章数），滚动无 >50ms 长任务。
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
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 文件树',
        genre: '悬疑',
        targetWords: 150_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent, name: folder }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  return { projectId: result.data.projectId, path: result.data.path }
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

test('E2E-M1-TREE-01：1440 下抽屉不挤压正文；焦点可进出；30+ 章虚拟滚动', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-tree-user-')
  const parent = makeTemp('noryth-tree-project-')
  const { app, page } = await launch(userData)
  await createProject(page, parent, '文件树项目')

  // 40 章：多到足以证明列表是虚化的（DOM 行数 < 章数）。
  const seeded = await page.evaluate(() => window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 2, chapters: 40 }))
  expect(seeded.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // 1440×900（W2）：文件树是 44px 轨道，抽屉为 overlay。
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setContentSize(1440, 900)
  })
  await expect(page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-mode', 'W2')

  const measure = async (): Promise<{ preview: number; prose: number }> => {
    const preview = await page.locator('[data-testid="pane-preview"]').boundingBox()
    const prose = await page.locator('[data-testid="write-prose"]').boundingBox()
    return { preview: preview?.width ?? -1, prose: prose?.width ?? -1 }
  }

  const before = await measure()
  expect(before.preview).toBeGreaterThan(500)

  // Ctrl+B 打开抽屉
  await page.keyboard.press('Control+b')
  const drawer = page.locator('[data-testid="tree-drawer"]')
  await expect(drawer).toBeVisible()
  const drawerBox = await drawer.boundingBox()
  expect(Math.round(drawerBox?.width ?? 0)).toBe(320)
  await expect(drawer).toHaveAttribute('role', 'dialog')

  // 正文列宽不变（overlay 不参与栅格）
  const during = await measure()
  expect(during.preview).toBe(before.preview)
  expect(during.prose).toBe(before.prose)

  // 焦点在抽屉内（可进入）
  expect(
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="tree-drawer"]')
      return node ? node.contains(document.activeElement) : false
    })
  ).toBe(true)

  // Esc 关闭：抽屉关闭，焦点不留在已卸载的节点上
  await page.locator('[data-testid="tree-drawer-close"]').focus()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // 从轨道按钮打开（触发元素聚焦），Esc 后焦点回到它
  await page.locator('[data-testid="tree-open"]').click()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')).toBe('tree-open')

  // 选中文件即关闭，并跳到对应页面/章
  await page.locator('[data-testid="tree-open"]').click()
  await expect(drawer).toBeVisible()
  const chapterNode = page.locator('[data-testid^="tree-node-ch_"]').first()
  await expect(chapterNode).toBeVisible()
  await chapterNode.click()
  await expect(drawer).toBeHidden()
  await expect(page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'write')

  // 章列表虚拟化：40 章只渲染可视区 + overscan
  const rendered = await page.locator('[data-testid="write-chapter-list"] [data-index]').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(40)

  // 滚动 1,000 行等价距离：无 >50ms 长任务
  const longTasks = await page.evaluate(async () => {
    const durations: number[] = []
    let observer: PerformanceObserver
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) durations.push(entry.duration)
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      return []
    }
    const list = document.querySelector('[data-testid="write-chapter-list"]')
    if (!list) return []
    for (let step = 0; step < 60; step += 1) {
      list.scrollTop = step * 32 * 4
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    }
    list.scrollTop = 0
    await new Promise((resolve) => setTimeout(resolve, 200))
    observer.disconnect()
    return durations.filter((duration) => duration > 50)
  })
  expect(longTasks).toHaveLength(0)

  // 200% 缩放：轨道按钮不截断且完整落在视口内；抽屉仍可打开并盖在最上层
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
  })
  await page.waitForTimeout(300)
  const zoomState = await page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="tree-open"]')
    if (!trigger) return null
    const rect = trigger.getBoundingClientRect()
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    }
  })
  expect(zoomState).not.toBeNull()
  if (!zoomState) throw new Error('tree trigger missing at 200%')
  expect(zoomState.width).toBeGreaterThan(20)
  expect(zoomState.height).toBeGreaterThan(20)
  expect(zoomState.right).toBeLessThanOrEqual(zoomState.innerWidth + 1)
  expect(zoomState.bottom).toBeLessThanOrEqual(zoomState.innerHeight + 1)
  expect(zoomState.left).toBeGreaterThanOrEqual(0)
  await expect(page.locator('[data-testid="tree-open"]')).toHaveAttribute('aria-label', '打开文件树')

  await page.locator('[data-testid="tree-open"]').click()
  await expect(drawer).toBeVisible()
  // 抽屉宽度固定 320，不超出视口；中心点命中的必须是抽屉内部（盖在正文之上）
  const zoomDrawer = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="tree-drawer"]')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      width: rect.width,
      right: rect.right,
      innerWidth: window.innerWidth,
      inside: node.contains(hit)
    }
  })
  expect(Math.round(zoomDrawer?.width ?? 0)).toBe(320)
  expect(zoomDrawer?.right ?? 1e9).toBeLessThanOrEqual((zoomDrawer?.innerWidth ?? 0) + 1)
  expect(zoomDrawer?.inside).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
  })
})
