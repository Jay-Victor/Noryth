import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-SWITCH-01（PHASE-11 §6）：
 * 多项目切换不串状态；运行中切换必须确认，取消保留 draft；
 * 启动自动打开上次项目，失败/被占用回首页且不自动只读打开。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(
  userData: string,
  extra: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
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
  Object.assign(env, extra)

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string, folder: string, title: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name, label }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: label,
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent, name: folder, label: title }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  return { projectId: result.data.projectId, path: result.data.path }
}

async function currentProjectId(page: Page): Promise<string | null> {
  const result = await page.evaluate(() => window.noryth!.project.current())
  return result.ok ? (result.data?.project.id ?? null) : null
}

async function seedAndArm(page: Page): Promise<void> {
  const seeded = await page.evaluate(() => window.noryth!.write.devSeed({}))
  expect(seeded.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible()
  await page.locator('[data-testid="write-tab-prose"]').click()
}

function countRevisions(projectPath: string): { revisions: number; confirmed: number } {
  const db = new Database(join(projectPath, 'noryth.db'), { readonly: true })
  try {
    const revisions = (db.prepare('SELECT COUNT(*) AS count FROM revision').get() as { count: number }).count
    const confirmed = (
      db.prepare("SELECT COUNT(*) AS count FROM beat WHERE status IN ('confirmed','author_edited')").get() as {
        count: number
      }
    ).count
    return { revisions, confirmed }
  } finally {
    db.close()
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

test('E2E-M1-SWITCH-01：A 写一拍 → 切 B → 回 A，revision 与未确认拍不变', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-switch-user-')
  const parentB = makeTemp('noryth-switch-b-')
  const parentA = makeTemp('noryth-switch-a-')
  const { page } = await launch(userData)

  // 先建 B 再建 A：两个项目都在项目库里，A 是当前项目。
  await createProject(page, parentB, '乙项目', '乙项目')
  const a = await createProject(page, parentA, '甲项目', '甲项目')
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  await seedAndArm(page)
  await page.locator('[data-testid="write-generate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
  await page.locator('[data-testid="write-confirm"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeDisabled({ timeout: 10_000 })

  const proseBefore = await page.locator('[data-testid="write-prose"]').innerText()
  const proseBeforeFlat = proseBefore.replace(/\s+/g, '')
  const chapterStatusBefore = await page
    .locator('[data-testid^="write-chapter-status-"]')
    .first()
    .innerText()
  const before = countRevisions(a.path)
  expect(before.confirmed).toBe(1)

  // 切到 B：首页双击另一行
  await page.locator('[data-nav="home"]').click()
  await expect(page.locator('[data-testid="project-list"]')).toBeVisible()
  const bRow = page.locator('[data-project-id]').filter({ hasText: '乙项目' })
  await bRow.dblclick()
  await expect(page.locator('[data-testid="pane-chat"]')).toBeVisible()
  const bId = await page.evaluate(() => window.noryth!.project.current())
  expect(bId.ok && bId.data?.project.title).toBe('乙项目')
  expect(await currentProjectId(page)).not.toBe(a.projectId)

  // B 没有章节、也没过 G1：既拿不到 A 的写状态，创作台也按 B 的状态置灰
  const bState = await page.evaluate(() => window.noryth!.write.state())
  expect(bState.ok).toBe(false)
  if (!bState.ok) expect(bState.error.code).toBe('invalid_args')
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'true')

  // 回 A：正文、章状态、revision 全部不变
  await page.locator('[data-nav="home"]').click()
  const aRow = page.locator('[data-project-id]').filter({ hasText: '甲项目' })
  await aRow.dblclick()
  await expect(page.locator('[data-testid="pane-chat"]')).toBeVisible()
  expect(await currentProjectId(page)).toBe(a.projectId)
  await page.locator('[data-nav="write"]').click()
  await expect(page.locator('[data-testid="write-prose"]')).toBeVisible()
  await expect
    .poll(async () => (await page.locator('[data-testid="write-prose"]').innerText()).replace(/\s+/g, ''), {
      timeout: 15_000
    })
    .toBe(proseBeforeFlat)
  await expect(page.locator('[data-testid^="write-chapter-status-"]').first()).toHaveText(chapterStatusBefore, {
    timeout: 15_000
  })

  const after = countRevisions(a.path)
  expect(after).toEqual(before)

  const state = await page.evaluate(() => window.noryth!.write.state())
  expect(state.ok).toBe(true)
  if (state.ok) {
    expect(state.data.projectId).toBe(a.projectId)
    expect(state.data.chapters[0]?.confirmedCount).toBe(1)
  }
})

test('运行中切项目：无 cancelRunning 被拒，确认后取消并保留 draft', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-switch-busy-user-')
  const parentA = makeTemp('noryth-switch-busy-a-')
  const parentB = makeTemp('noryth-switch-busy-b-')
  // 放慢流式，保证「切」发生在生成中途。
  const { page } = await launch(userData, { NORYTH_WRITE_STREAM_DELAY_MS: '120' })

  const b = await createProject(page, parentB, '乙项目', '乙项目')
  const a = await createProject(page, parentA, '甲项目', '甲项目')
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await seedAndArm(page)

  const beatId = await page.evaluate(async () => {
    const state = await window.noryth!.write.state()
    if (!state.ok) return null
    return state.data.scenes[0]?.beats[0]?.id ?? null
  })
  expect(beatId).toBeTruthy()

  // 不 await：让生成留在进行中
  await page.evaluate(async (id) => {
    void window.noryth!.write.generate(id!)
  }, beatId)

  await expect
    .poll(
      async () => {
        const busy = await page.evaluate(() => window.noryth!.project.busy())
        return busy.ok ? busy.data.busy : false
      },
      { timeout: 20_000 }
    )
    .toBe(true)

  const rejected = await page.evaluate(async (path) => window.noryth!.project.open({ path }), b.path)
  expect(rejected.ok).toBe(false)
  if (!rejected.ok) expect(rejected.error.code).toBe('project_busy')

  const switched = await page.evaluate(async (path) => window.noryth!.project.open({ path, cancelRunning: true }), b.path)
  expect(switched.ok).toBe(true)
  if (switched.ok) expect(switched.data.project.title).toBe('乙项目')

  // 回到 A：没有丢已确认拍；被取消的那一拍回滚到「待生成」，不留半条正文。
  await page.evaluate(async (path) => window.noryth!.project.open({ path }), a.path)
  const confirmed = countRevisions(a.path).confirmed
  expect(confirmed).toBe(0)
  const db = new Database(join(a.path, 'noryth.db'), { readonly: true })
  try {
    const generating = (
      db.prepare("SELECT COUNT(*) AS count FROM beat WHERE status IN ('generating','regenerating')").get() as {
        count: number
      }
    ).count
    expect(generating).toBe(0)
    const withBody = (
      db
        .prepare("SELECT COUNT(*) AS count FROM beat WHERE status <> 'superseded' AND length(body) > 0")
        .get() as { count: number }
    ).count
    expect(withBody).toBe(0)
    // 章仍在，分镜与拍数没变：切换只取消生成，不动结构。
    const beats = (db.prepare('SELECT COUNT(*) AS count FROM beat').get() as { count: number }).count
    expect(beats).toBe(24)
  } finally {
    db.close()
  }
})

test('启动自动打开上次项目：成功、关闭开关、锁占用三种路径', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-autopen-user-')
  const parent = makeTemp('noryth-autopen-project-')

  const first = await launch(userData)
  const project = await createProject(first.page, parent, '上次项目', '上次项目')
  await expect.poll(async () => currentProjectId(first.page), { timeout: 10_000 }).toBe(project.projectId)
  await first.app.close()

  // 1) 正常：启动直接回到规划台
  const second = await launch(userData)
  await expect.poll(async () => currentProjectId(second.page), { timeout: 20_000 }).toBe(project.projectId)
  await expect(second.page.locator('[data-testid="pane-chat"]')).toBeVisible()
  await expect(second.page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'plan')

  // 2) 关掉开关：停在首页，项目不在内存里
  await second.page.evaluate(async () => window.noryth!.settings.set({ openLastProject: false }))
  await second.app.close()
  const third = await launch(userData)
  await third.page.waitForTimeout(1_500)
  await expect(third.page.locator('[data-testid="project-empty"], [data-testid="project-list"]')).toBeVisible()
  expect(await currentProjectId(third.page)).toBeNull()
  await expect(third.page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'home')
  await third.page.evaluate(async () => window.noryth!.settings.set({ openLastProject: true }))
  await third.app.close()

  // 3) 被占用：写一个「存活进程」持有的锁 → 回首页，不自动只读打开
  writeFileSync(
    join(project.path, '.noryth.lock'),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      windowId: 'win_other',
      appVersion: '0.1.0',
      heartbeatAt: new Date().toISOString()
    }),
    'utf8'
  )
  expect(existsSync(join(project.path, '.noryth.lock'))).toBe(true)
  const fourth = await launch(userData)
  await expect(fourth.page.locator('.toast')).toContainText('上次项目在另一窗口打开', { timeout: 20_000 })
  expect(await currentProjectId(fourth.page)).toBeNull()
  await expect(fourth.page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'home')
  // 不自动只读打开：没有只读横幅，也没有内存中的项目
  await expect(fourth.page.locator('.readonly-banner')).toHaveCount(0)
})
