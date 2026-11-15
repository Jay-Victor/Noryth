import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-MEMORY-01（PHASE-09 §6）。
 *
 * 未打包构建 + `NORYTH_MEMORY_FAKE=1`：
 *   devSeed（第 1 章定稿 + 第 2 章已规划 + memory.extract 入队）→ 自动抽取 14 条提案
 *   → 删 2 改 1 → 全部接受 → G7 应用 12 条 → 角色记忆 6 条 / 世界事实 4 条
 *   → 第 2 章召回 ≥1 条 → 隔离回归 0 跨角色命中。
 *
 * DB 校验：memory_entry / memory_vec / memory_fts / character_belief /
 * relationship_edge / memory_audit / gate_record(G7) / job(memory.apply)。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_MEMORY_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_REVIEW_API_KEY
  delete env.NORYTH_MEMORY_API_KEY

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  return app
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 记忆台',
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

test('E2E-MEMORY-01：定稿 → 14 提案 → 删2改1 → G7 应用 12 条 → 第 2 章召回', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-memory-user-')
  const parent = makeTemp('noryth-memory-project-')
  const app = await launch(userData)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })

  const project = await createProject(page, parent, '记忆台主流程')
  const seeded = await page.evaluate(async () => window.noryth!.memory.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  expect(seeded.data.chapterId).toBeTruthy()
  expect(seeded.data.jobStatus).toBe('queued')
  expect(seeded.data.chapters).toHaveLength(2)
  const chapterId = seeded.data.chapterId!

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // 进入记忆台自动抽取：14 条提案
  await expect(page.locator('[data-testid="memory-summary-total"]')).toContainText('14 条', { timeout: 90_000 })
  await expect(page.locator('[data-testid="memory-proposal-0"]')).toBeVisible()
  await expect(page.locator('[data-testid="memory-proposal-13"]')).toBeVisible()

  // 台词证据的 world_fact 被降级为「声称」
  const claim = page.locator('[data-testid="memory-proposal-2"]')
  await expect(claim).toHaveAttribute('data-kind', 'world_fact')
  await expect(claim.locator('[data-testid="memory-truth-2"]')).toHaveText('声称')
  await expect(claim.locator('[data-testid="memory-downgraded-2"]')).toContainText('降级为「声称」')

  // 删 2：第 6 条（cognition）与第 11 条（experience）
  await page.locator('[data-testid="memory-reject-6"]').click()
  await expect(page.locator('[data-testid="memory-proposal-6"]')).toHaveAttribute('data-decision', 'reject')
  await page.locator('[data-testid="memory-reject-11"]').click()
  await expect(page.locator('[data-testid="memory-proposal-11"]')).toHaveAttribute('data-decision', 'reject')

  // 改 1：第 1 条
  await page.locator('[data-testid="memory-edit-0"]').click()
  await page.locator('[data-testid="memory-edit-input"]').fill('她试探黑漆匣子，但没有点破账本')
  await page.locator('[data-testid="memory-edit-save"]').click()
  await expect(page.locator('[data-testid="memory-proposal-0"]')).toHaveAttribute('data-decision', 'edit')

  // 其余全部接受 → G7 可应用
  await page.locator('[data-testid="memory-accept-all"]').click()
  await expect(page.locator('[data-testid="memory-gate-counts"]')).toContainText('未决 0')
  await expect(page.locator('[data-testid="memory-g7"]')).toBeEnabled()
  await page.locator('[data-testid="memory-g7"]').click()

  // 应用后自动切到角色记忆
  await expect(page.locator('[data-testid="memory-tab-entries"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000
  })
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('6 / 6')

  // 角色记忆：来源可追溯；被编辑的那条文本生效
  await expect(page.locator('[data-testid="memory-detail-source"]')).toContainText('祠堂夜谈')
  await expect(page.locator('[data-testid="memory-entries"]')).toContainText('她试探黑漆匣子')

  // 世界状态：事实 4 条（含一条 claim），信念 3 条，关系 1 条
  await page.locator('[data-testid="memory-tab-world"]').click()
  await expect(page.locator('[data-testid="memory-world-fact-3"]')).toBeVisible()
  await expect(page.locator('[data-testid="memory-belief-2"]')).toBeVisible()
  await expect(page.locator('[data-testid="memory-relation-0"]')).toBeVisible()

  // 隔离回归：写向量后 0 跨角色命中
  await page.locator('[data-testid="memory-isolation-run"]').click()
  await expect(page.locator('[data-testid="memory-isolation-report"]')).toContainText('通过', { timeout: 30_000 })

  // 第 2 章召回：真实检索管线（向量 + 关键词 + pinned）
  await page.locator('[data-testid="memory-tab-entries"]').click()
  const characterId = await page.evaluate(async (id) => {
    const result = await window.noryth!.memory.state(id)
    return result.ok ? (result.data.entries[0]?.characterId ?? null) : null
  }, chapterId)
  expect(characterId).toBeTruthy()
  await page.locator('[data-testid="memory-recall-character"]').selectOption(characterId!)
  await page.locator('[data-testid="memory-recall-query"]').fill('账本 祠堂 匣子')
  await page.locator('[data-testid="memory-recall-run"]').click()
  await expect(page.locator('[data-testid="memory-recall-result"]')).toContainText('条', { timeout: 30_000 })
  await expect(page.locator('[data-testid="memory-recall-item-0"]')).toBeVisible()

  // 审计：应用与抽取都有记录
  await page.locator('[data-testid="memory-tab-audit"]').click()
  await expect(page.locator('[data-testid="memory-audit"]')).toContainText('应用')

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  // memory_vec 是 vec0 虚拟表：只读连接也要先加载扩展才能 COUNT
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const entries = db
      .prepare('SELECT status, COUNT(*) AS count FROM memory_entry GROUP BY status')
      .all() as Array<{ status: string; count: number }>
    expect(entries).toEqual([{ status: 'active', count: 6 }])

    const vec = db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
    expect(vec.count).toBe(6)
    const fts = db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get() as { count: number }
    expect(fts.count).toBe(6)

    const facts = db
      .prepare('SELECT truth, COUNT(*) AS count FROM world_fact GROUP BY truth')
      .all() as Array<{ truth: string; count: number }>
    const factByTruth = Object.fromEntries(facts.map((row) => [row.truth, row.count]))
    expect(factByTruth['objective']).toBe(3)
    expect(factByTruth['claim']).toBe(1)

    const beliefs = db.prepare('SELECT COUNT(*) AS count FROM character_belief').get() as { count: number }
    expect(beliefs.count).toBe(3)
    const edges = db.prepare('SELECT COUNT(*) AS count FROM relationship_edge').get() as { count: number }
    expect(edges.count).toBe(1)

    const proposals = db
      .prepare('SELECT decision, COUNT(*) AS count FROM memory_proposal_item GROUP BY decision')
      .all() as Array<{ decision: string; count: number }>
    const byDecision = Object.fromEntries(proposals.map((row) => [row.decision, row.count]))
    expect(byDecision['accept']).toBe(11)
    expect(byDecision['edit']).toBe(1)
    expect(byDecision['reject']).toBe(2)

    const audit = db
      .prepare("SELECT COUNT(*) AS count FROM memory_audit WHERE action = 'apply'")
      .get() as { count: number }
    expect(audit.count).toBeGreaterThanOrEqual(11)

    const gate = db
      .prepare("SELECT consumed_at FROM gate_record WHERE gate_id = 'G7'")
      .get() as { consumed_at: string | null }
    expect(gate.consumed_at).not.toBeNull()

    const applyJob = db
      .prepare("SELECT status FROM job WHERE type = 'memory.apply'")
      .get() as { status: string }
    expect(applyJob.status).toBe('succeeded')

    const extractJob = db
      .prepare("SELECT status, result_json FROM job WHERE type = 'memory.extract'")
      .get() as { status: string; result_json: string }
    expect(extractJob.status).toBe('succeeded')
    expect(JSON.parse(extractJob.result_json).applied).toBe(true)
  } finally {
    db.close()
  }
})
