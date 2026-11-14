import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { GRID, chatWidth, modeForWidth, previewWidth, type LayoutMode } from '../../src/shared/layout/grid'

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData = makeTemp('noryth-e2e-user-')): Promise<{ app: ElectronApplication; page: Page }> {
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

async function createProjectViaIpc(page: Page, parent: string, folderName: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, folder }) => {
      return window.noryth!.project.create({
        parentDir,
        folderName: folder,
        title: '黑漆匣子',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      })
    },
    { parentDir: parent, folder: folderName }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  // IPC 直调不会经过 renderer store：重载后由 project.current() 同步界面状态
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
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
      // Windows 上偶发文件占用，留给系统清理
    }
  }
})

test('外壳、安全边界与三档栅格', async () => {
  const { page } = await launch()

  await expect(page).toHaveTitle(/Noryth/)
  const security = await page.evaluate(() => ({
    bridge: typeof window.noryth,
    requireType: typeof (window as unknown as { require?: unknown }).require,
    processType: typeof (window as unknown as { process?: unknown }).process
  }))
  expect(security.bridge).toBe('object')
  expect(security.requireType).toBe('undefined')
  expect(security.processType).toBe('undefined')
  // CSP connect-src 'none' 在渲染层生效
  const fetchBlocked = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/')
      return false
    } catch {
      return true
    }
  })
  expect(fetchBlocked).toBe(true)

  // 无项目：规划/创作/审批/记忆置灰，并给出原因
  for (const nav of ['plan', 'write', 'review', 'memory']) {
    const item = page.locator(`[data-nav="${nav}"]`)
    await expect(item).toHaveAttribute('aria-disabled', 'true')
    await expect(item).toHaveAttribute('title', '先打开一个项目')
  }
  await page.locator('[data-nav="write"]').click({ force: true })
  await expect(page.locator('.toast')).toContainText('先打开一个项目')

  // 命令面板：Ctrl K 打开，Esc 关闭并归位焦点
  await page.locator('.titlebar__hint button').click()
  await expect(page.locator('.palette')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toBeHidden()
  const focusLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
  expect(focusLabel).toContain('打开命令面板')

  // 建项目后进入规划台，四栅可测
  const parent = makeTemp('noryth-e2e-grid-')
  await createProjectViaIpc(page, parent, '栅格项目')
  await page.locator('[data-nav="plan"]').click()
  await expect(page.locator('[data-testid="pane-chat"]')).toBeVisible()

  const measure = async (): Promise<Record<string, number>> => {
    return page.evaluate(() => {
      const ids = ['pane-sessions', 'pane-chat', 'pane-preview', 'pane-tree']
      const out: Record<string, number> = {}
      for (const id of ids) {
        const node = document.querySelector(`[data-testid="${id}"]`)
        out[id] = node ? node.getBoundingClientRect().width : -1
      }
      out.innerWidth = window.innerWidth
      return out
    })
  }

  // Electron 窗口尺寸需要主进程 API
  const electronApp = apps[0]!
  for (const width of [1280, 1440, 1600]) {
    await electronApp.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setContentSize(w, 800)
    }, width)
    await page.waitForTimeout(250)
    const widths = await measure()
    const mode: LayoutMode = modeForWidth(width)
    expect(widths.innerWidth).toBe(width)
    const expected: Record<string, number> = {
      'pane-sessions': GRID[mode].sessions,
      'pane-tree': GRID[mode].tree,
      'pane-chat': chatWidth(width, mode),
      'pane-preview': previewWidth(width, mode)
    }
    for (const [pane, value] of Object.entries(expected)) {
      const diff = Math.abs((widths[pane] ?? 0) - value)
      expect(diff, `${pane} @${width} actual=${widths[pane]} expected=${value}`).toBeLessThanOrEqual(1)
    }
  }
})

