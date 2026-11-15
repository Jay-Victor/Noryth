import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { probeCompatibleReply, startFakeLlm, type FakeLlmServer } from '../fake-llm/server'

/**
 * E2E-M0-PROVIDER（PHASE-10 §6 / PRD M0 第 4 条）。
 *
 * 「两家预设可切换，且至少一个 Agent 绑定到第二家预设仍能完成一章」：
 * - 规划用 DeepSeek（假适配器），规划 job 的绑定快照可查；
 * - 旁白先绑 DeepSeek、跑 3 拍，再绑通义、跑完剩下的拍——两次都走真实
 *   OpenAI-compatible 适配器打到本地假服务器，请求的 model 与 Authorization 不同；
 * - 审批绑通义（第二家），报告照常产出，job 绑定快照 provider=tongyi。
 *
 * 真实第二家供应商仍需作者 Key（ADR-0003）；这里证明的是「路由与 Key 解析」，
 * 协议层由 `tests/integration/presets.spec.ts` 对两家预设各跑一遍。
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

async function launch(userData: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_PLAN_FAKE = '1'
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  // 创作台故意不开假适配器：旁白走真实 HTTP 适配器
  delete env.NORYTH_WRITE_FAKE
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_REVIEW_API_KEY
  Object.assign(env, extraEnv)
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

test('E2E-M0-PROVIDER：规划 DeepSeek、旁白两段切换、审批绑通义完成一章', async () => {
  test.setTimeout(300_000)
  const server = await startFakeLlm(probeCompatibleReply)
  servers.push(server)
  const userData = makeTemp('noryth-provider-user-')
  const parent = makeTemp('noryth-provider-project-')
  const { page } = await launch(userData)

  // Key + 测试连接（两家都测，绑定才允许）
  await page.evaluate(async (baseUrl) => {
    await window.noryth!.settings.setProviderKey({ preset: 'deepseek', apiKey: 'sk-provider-a' })
    await window.noryth!.settings.setProviderKey({ preset: 'tongyi', apiKey: 'sk-provider-b' })
    await window.noryth!.settings.testProvider({ preset: 'deepseek', model: 'deepseek-flash', baseUrl })
    await window.noryth!.settings.testProvider({ preset: 'tongyi', model: 'qwen-plus', baseUrl })
  }, server.baseUrl)

  // 规划用 A（DeepSeek）
  const created = await page.evaluate(
    async ({ parentDir }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: '两家预设',
        title: '黑漆匣子 · 双供应商',
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent }
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.code)
  const projectId = created.data.projectId
  await page.evaluate(
    async (id) =>
      window.noryth!.settings.setBindings({
        projectId: id,
        changes: [{ agentKey: 'planner', provider: 'deepseek', model: 'deepseek-flash' }]
      }),
    projectId
  )
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  await page.locator('[data-nav="plan"]').click()
  await page.locator('[data-testid="plan-new-session"]').click()
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="plan-composer-input"]')
    return input !== null && !input.disabled
  })
  await page.locator('[data-testid="plan-composer-input"]').fill('写一个民国悬疑：账本与黑漆匣子')
  await page.locator('[data-testid="plan-send"]').click()
  const blueprint = page.locator('.plan-proposal[data-kind="blueprint_patch"]')
  await blueprint.waitFor({ timeout: 30_000 })
  const roster = page.locator('.plan-proposal[data-kind="roster"]')
  await roster.waitFor({ timeout: 30_000 })
  await blueprint.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid^="outline-node-"]').first().waitFor({ timeout: 15_000 })
  await roster.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid="plan-tab-blueprint"]').click()
  await page.locator('[data-testid="g1-confirm"]').click()
  await page.locator('[data-testid="g1-confirm-ok"]').click()
  await expect(page.locator('[data-testid="g1-bar"]')).toHaveAttribute('data-state', 'complete', { timeout: 30_000 })

  // 分镜 → G2
  const dbPath = join(created.data.path, 'noryth.db')
  const ids = ((): { chapterId: string; characterIds: string[] } => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return {
        chapterId: (db.prepare('SELECT id FROM chapter ORDER BY ord LIMIT 1').get() as { id: string }).id,
        characterIds: (db.prepare('SELECT id FROM character ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id)
      }
    } finally {
      db.close()
    }
  })()
  const scenes = [
    {
      location: '祠堂',
      participants: ids.characterIds,
      goal: '试探匣子',
      entry: '',
      // 留一拍不发牌：出口 beats(6) 在 6 拍确认后满足，自动模式进来只会关场景
      exit: 'beats(6)',
      max_beats: 7,
      beats: Array.from({ length: 7 }, (_, index) => ({
        speaker_type: index % 2 === 1 ? ('narrator' as const) : ('character' as const),
        speaker_id: index % 2 === 1 ? 'narrator' : ids.characterIds[0]!,
        intent: `第 ${index + 1} 拍`,
        max_words: 200
      }))
    }
  ]
  const saved = await page.evaluate(
    async ({ chapterId, scenes: payload }) => window.noryth!.write.saveStoryboard({ chapterId, scenes: payload }),
    { chapterId: ids.chapterId, scenes }
  )
  expect(saved.ok).toBe(true)
  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), ids.chapterId)
  expect(g2.ok).toBe(true)

  // 旁白：前 3 拍 DeepSeek，改绑后 3 拍通义（走创作台的真实逐拍路径）
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')
  for (let index = 0; index < 3; index += 1) {
    await page.locator('[data-testid="write-generate"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 60_000 })
    await page.locator('[data-testid="write-confirm"]').click()
  }
  expect(server.requests.some((request) => request.model === 'deepseek-flash')).toBe(true)
  expect(server.authorizations.some((value) => value === 'Bearer sk-provider-a')).toBe(true)

  await page.evaluate(
    async (id) =>
      window.noryth!.settings.setBindings({
        projectId: id,
        changes: [{ agentKey: 'narrator', provider: 'tongyi', model: 'qwen-plus' }]
      }),
    projectId
  )
  for (let index = 0; index < 3; index += 1) {
    await page.locator('[data-testid="write-generate"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 60_000 })
    await page.locator('[data-testid="write-confirm"]').click()
  }
  expect(server.requests.some((request) => request.model === 'qwen-plus')).toBe(true)
  expect(server.authorizations.some((value) => value === 'Bearer sk-provider-b')).toBe(true)

  const confirmedState = await page.evaluate(async () => window.noryth!.write.state())
  expect(confirmedState.ok && confirmedState.data.progress.confirmed).toBe(6)

  // 六拍确认后由调度器判定出口并关账（与作者点「自动」后立即收束同一条路径）
  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), ids.chapterId)
  expect(auto.ok, JSON.stringify(auto)).toBe(true)
  const state = await page.evaluate(async () => window.noryth!.write.state())
  expect(state.ok && state.data.chapterStatus).toBe('draft_complete')
  expect(state.ok && state.data.progress.confirmed).toBe(6)

  // 审批绑第二家（通义）→ 报告照常产出；job 绑定快照记录 provider=tongyi
  await page.evaluate(
    async (id) =>
      window.noryth!.settings.setBindings({
        projectId: id,
        changes: [{ agentKey: 'reviewer', provider: 'tongyi', model: 'qwen-plus' }]
      }),
    projectId
  )
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="review"]').click()
  await expect(page.locator('[data-testid="review-verdict"]')).toHaveAttribute('data-verdict', /pass|fail/, {
    timeout: 90_000
  })

  const reviewState = await page.evaluate(async () => window.noryth!.review.state())
  expect(reviewState.ok).toBe(true)
  if (reviewState.ok) {
    // 假适配器把 model 标成 review-fake；provider 来自真实绑定解析
    expect(reviewState.data.model).toMatchObject({ provider: 'tongyi', ready: true })
  }

  const db = new Database(dbPath, { readonly: true })
  try {

    // 第一拍作业（DeepSeek）与最后一拍作业（通义）的绑定快照必须不同
    const jobs = db
      .prepare("SELECT payload_json FROM job WHERE type = 'beat.generate' ORDER BY created_at")
      .all() as Array<{ payload_json: string }>
    const snapshotOf = (index: number): Record<string, { provider: string }> =>
      (JSON.parse(jobs[index]!.payload_json).bindings as { bindings: Record<string, { provider: string }> }).bindings
    const providersOf = (index: number): string[] =>
      [...new Set(Object.values(snapshotOf(index)).map((entry) => entry.provider))]
    expect(providersOf(0)).toEqual(['deepseek'])
    expect(providersOf(jobs.length - 1)).toEqual(['tongyi'])

    const metrics = db
      .prepare('SELECT provider, model, COUNT(*) AS count FROM turn_metric GROUP BY provider, model ORDER BY provider')
      .all() as Array<{ provider: string; model: string; count: number }>
    // 绑定在下一拍生效：计入哪一家取决于改绑落在哪一次作业之前，但两家都必须有真实用量
    expect(metrics.map((row) => `${row.provider}/${row.model}`)).toEqual(['deepseek/deepseek-flash', 'tongyi/qwen-plus'])
    for (const row of metrics) expect(row.count).toBeGreaterThan(0)
    expect(metrics.reduce((sum, row) => sum + row.count, 0)).toBeGreaterThanOrEqual(5)
  } finally {
    db.close()
  }
})
