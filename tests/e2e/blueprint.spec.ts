import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-BLUEPRINT-01（PHASE-15 §6）：
 * G1 后改主线 → 影响分析列出受影响章 → 确认应用 → 3 章 invalidated_at 非空
 * → G2/G4 提示 → 作者忽略后继续（正文与版本都不变）。
 *
 * E2E-M1-FORESHADOW-01：
 * 标注 3 条 → open 3 → 回收 1 → 2；距离随基准章变化；超期只报节奏，不阻断。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = makeTemp('noryth-e2e-bp-user-')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_PLAN_FAKE = '1'

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子',
        genre: '悬疑',
        targetWords: 90_000,
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

/** devSeed 等价 G1 完成 + N 章（未打包构建才注册）。 */
async function devSeed(page: Page, chapters: number): Promise<void> {
  const seeded = await page.evaluate(
    async (count) => window.noryth!.write.devSeed({ chapters: count }),
    chapters
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
}

interface DbSnapshot {
  chapterIds: string[]
  invalidated: Array<string | null>
  mainTitle: string
  beatBodies: string[]
  revisionIds: string[]
}

function readDb(dbPath: string): DbSnapshot {
  const db = new Database(dbPath, { readonly: true })
  try {
    const chapters = db.prepare('SELECT id, invalidated_at FROM chapter ORDER BY ord').all() as Array<{
      id: string
      invalidated_at: string | null
    }>
    const main = db
      .prepare("SELECT title FROM outline_node WHERE kind = 'main' ORDER BY ord LIMIT 1")
      .get() as { title: string }
    const beats = db
      .prepare("SELECT body FROM beat WHERE status <> 'superseded' ORDER BY seq")
      .all() as Array<{ body: string }>
    const revisions = db.prepare('SELECT id FROM revision ORDER BY created_at').all() as Array<{ id: string }>
    return {
      chapterIds: chapters.map((row) => row.id),
      invalidated: chapters.map((row) => row.invalidated_at),
      mainTitle: main.title,
      beatBodies: beats.map((row) => row.body),
      revisionIds: revisions.map((row) => row.id)
    }
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

test('E2E-M1-BLUEPRINT-01：改主线 → 影响分析 → 应用 → 标脏 → G2/G4 提示 → 忽略', async () => {
  test.setTimeout(150_000)
  const parent = makeTemp('noryth-e2e-blueprint-')
  const { page } = await launch()
  const created = await createProject(page, parent, '蓝图变更项目')
  await devSeed(page, 3)

  const dbPath = join(created.path, 'noryth.db')
  const before = readDb(dbPath)
  expect(before.chapterIds).toHaveLength(3)
  expect(before.invalidated.every((value) => value === null)).toBe(true)

  // 规划台 → 蓝图：选中根节点（主线），改标题 = 提交变更（不是直接写大纲）
  await page.locator('[data-nav="plan"]').click()
  await page.waitForSelector('[data-testid="blueprint-pane"]')
  await page.locator('[data-testid="outline-tree"] [data-testid^="outline-node-"]').first().click()
  const title = page.locator('[data-testid="outline-title"]')
  await expect(title).toBeEnabled()
  await title.fill('主线：黑漆匣子（改）')
  await title.press('Tab')

  // 变更记录出现在覆盖检查 tab；未确认前大纲不变
  await page.locator('[data-testid="plan-tab-coverage"]').click()
  const card = page.locator('[data-testid^="change-card-"]').first()
  await card.waitFor({ timeout: 20_000 })
  await expect(card.locator('[data-testid^="change-impact-"]')).toContainText('3 章')
  expect(readDb(dbPath).mainTitle).not.toBe('主线：黑漆匣子（改）')

  // 确认应用 → 3 章标脏；正文与 revision 不变
  await card.locator('[data-testid^="change-apply-"]').click()
  await expect(card).toContainText('已应用', { timeout: 20_000 })
  const applied = readDb(dbPath)
  expect(applied.mainTitle).toBe('主线：黑漆匣子（改）')
  expect(applied.invalidated.filter((value) => value !== null)).toHaveLength(3)
  expect(applied.beatBodies).toEqual(before.beatBodies)
  expect(applied.revisionIds).toEqual(before.revisionIds)

  // G2 提示：创作台横幅 + 可忽略
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  const banner = page.locator('[data-testid="write-invalidated"]')
  await expect(banner).toBeVisible({ timeout: 20_000 })
  await expect(banner).toContainText('正文与已定稿版本都没有改动')

  // G4 提示：审批台同样提示，但不阻断
  await page.locator('[data-nav="review"]').click()
  await expect(page.locator('[data-testid="review-invalidated"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="review-finalize"]')).toBeVisible()

  // 作者忽略：横幅消失，正文与章状态不变
  await page.locator('[data-nav="write"]').click()
  await page.locator('[data-testid="write-invalidated-dismiss"]').click()
  await expect(page.locator('[data-testid="write-invalidated"]')).toHaveCount(0, { timeout: 20_000 })
  const dismissed = readDb(dbPath)
  expect(dismissed.invalidated.filter((value) => value !== null)).toHaveLength(2)
  expect(dismissed.beatBodies).toEqual(before.beatBodies)
  expect(dismissed.revisionIds).toEqual(before.revisionIds)
})

test('E2E-M1-FORESHADOW-01：标注 3 条 → open 3 → 回收 1 → 2；距离随基准章变化', async () => {
  test.setTimeout(120_000)
  const parent = makeTemp('noryth-e2e-foreshadow-')
  const { page } = await launch()
  await createProject(page, parent, '伏笔项目')
  await devSeed(page, 3)

  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="memory-tab-foreshadows"]').click()
  await page.waitForSelector('[data-testid="foreshadow-panel"]', { timeout: 20_000 })

  const create = async (text: string, plantedIndex: number, plannedIndex: number): Promise<void> => {
    await page.locator('[data-testid="foreshadow-create-text"]').fill(text)
    await page.locator('[data-testid="foreshadow-create-planted"]').selectOption({ index: plantedIndex })
    await page.locator('[data-testid="foreshadow-create-planned"]').selectOption({ index: plannedIndex })
    await page.locator('[data-testid="foreshadow-create-submit"]').click()
  }

  // 第 1 章埋 2 条（第 2 条计划第 2 章回收），第 2 章埋 1 条
  await create('匣子底部的林家族徽', 0, 0)
  await expect(page.locator('.foreshadow-row')).toHaveCount(1, { timeout: 15_000 })
  await create('老太爷的旧信', 0, 2)
  await expect(page.locator('.foreshadow-row')).toHaveCount(2, { timeout: 15_000 })
  await create('账本最后一页', 1, 0)
  await expect(page.locator('.foreshadow-row')).toHaveCount(3, { timeout: 15_000 })
  await expect(page.locator('[data-testid="foreshadow-counts"]')).toContainText('未回收 3')

  // 距离基准 = 第 3 章：两条「已 2 章」，一条「已 1 章」；计划第 2 章的那条标超期
  await page.locator('[data-testid="foreshadow-chapter"]').selectOption({ index: 2 })
  await expect(page.locator('[data-testid="foreshadow-counts"]')).toContainText('未回收 3', { timeout: 15_000 })
  await expect(page.locator('[data-testid="foreshadow-panel"]')).toContainText('已 2 章未回收（超计划）')
  const distances = await page.evaluate(async () => {
    const bridge = window.noryth
    if (!bridge) return []
    const state = await bridge.world.foreshadows({})
    return state.ok ? state.data.items.map((item) => item.distance) : []
  })
  expect(distances.sort()).toEqual([1, 2, 2])

  // 回收 1 条 → open 2
  const first = page.locator('[data-testid^="foreshadow-row-"]').first()
  await first.locator('[data-testid^="foreshadow-close-"]').click()
  await expect(page.locator('[data-testid="foreshadow-counts"]')).toContainText('未回收 2', { timeout: 15_000 })
  await expect(page.locator('[data-testid="foreshadow-counts"]')).toContainText('已回收 1')
  await expect(page.locator('[data-testid="foreshadow-panel"]')).toContainText('已在第')
})