test('通过向导新建项目：目录、数据库与 G0 记录', async () => {
  const { page } = await launch()
  const parent = makeTemp('noryth-e2e-new-')
  const folder = '黑漆匣子'
  const dir = join(parent, folder)

  await page.getByRole('button', { name: /新建项目/ }).first().click()
  await expect(page.locator('[data-testid="new-project-dialog"]')).toBeVisible()
  await page.locator('[data-testid="input-parent-dir"]').fill(parent)
  await page.locator('[data-testid="input-folder-name"]').fill(folder)
  await page.locator('[data-testid="btn-next"]').click()
  await expect(page.locator('[data-testid="input-title"]')).toHaveValue(folder)
  await page.locator('[data-testid="btn-preview"]').click()
  await expect(page.locator('[data-testid="btn-create"]')).toBeVisible()
  await page.locator('[data-testid="btn-create"]').click()

  await expect(page.locator('.toast').filter({ hasText: '项目「黑漆匣子」已创建' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'plan')

  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    expect(existsSync(join(dir, sub)), sub).toBe(true)
  }
  expect(existsSync(join(dir, 'noryth.db'))).toBe(true)
  expect(existsSync(join(dir, '.noryth.lock'))).toBe(true)
  const entries = readdirSync(dir).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
  expect(entries.sort()).toEqual(
    ['.noryth.lock', 'assets', 'backups', 'exports', 'logs', 'manuscript', 'noryth.db'].sort()
  )

  const db = new Database(join(dir, 'noryth.db'), { readonly: true })
  try {
    const project = db.prepare('SELECT * FROM project LIMIT 1').get() as Record<string, unknown>
    expect(project.title).toBe('黑漆匣子')
    expect(project.setup_state).toBe('pending')
    const gate = db.prepare("SELECT * FROM gate_record WHERE gate_id = 'G0'").get() as Record<string, unknown>
    expect(gate.entity_type).toBe('project')
    expect(gate.decision).toBe('approve')
  } finally {
    db.close()
  }

  // G1 未确认：创作台仍置灰
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'true')

  // 回首页能看到项目与统计
  await page.locator('[data-nav="home"]').click()
  await expect(page.locator('[data-testid="project-list"]')).toContainText('黑漆匣子')
  await expect(page.locator('.statusbar__center')).toContainText('蓝图未确认')
})

test('双开同一项目：第二窗口只读，写 IPC 被主进程拒绝', async () => {
  const parent = makeTemp('noryth-e2e-lock-')
  const first = await launch()
  const created = await createProjectViaIpc(first.page, parent, '双开项目')

  const second = await launch()
  const opened = await second.page.evaluate(async (path) => {
    return window.noryth!.project.open({ path })
  }, created.path)
  expect(opened.ok).toBe(true)
  if (!opened.ok) throw new Error(opened.error.code)
  expect(opened.data.readOnly).toBe(true)
  expect(opened.data.readOnlyReason).toBe('locked')

  await second.page.reload()
  await second.page.waitForSelector('[data-testid="app-ready"]')
  await expect(second.page.locator('.readonly-banner')).toBeVisible()
  await expect(second.page.locator('.statusbar__center')).toContainText('只读')

  const write = await second.page.evaluate(async (projectId) => {
    return window.noryth!.project.updateMeta({ projectId, title: '不应写入' })
  }, created.projectId)
  expect(write.ok).toBe(false)
  if (!write.ok) expect(write.error.code).toBe('project_locked')

  await second.app.close()
  const db = new Database(join(created.path, 'noryth.db'), { readonly: true })
  try {
    expect((db.prepare('SELECT title FROM project').get() as { title: string }).title).toBe('黑漆匣子')
  } finally {
    db.close()
  }
})

test('打开路径不可用时给出错误码', async () => {
  const { page } = await launch()
  const missing = join(makeTemp('noryth-e2e-missing-'), '不存在')
  const result = await page.evaluate(async (path) => window.noryth!.project.open({ path }), missing)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe('project_not_found')
    expect(result.error.message).toBe('项目不存在或路径不可用')
  }
  await expect(page.locator('[data-testid="project-empty"]')).toBeVisible()
})
