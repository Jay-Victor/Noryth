import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { probeCompatibleReply, startFakeLlm, type ChatRequestBody, type FakeLlmServer } from '../fake-llm/server'

/**
 * E2E-M2-ROUTING-01 / E2E-M2-CALIBRATION-01（PHASE-21 §5.5 / §6）。
 *
 * 路由：主家真 HTTP 适配器（本地假服务器）返回 429 → 当前拍失败暂停
 * → 下一拍按健康状态用备用家 → 状态栏徽标 → turn_metric 记录实际 provider
 * → job 快照仍是主家 → 已确认拍逐字不变。
 *
 * 校准：真实审批假适配器产出报告与 patch 决策 → `review.calibration` 与
 * `scripts/m2-calibration.mjs` 输出同口径 JSON；第二家未定价时 D4 保持 off。
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

async function launch(userData: string, extraEnv: Record<string, string> = {}): Promise<Page> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  delete env.NORYTH_WRITE_FAKE
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_REVIEW_API_KEY
  Object.assign(env, extraEnv)
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return page
}

async function createProject(page: Page, parent: string, folder: string, title: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name, projectTitle }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: projectTitle,
        genre: '悬疑',
        targetWords: 100_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent, name: folder, projectTitle: title }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  return { projectId: result.data.projectId, path: result.data.path }
}

function readDb<T>(path: string, run: (db: Database.Database) => T): T {
  const handle = new Database(join(path, 'noryth.db'), { timeout: 5_000 })
  try {
    return run(handle)
  } finally {
    handle.close()
  }
}

function isProbe(request: ChatRequestBody): boolean {
  return (
    (request.tools ?? []).some((tool) => tool.function.name === 'probe_echo') ||
    request.response_format !== undefined
  )
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
      // Windows 偶发占用
    }
  }
})

test('E2E-M2-ROUTING-01：主家 429 → 下一拍备用 → 徽标与逐拍留痕', async () => {
  test.setTimeout(300_000)
  let primaryFailing = false
  const primary = await startFakeLlm((request) => {
    if (primaryFailing && !isProbe(request)) {
      return { httpStatus: 429, httpBody: JSON.stringify({ error: { message: 'rate limited' } }) }
    }
    return probeCompatibleReply(request)
  }, 'deepseek-flash')
  const secondary = await startFakeLlm(probeCompatibleReply, 'gpt-4.1-mini')
  servers.push(primary, secondary)

  const userData = makeTemp('noryth-routing-user-')
  const parent = makeTemp('noryth-routing-project-')
  const page = await launch(userData)

  // 两家都填 Key + 测试连接（备用家必须已测试才可用）。
  const tested = await page.evaluate(
    async ({ primaryUrl, secondaryUrl }) => {
      const results = []
      await window.noryth!.settings.setProviderKey({ preset: 'deepseek', apiKey: 'test-key-primary-0001' })
      await window.noryth!.settings.setProviderKey({ preset: 'openai', apiKey: 'test-key-secondary-0001' })
      results.push(
        await window.noryth!.settings.testProvider({
          preset: 'deepseek',
          model: 'deepseek-flash',
          baseUrl: primaryUrl
        })
      )
      results.push(
        await window.noryth!.settings.testProvider({
          preset: 'openai',
          model: 'gpt-4.1-mini',
          baseUrl: secondaryUrl
        })
      )
      return results
    },
    { primaryUrl: primary.baseUrl, secondaryUrl: secondary.baseUrl }
  )
  expect(tested.every((result) => result.ok && result.data.ok)).toBe(true)

  const project = await createProject(page, parent, '路由主流程', '黑漆匣子 · 路由')
  await page.evaluate(
    async ({ projectId }) => {
      await window.noryth!.settings.setBindings({
        projectId,
        changes: [{ agentKey: 'narrator', provider: 'deepseek', model: 'deepseek-flash' }]
      })
      await window.noryth!.settings.set({
        routing: {
          enabled: true,
          fallbackOn: ['rate_limit', 'server'],
          cooldownMs: 60_000,
          agents: {
            character: { preset: 'openai', model: 'gpt-4.1-mini' },
            narrator: { preset: 'openai', model: 'gpt-4.1-mini' }
          }
        }
      })
    },
    { projectId: project.projectId }
  )
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 4, exit: 'beats(4)' })
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-g2"]').click()
  await page.locator('[data-testid="write-g2-confirm"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')

  const before = await page.evaluate(async () => window.noryth!.write.state())
  expect(before.ok).toBe(true)
  if (!before.ok) throw new Error(before.error.code)
  const target = before.data.scenes.flatMap((scene) => scene.beats).find((beat) => beat.body.length === 0)!
  expect(target).toBeDefined()

  primaryFailing = true
  const failed = await page.evaluate(async (beatId) => window.noryth!.write.generate(beatId), target.id)
  expect(failed.ok).toBe(false)
  if (!failed.ok) expect(failed.error.code).toBe('rate_limit')

  const generated = await page.evaluate(async (beatId) => window.noryth!.write.generate(beatId), target.id)
  expect(generated.ok, JSON.stringify(generated)).toBe(true)

  // 状态栏徽标：常驻、不弹模态。
  const badge = page.locator('[data-testid="status-routing"]')
  await expect(badge).toBeVisible({ timeout: 15_000 })
  await expect(badge).toContainText('OpenAI')
  await expect(badge).toHaveAttribute('data-reason', 'primary_unhealthy')

  const afterGenerate = await page.evaluate(async () => window.noryth!.write.state())
  expect(afterGenerate.ok).toBe(true)
  if (!afterGenerate.ok) throw new Error(afterGenerate.error.code)
  const produced = afterGenerate.data.scenes.flatMap((scene) => scene.beats).find((beat) => beat.body.length > 0)!
  const confirmed = await page.evaluate(async (beatId) => window.noryth!.write.confirm(beatId), produced.id)
  expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true)

  const confirmedBody = readDb(project.path, (db) => {
    const row = db.prepare('SELECT body FROM beat WHERE id = ?').get(produced.id) as { body: string } | undefined
    return row?.body ?? ''
  })
  expect(confirmedBody.length).toBeGreaterThan(0)

  // 剩余拍用自动模式收束（主家仍在冷却，继续用备用）。
  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), chapterId)
  expect(auto.ok, JSON.stringify(auto)).toBe(true)
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(async () => window.noryth!.write.state())
        return state.ok ? state.data.chapterStatus : 'error'
      },
      { timeout: 120_000 }
    )
    .toBe('draft_complete')

  // 已确认拍逐字不变。
  const confirmedAfter = readDb(project.path, (db) => {
    const row = db.prepare('SELECT body FROM beat WHERE id = ?').get(produced.id) as { body: string } | undefined
    return row?.body ?? ''
  })
  expect(confirmedAfter).toBe(confirmedBody)

  // 实际调用记在备用家；job 快照仍是主家。
  readDb(project.path, (db) => {
    const metric = db
      .prepare(
        `SELECT provider, model, context_json FROM turn_metric
          WHERE beat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(target.id) as { provider: string; model: string; context_json: string } | undefined
    expect(metric?.provider).toBe('openai')
    expect(metric?.model).toBe('gpt-4.1-mini')
    const context = JSON.parse(metric?.context_json ?? '{}') as {
      routing?: { from: string; to: string; reason: string; error: string | null }
    }
    expect(context.routing).toMatchObject({
      from: 'deepseek',
      to: 'openai',
      reason: 'primary_unhealthy',
      error: 'rate_limit'
    })

    const jobs = db
      .prepare("SELECT payload_json FROM job WHERE type = 'beat.generate' ORDER BY created_at")
      .all() as Array<{ payload_json: string }>
    const snapshot = JSON.parse(jobs[jobs.length - 1]!.payload_json) as {
      bindings: { bindings: Record<string, { provider: string }> }
    }
    const actor = Object.values(snapshot.bindings.bindings)[0]!
    expect(actor.provider).toBe('deepseek')
  })

  // 审批报告记录实际审批家（异构/路由归因）。
  const review = await page.evaluate(async (id) => window.noryth!.review.run(id), chapterId)
  expect(review.ok, JSON.stringify(review)).toBe(true)
  const reportProvider = readDb(project.path, (db) => {
    const row = db
      .prepare('SELECT provider FROM approval_report WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(chapterId) as { provider: string | null } | undefined
    return row?.provider ?? null
  })
  expect(reportProvider).toBe('deepseek')
})

test('E2E-M2-CALIBRATION-01：校准 IPC 与脚本输出 reports/blocking/suggestions/byDimension/cost', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-calibration-user-')
  const parent = makeTemp('noryth-calibration-project-')
  const page = await launch(userData)
  const project = await createProject(page, parent, '校准夹具', '黑漆匣子 · 校准')

  const seeded = await page.evaluate(async () => window.noryth!.review.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId

  const report = await page.evaluate(async (id) => window.noryth!.review.run(id), chapterId)
  expect(report.ok, JSON.stringify(report)).toBe(true)
  const g5 = await page.evaluate(async (id) => window.noryth!.review.authorizeRevision(id), chapterId)
  expect(g5.ok, JSON.stringify(g5)).toBe(true)

  const state = await page.evaluate(async (id) => window.noryth!.review.state(id), chapterId)
  expect(state.ok).toBe(true)
  if (!state.ok) throw new Error(state.error.code)
  const patches = state.data.patches.filter((patch) => patch.status === 'proposed')
  expect(patches.length).toBeGreaterThanOrEqual(2)
  const decisions = patches.map((patch, index) => ({ patchId: patch.id, accept: index < patches.length - 1 }))
  const decided = await page.evaluate(
    async ({ chapterId: id, expectedRevision, decisions: list }) =>
      window.noryth!.review.decide({ chapterId: id, expectedRevision, decisions: list }),
    { chapterId, expectedRevision: state.data.revisionId, decisions }
  )
  expect(decided.ok, JSON.stringify(decided)).toBe(true)

  const calibration = await page.evaluate(async () => window.noryth!.review.calibration())
  expect(calibration.ok).toBe(true)
  if (!calibration.ok) throw new Error(calibration.error.code)
  const data = calibration.data
  expect(data.reports).toBeGreaterThanOrEqual(1)
  expect(data.blocking.total).toBeGreaterThan(0)
  expect(data.suggestions.total).toBeGreaterThan(0)
  expect(data.byDimension).toHaveLength(4)
  expect(data.cost.reviewCny).toBeGreaterThan(0)
  expect(data.cost.heteroDeltaPct).toBeNull()
  expect(data.decision.recommended).toBe('off')
  expect(data.limitations.join('｜')).toContain('代理指标')

  const script = execFileSync(process.execPath, ['scripts/m2-calibration.mjs', project.path], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  const fromScript = JSON.parse(script) as {
    reports: number
    blocking: { total: number }
    suggestions: { total: number }
    byDimension: unknown[]
    cost: { reviewCny: number; heteroDeltaPct: number | null }
    decision: { recommended: string }
  }
  expect(fromScript.reports).toBe(data.reports)
  expect(fromScript.blocking.total).toBe(data.blocking.total)
  expect(fromScript.suggestions.total).toBe(data.suggestions.total)
  expect(fromScript.byDimension).toHaveLength(4)
  expect(fromScript.cost.reviewCny).toBeCloseTo(data.cost.reviewCny)
  expect(fromScript.cost.heteroDeltaPct).toBeNull()
  expect(fromScript.decision.recommended).toBe('off')
})
