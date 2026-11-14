import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-WRITE-01/02（PHASE-07 §6）。
 *
 * 用未打包构建 + `NORYTH_WRITE_FAKE=1` 的假适配器驱动真实 UI：
 *   devSeed（1 章 3 场 24 拍）→ G2 → 前 6 拍 4 确认 2 重生成 → 自动模式跑完；
 * 以及自动模式在出口处停、不超拍数。
 *
 * 只读 DB 断言用 better-sqlite3；UI 断言看状态与计数，不比对文案全文。
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
  delete env.NORYTH_PLAN_API_KEY

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
        title: '黑漆匣子 · 创作台',
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
  return { projectId: result.data.projectId, path: result.data.path }
}

async function seedAndOpen(page: Page, options: { scenes?: number; beatsPerScene?: number; exit?: string } = {}): Promise<void> {
  const seeded = await page.evaluate(async (input) => window.noryth!.write.devSeed(input), options)
  expect(seeded.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
}

async function startG2(page: Page): Promise<void> {
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await expect(page.locator('[data-testid="write-storyboard-summary"]')).toContainText('拍')
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await expect(page.locator('[data-testid="write-tab-prose"]')).toBeVisible()
  await page.locator('[data-testid="write-tab-prose"]').click()
}

async function generateWaiting(page: Page): Promise<void> {
  await page.locator('[data-testid="write-generate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
}

async function confirmBeat(page: Page): Promise<void> {
  await page.locator('[data-testid="write-confirm"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeDisabled({ timeout: 10_000 })
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

test('E2E-WRITE-01：3 场 24 拍，前 6 拍 4 确认 2 重生成，自动模式跑完', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-write-user-')
  const parent = makeTemp('noryth-write-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent, '创作台主流程')

  await seedAndOpen(page)
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await expect(page.locator('[data-testid="write-storyboard-summary"]')).toContainText('24 拍')

  // 分镜有冲突：G2 禁用并给第一条原因（出口写成自然语言）
  const exitInput = page.locator('[data-testid="write-scene-exit-1"]')
  await exitInput.fill('等他们吵完')
  await page.locator('[data-testid="write-storyboard-save"]').click()
  await expect(page.locator('[data-testid="write-g2-blocker"]')).toContainText('出口条件')
  await expect(page.locator('[data-testid="write-g2"]')).toBeDisabled()
  await exitInput.fill('all(fact("black_box","location"), beats(8))')
  await page.locator('[data-testid="write-storyboard-save"]').click()
  await expect(page.locator('[data-testid="write-g2"]')).toBeEnabled({ timeout: 10_000 })

  await startG2(page)

  // 6 拍：4 确认 + 2 重生成
  await generateWaiting(page)
  await confirmBeat(page)

  await generateWaiting(page)
  const secondBody = await page.locator('[data-testid="write-prose"]').innerText()
  await page.locator('[data-testid="write-regenerate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
  expect(await page.locator('[data-testid="write-prose"]').innerText()).not.toBe(secondBody)
  await confirmBeat(page)

  await generateWaiting(page)
  await confirmBeat(page)

  // 编辑 + IME 守卫：文字超过 200 字，回车不提交
  await generateWaiting(page)
  await page.locator('[data-testid="write-edit"]').click()
  const editInput = page.locator('[data-testid^="write-edit-input-"]')
  const longText = '她把茶盏往他那边推了推，声音压得很低。'.repeat(12)
  expect([...longText].length).toBeGreaterThan(200)
  await editInput.fill(longText)
  await editInput.press('Enter')
  // 保存必须点按钮：回车留在编辑框里，不触发确认（确认会让按钮变灰）。
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled()
  const kept = await editInput.inputValue()
  expect(kept.startsWith(longText)).toBe(true) // 200 字不丢；回车只是换行
  await page.getByRole('button', { name: '取消' }).click()

  // 第四拍：重生成两次再确认（累计 2 拍重生成）
  await page.locator('[data-testid="write-regenerate"]').click()
  await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 30_000 })
  await confirmBeat(page)

  await generateWaiting(page)
  await confirmBeat(page)

  await generateWaiting(page)
  await confirmBeat(page)

  await expect(page.locator('[data-testid="write-beat-position"]')).toContainText('拍 7/24')

  // 自动模式：预检 → 开跑
  await page.locator('[data-testid="write-auto"]').click()
  await expect(page.locator('[data-testid="write-preflight"]')).toBeVisible()
  await page.locator('[data-testid="write-auto-confirm"]').click()
  await expect(page.locator('[data-testid="write-draft-complete"]')).toBeVisible({ timeout: 180_000 })
  await expect(page.locator('[data-testid="write-scene-progress"]')).toContainText('3/3')

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const chapter = db.prepare("SELECT status FROM chapter WHERE id = 'ch_write_01'").get() as
      | { status: string }
      | undefined
    // devSeed 不固定章 id：回退到第一行
    const actual = chapter ?? (db.prepare('SELECT status FROM chapter ORDER BY ord LIMIT 1').get() as { status: string })
    expect(actual.status).toBe('draft_complete')

    const live = db
      .prepare("SELECT status, COUNT(*) AS count FROM beat WHERE status <> 'superseded' GROUP BY status")
      .all() as Array<{ status: string; count: number }>
    const byStatus = Object.fromEntries(live.map((row) => [row.status, row.count]))
    expect(byStatus['confirmed']).toBe(24)
    expect(byStatus['waiting_for_human']).toBeUndefined()

    const doubleLive = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT scene_id, ord FROM beat WHERE status <> 'superseded' GROUP BY scene_id, ord HAVING COUNT(*) > 1
         )`
      )
      .get() as { count: number }
    expect(doubleLive.count).toBe(0)

    const superseded = db
      .prepare("SELECT COUNT(*) AS count FROM beat WHERE status = 'superseded'")
      .get() as { count: number }
    expect(superseded.count).toBeGreaterThanOrEqual(4)
  } finally {
    db.close()
  }
})

test('E2E-WRITE-02：自动模式在出口条件处停，不超 max_beats', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-write-exit-user-')
  const parent = makeTemp('noryth-write-exit-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent, '创作台收束')
  await seedAndOpen(page, { scenes: 1, beatsPerScene: 6, exit: 'all(fact("black_box","location"), beats(3))' })
  await startG2(page)

  await page.locator('[data-testid="write-auto"]').click()
  await page.locator('[data-testid="write-auto-confirm"]').click()
  await expect(page.locator('[data-testid="write-draft-complete"]')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('[data-testid="write-scene-progress"]')).toContainText('1/1')

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const counts = db
      .prepare("SELECT status, COUNT(*) AS count FROM beat GROUP BY status")
      .all() as Array<{ status: string; count: number }>
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.count]))
    expect(byStatus['confirmed']).toBe(3)
    expect(byStatus['proposed']).toBe(3)

    const chapter = db.prepare('SELECT status FROM chapter ORDER BY ord LIMIT 1').get() as { status: string }
    expect(chapter.status).toBe('draft_complete')
  } finally {
    db.close()
  }
})
