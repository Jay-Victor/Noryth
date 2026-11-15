import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-REBUILD-01（PHASE-14 §6）。
 *
 * 未打包构建 + `NORYTH_MEMORY_FAKE=1`（假模型）：
 *   devSeed（第 1 章定稿 + 第 2 章已规划）→ 抽取 14 条 → 全部接受 → G7 应用
 *   → 角色记忆 8 条 active → 按章重建（author_confirm）→ 旧 8 条 inactive、新 8 条 active
 *   → 关系图 as_of 回放与来源 → 索引重建（换模型后分批重算）。
 *
 * DB 校验：memory_entry 状态分布、世界事实有效期、relationship_edge、memory_audit(rebuild)、
 * job(memory.rebuild / index.rebuild)、gate_record(author_confirm) 已消费。
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
  // E2E 固定哈希嵌入：不依赖本机是否带 bge 权重，召回结果稳定可断言。
  env.NORYTH_MEMORY_EMBED = 'hash'
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
        title: '黑漆匣子 · 重建',
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

test('E2E-M1-REBUILD-01：按章重建旧条 inactive → 关系图回放 → 索引重建', async () => {
  test.setTimeout(300_000)
  const userData = makeTemp('noryth-rebuild-user-')
  const parent = makeTemp('noryth-rebuild-project-')
  const app = await launch(userData)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })

  const project = await createProject(page, parent, '按章重建主流程')
  const seeded = await page.evaluate(async () => window.noryth!.memory.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId!

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // 抽取 14 条 → 全部接受 → G7 应用
  await expect(page.locator('[data-testid="memory-summary-total"]')).toContainText('14 条', { timeout: 90_000 })
  await page.locator('[data-testid="memory-accept-all"]').click()
  await expect(page.locator('[data-testid="memory-g7"]')).toBeEnabled()
  await page.locator('[data-testid="memory-g7"]').click()
  await expect(page.locator('[data-testid="memory-tab-entries"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000
  })
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('8 / 8')

  // 按章重建：确认后才执行（author_confirm）
  await page.locator('[data-testid="memory-entry-0"]').click()
  await expect(page.locator('[data-testid="memory-rebuild"]')).toBeEnabled()
  await page.locator('[data-testid="memory-rebuild"]').click()
  await expect(page.locator('[data-testid="memory-rebuild-confirm"]')).toBeVisible()
  await page.locator('[data-testid="memory-rebuild-run"]').click()

  // 旧 8 条 inactive + 新 8 条 active
  await expect(page.locator('[data-testid="memory-rebuild-result"]')).toContainText('旧条目 8 条失效', { timeout: 60_000 })
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('16 / 16')
  await expect(page.locator('[data-testid="memory-entries"] [data-testid^="memory-entry-"][data-status="inactive"]')).toHaveCount(8)
  await expect(page.locator('[data-testid="memory-entries"] [data-testid^="memory-entry-"][data-status="active"]')).toHaveCount(8)

  // 关系图：as_of 回放（0 时没有边，水位有 1 条边）；点边看来源
  await page.locator('[data-testid="memory-tab-relations"]').click()
  await expect(page.locator('[data-testid="relations-graph"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="relations-edge-hit-0"]')).toBeVisible()

  const seqHead = await page.evaluate(async (id) => {
    const result = await window.noryth!.world.relations({ chapterId: id })
    return result.ok ? result.data.seqHead : 0
  }, chapterId)
  expect(seqHead).toBeGreaterThan(0)

  const setRange = async (value: number): Promise<void> => {
    await page.locator('[data-testid="relations-asof"]').evaluate((element, next) => {
      const input = element as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
  }

  await setRange(0)
  await expect(page.locator('[data-testid="relations-edge-hit-0"]')).toHaveCount(0)
  await setRange(seqHead)
  await expect(page.locator('[data-testid="relations-edge-hit-0"]')).toBeVisible()
  await page.locator('[data-testid="relations-edge-hit-0"]').click()
  await expect(page.locator('[data-testid="relations-source"]')).toContainText('来源')
  await expect(page.locator('[data-testid="relations-source-label"]')).toContainText('记忆')
  await expect(page.locator('[data-testid="relations-graph"]')).not.toContainText('账本在祠堂')

  // 确定性布局：同一 as_of 两次 IPC 坐标一致
  const layoutA = await page.evaluate(async (id) => {
    const result = await window.noryth!.world.relations({ chapterId: id })
    return result.ok ? result.data.nodes : null
  }, chapterId)
  const layoutB = await page.evaluate(async (id) => {
    const result = await window.noryth!.world.relations({ chapterId: id })
    return result.ok ? result.data.nodes : null
  }, chapterId)
  expect(layoutA).not.toBeNull()
  expect(layoutB).toEqual(layoutA)

  // 索引重建：把条目改标成 bge（模拟换模型），再分批重算回当前模型
  const dbPath = join(project.path, 'noryth.db')
  const writer = new Database(dbPath)
  try {
    writer.prepare("UPDATE memory_entry SET embedding_model = 'bge-small-zh-v1.5' WHERE status = 'active'").run()
  } finally {
    writer.close()
  }
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await expect(page.locator('[data-testid="memory-index-note"]')).toContainText('索引待重建', { timeout: 60_000 })
  await page.locator('[data-testid="memory-index-rebuild"]').click()
  await expect(page.locator('[data-testid="memory-index-note"]')).toHaveCount(0, { timeout: 60_000 })

  const db = new Database(dbPath, { readonly: true })
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const entries = db
      .prepare('SELECT status, COUNT(*) AS count FROM memory_entry GROUP BY status')
      .all() as Array<{ status: string; count: number }>
    expect(entries).toEqual([{ status: 'active', count: 8 }, { status: 'inactive', count: 8 }])

    // 世界事实：作者手写优先；旧记忆事实关闭，新事实有效
    const facts = db
      .prepare("SELECT source_type, valid_to_seq IS NULL AS live, COUNT(*) AS count FROM world_fact GROUP BY source_type, live")
      .all() as Array<{ source_type: string; live: number; count: number }>
    expect(facts).toEqual(
      expect.arrayContaining([
        { source_type: 'author', live: 1, count: 1 },
        { source_type: 'memory', live: 1, count: 3 },
        { source_type: 'memory', live: 0, count: 3 }
      ])
    )

    // 关系边：旧边关闭、新边有效
    const edges = db.prepare('SELECT valid_to_seq IS NULL AS live, COUNT(*) AS count FROM relationship_edge GROUP BY live').all() as Array<{ live: number; count: number }>
    expect(edges).toEqual(
      expect.arrayContaining([
        { live: 1, count: 1 },
        { live: 0, count: 1 }
      ])
    )

    const audit = db.prepare("SELECT COUNT(*) AS count FROM memory_audit WHERE action = 'rebuild'").get() as { count: number }
    expect(audit.count).toBeGreaterThanOrEqual(2) // 按章重建 + 索引重建

    const rebuildJob = db.prepare("SELECT status, result_json FROM job WHERE type = 'memory.rebuild'").get() as {
      status: string
      result_json: string
    }
    expect(rebuildJob.status).toBe('succeeded')
    expect(JSON.parse(rebuildJob.result_json).inactive_count).toBe(8)
    expect(JSON.parse(rebuildJob.result_json).rebuilt_count).toBe(8)

    const indexJob = db.prepare("SELECT status, result_json FROM job WHERE type = 'index.rebuild'").get() as {
      status: string
      result_json: string
    }
    expect(indexJob.status).toBe('succeeded')
    expect(JSON.parse(indexJob.result_json).done).toBe(true)
    expect(JSON.parse(indexJob.result_json).rebuilt).toBe(8)

    const gates = db.prepare("SELECT COUNT(*) AS count FROM gate_record WHERE gate_id = 'author_confirm' AND consumed_at IS NOT NULL").get() as {
      count: number
    }
    expect(gates.count).toBeGreaterThanOrEqual(2)

    const vec = db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
    expect(vec.count).toBe(16) // 旧条目的向量仍在（不删除），新条目各一条
  } finally {
    db.close()
  }
})
