import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-PLAN-01（PHASE-06 §6）：
 * 新建项目 → 规划对话 → 应用蓝图/角色清单 → 改 2 个角色动机 → G1 → 建库 → 创作台解锁。
 *
 * 模型用未打包构建的假适配器（NORYTH_PLAN_FAKE=1）；工具管道、提案表、G1 与建库
 * 都走真实代码，不手改数据库。第二例验证 setup_incomplete 与重试。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = makeTemp('noryth-e2e-plan-user-')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_PLAN_FAKE = '1'
  Object.assign(env, extraEnv)

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
        title: '黑漆匣子',
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

async function openPlan(page: Page): Promise<void> {
  await page.locator('[data-nav="plan"]').click()
  await page.waitForSelector('[data-testid="pane-chat"]')
  await page.locator('[data-testid="plan-new-session"]').click()
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="plan-composer-input"]')
    return input !== null && !input.disabled
  })
}

async function runChatAndApply(page: Page): Promise<void> {
  await page.locator('[data-testid="plan-composer-input"]').fill('写一个民国悬疑：替人写遗书的女子发现父亲留下的账本')
  await page.locator('[data-testid="plan-send"]').click()

  const blueprint = page.locator('.plan-proposal[data-kind="blueprint_patch"]')
  await blueprint.waitFor({ timeout: 30_000 })
  const roster = page.locator('.plan-proposal[data-kind="roster"]')
  await roster.waitFor({ timeout: 30_000 })

  await blueprint.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid^="outline-node-"]').first().waitFor({ timeout: 15_000 })
  await roster.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid="plan-tab-characters"]').click()
  await page.locator('[data-testid^="character-row-"]').first().waitFor({ timeout: 15_000 })
}

async function editTwoMotivations(page: Page, dbPath: string): Promise<void> {
  await page.locator('[data-testid="plan-tab-characters"]').click()
  const rows = page.locator('[data-testid^="character-row-"]')
  await expect(rows).toHaveCount(5)

  // voice 缺一项：G1 禁用并显示第一条原因；补齐后恢复。
  await rows.first().click()
  const voice = page.locator('[data-testid="card-voice-sentence_length"]')
  const originalVoice = await voice.inputValue()
  await voice.fill('')
  await voice.press('Tab')
  await expect(page.locator('[data-testid="g1-confirm"]')).toBeDisabled({ timeout: 10_000 })
  await expect(page.locator('[data-testid="g1-blocker"]')).toContainText('句长倾向')
  await voice.fill(originalVoice)
  await voice.press('Tab')
  await expect(page.locator('[data-testid="g1-confirm"]')).toBeEnabled({ timeout: 10_000 })

  for (let index = 0; index < 2; index += 1) {
    await rows.nth(index).click()
    const want = page.locator('[data-testid="card-want"]')
    await want.fill(`改过的动机 ${index + 1}`)
    await want.press('Tab')
    await expect
      .poll(
        () => {
          const db = new Database(dbPath, { readonly: true })
          try {
            const rowsInDb = db.prepare('SELECT card_json FROM plan_character ORDER BY ord').all() as Array<{
              card_json: string
            }>
            return JSON.parse(rowsInDb[index]!.card_json).want as string
          } finally {
            db.close()
          }
        },
        { timeout: 10_000 }
      )
      .toBe(`改过的动机 ${index + 1}`)
  }
  await page.locator('[data-testid="plan-tab-blueprint"]').click()
}

async function confirmG1(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="g1-confirm"]')).toBeEnabled()
  await page.locator('[data-testid="g1-confirm"]').click()
  await expect(page.locator('[data-testid="g1-confirm-dialog"]')).toBeVisible()
  await page.locator('[data-testid="g1-confirm-ok"]').click()
  await expect(page.locator('[data-testid="g1-bar"]')).toHaveAttribute('data-state', 'complete', { timeout: 30_000 })
}

function readG1State(dbPath: string): {
  setupState: string
  g1Gates: number
  characters: number
  chapters: number
  privateNamespaces: number
  publicNamespaces: number
  locked: number
  isolation: unknown
  lockedNodes: number
} {
  const db = new Database(dbPath, { readonly: true })
  try {
    const project = db.prepare('SELECT setup_state, blueprint_locked_at, metadata_json FROM project LIMIT 1').get() as {
      setup_state: string
      blueprint_locked_at: string | null
      metadata_json: string
    }
    return {
      setupState: project.setup_state,
      g1Gates: (db.prepare("SELECT COUNT(*) AS c FROM gate_record WHERE gate_id = 'G1'").get() as { c: number }).c,
      characters: (db.prepare('SELECT COUNT(*) AS c FROM character').get() as { c: number }).c,
      chapters: (db.prepare('SELECT COUNT(*) AS c FROM chapter').get() as { c: number }).c,
      privateNamespaces: (
        db.prepare("SELECT COUNT(*) AS c FROM memory_namespace WHERE kind = 'private'").get() as { c: number }
      ).c,
      publicNamespaces: (
        db.prepare("SELECT COUNT(*) AS c FROM memory_namespace WHERE kind = 'public'").get() as { c: number }
      ).c,
      locked: project.blueprint_locked_at === null ? 0 : 1,
      isolation: JSON.parse(project.metadata_json).isolation_verified,
      lockedNodes: (
        db.prepare("SELECT COUNT(*) AS c FROM outline_node WHERE status = 'locked'").get() as { c: number }
      ).c
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
      // Windows 偶发占用，留给系统清理
    }
  }
})

test('E2E-PLAN-01：对话 → 提案 → 改动机 → G1 → 创作台解锁', async () => {
  test.setTimeout(120_000)
  const parent = makeTemp('noryth-e2e-plan-')
  const { page } = await launch()
  const created = await createProject(page, parent, '规划项目')

  await openPlan(page)
  await runChatAndApply(page)
  await editTwoMotivations(page, join(created.path, 'noryth.db'))

  // G1 前：创作台仍禁用
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'true')

  await confirmG1(page)
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'false')

  const dbState = readG1State(join(created.path, 'noryth.db'))
  expect(dbState.setupState).toBe('complete')
  expect(dbState.locked).toBe(1)
  expect(dbState.g1Gates).toBe(1)
  expect(dbState.characters).toBe(5)
  expect(dbState.chapters).toBe(2)
  expect(dbState.privateNamespaces).toBe(5)
  expect(dbState.publicNamespaces).toBe(1)
  expect(dbState.isolation).toBe(true)
  expect(dbState.lockedNodes).toBeGreaterThanOrEqual(4)

  // 蓝图 G1 后只读：标题输入框禁用
  await page.locator('[data-testid="plan-tab-blueprint"]').click()
  await expect(page.locator('[data-testid="outline-title"]')).toBeDisabled()

  // 创作台解锁
  await page.locator('[data-nav="write"]').click()
  await expect(page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'write')
  await expect(page.locator('[data-testid="pane-chat"]')).toBeVisible()
})

test('E2E-PLAN-02：建库失败 → setup_incomplete → 重试成功', async () => {
  test.setTimeout(120_000)
  const parent = makeTemp('noryth-e2e-plan-fail-')
  const marker = join(makeTemp('noryth-e2e-plan-marker-'), 'fail-once')
  writeFileSync(marker, 'fail', 'utf8')

  const { page } = await launch({ NORYTH_SETUP_FAIL_ONCE: marker })
  const created = await createProject(page, parent, '建库失败项目')

  await openPlan(page)
  await runChatAndApply(page)

  await page.locator('[data-testid="g1-confirm"]').click()
  await page.locator('[data-testid="g1-confirm-ok"]').click()

  await expect(page.locator('[data-testid="g1-bar"]')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(page.locator('[data-testid="setup-incomplete"]')).toBeVisible()
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'true')

  let dbState = readG1State(join(created.path, 'noryth.db'))
  expect(dbState.setupState).toBe('failed')
  expect(dbState.locked).toBe(1)
  expect(dbState.characters).toBe(5)
  expect(dbState.g1Gates).toBe(1)
  expect(dbState.privateNamespaces).toBeLessThan(5)

  await page.locator('[data-testid="g1-retry"]').click()
  await expect(page.locator('[data-testid="g1-bar"]')).toHaveAttribute('data-state', 'complete', { timeout: 30_000 })
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'false')

  dbState = readG1State(join(created.path, 'noryth.db'))
  expect(dbState.setupState).toBe('complete')
  expect(dbState.privateNamespaces).toBe(5)
  expect(dbState.publicNamespaces).toBe(1)
  expect(dbState.isolation).toBe(true)
})
