import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M2-ARCHIVE-01（PHASE-22 §6 / M2-7）。
 *
 * 未打包构建 + `NORYTH_MEMORY_FAKE=1`：
 *   devSeed → 抽取 14 条（其中一条是同一经历、标点宽度不同的重复）
 *   → 全部接受 → G7 应用 12 条（6 条记忆，其中 1 条低重要度重复）
 *   → 维护 → 归档候选 1 条 → 勾选 → 确认 → 已归档列表出现
 *   → 角色记忆按「仅已归档」可见、详情标「已归档」
 *   → 召回结果不含归档条目 ID（keeper 仍命中）
 *   → 恢复 → 条目重新 active、archived_at=NULL → 审计有 archive/restore
 *   → 正文 revision 与 memory_vec/memory_fts 行数不变（不物理删除）。
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
        title: '黑漆匣子 · 归档',
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

test('E2E-M2-ARCHIVE-01：候选 → 归档 → 检索不命中 → 恢复 → 可见，正文不变', async () => {
  test.setTimeout(300_000)
  const userData = makeTemp('noryth-archive-user-')
  const parent = makeTemp('noryth-archive-project-')
  const app = await launch(userData)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })

  const project = await createProject(page, parent, '归档主流程')
  const seeded = await page.evaluate(async () => window.noryth!.memory.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId!
  expect(chapterId).toBeTruthy()

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // 抽取 14 条（含 1 条标点宽度不同的重复经历）。
  await expect(page.locator('[data-testid="memory-summary-total"]')).toContainText('14 条', { timeout: 90_000 })
  await page.locator('[data-testid="memory-accept-all"]').click()
  await expect(page.locator('[data-testid="memory-g7"]')).toBeEnabled({ timeout: 30_000 })

  const dbPath = join(project.path, 'noryth.db')

  await page.locator('[data-testid="memory-g7"]').click()
  await expect(page.locator('[data-testid="memory-tab-entries"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000
  })
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('8 / 8')

  // 归档前快照：revision 行/正文 hash、向量与 FTS 行数。
  const beforeDb = new Database(dbPath, { readonly: true })
  beforeDb.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  const before = {
    revisions: (beforeDb.prepare('SELECT COUNT(*) AS count FROM revision').get() as { count: number }).count,
    hashes: (beforeDb.prepare('SELECT id, content_hash FROM revision ORDER BY id').all() as Array<{
      id: string
      content_hash: string
    }>),
    vec: (beforeDb.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }).count,
    fts: (beforeDb.prepare('SELECT COUNT(*) AS count FROM memory_fts').get() as { count: number }).count
  }
  beforeDb.close()

  // 维护 tab：1 条候选，keeper 与相似度可见。
  await page.locator('[data-testid="memory-tab-archive"]').click()
  await expect(page.locator('[data-testid="archive-candidate-0"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="archive-candidates-empty"]')).toHaveCount(0)
  const candidateId = await page.locator('[data-testid="archive-candidate-0"]').getAttribute('data-id')
  expect(candidateId).toBeTruthy()
  await expect(page.locator('[data-testid="archive-candidate-0"]')).toContainText('保留：')

  const stateBefore = await page.evaluate(async (id) => window.noryth!.memory.state(id), chapterId)
  expect(stateBefore.ok).toBe(true)
  if (!stateBefore.ok) throw new Error(stateBefore.error.code)
  const candidate = stateBefore.data.entries.find((entry) => entry.id === candidateId!)!
  expect(candidate.archivedAt).toBeNull()
  expect(stateBefore.data.counts.archived).toBe(0)

  // 归档：签发 author_confirm 后执行（点击即确认，令牌 10 分钟）。
  await page.locator('[data-testid="archive-candidate-check-0"]').check()
  await expect(page.locator('[data-testid="archive-selected-count"]')).toContainText('已选 1 条')
  await page.locator('[data-testid="archive-run"]').click()
  await expect(page.locator('[data-testid="archive-confirm"]')).toBeVisible()
  await page.locator('[data-testid="archive-apply"]').click()
  await expect(page.locator('[data-testid="archive-archived-0"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="archive-counts"]')).toContainText('已归档 1')
  await expect(page.locator('[data-testid="archive-candidates-empty"]')).toBeVisible()

  // 角色记忆：默认不含归档；切「仅已归档」可见，详情标「已归档」。
  await page.locator('[data-testid="memory-tab-entries"]').click()
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('7 / 8')
  await page.locator('[data-testid="memory-filter-archived"]').selectOption('only')
  await expect(page.locator('[data-testid="memory-entry-count"]')).toContainText('1 / 8')
  await expect(page.locator('[data-testid="memory-detail-archive"]')).toContainText('已归档', { timeout: 30_000 })

  // 召回：归档条目 ID 不再命中；同文本 keeper 仍命中（不是空结果）。
  const recallArchived = await page.evaluate(
    async ({ characterId, query }) => window.noryth!.memory.recall({ characterId, query }),
    { characterId: candidate.characterId, query: candidate.text }
  )
  expect(recallArchived.ok).toBe(true)
  if (!recallArchived.ok) throw new Error(recallArchived.error.code)
  const archivedIds = [...recallArchived.data.items, ...recallArchived.data.pinned].map((item) => item.memoryId)
  expect(archivedIds).not.toContain(candidateId!)
  expect(archivedIds.length).toBeGreaterThan(0)
  expect(recallArchived.data.empty).toBe(false)

  // 恢复：确认框 → archived_at 清空，条目重新进入可见集合。
  await page.locator('[data-testid="memory-tab-archive"]').click()
  await page.locator('[data-testid="archive-restore-0"]').click()
  await expect(page.locator('[data-testid="archive-restore-confirm-0"]')).toBeVisible()
  await page.locator('[data-testid="archive-restore-run-0"]').click()
  await expect(page.locator('[data-testid="archive-archived-empty"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="archive-counts"]')).toContainText('已归档 0')

  const stateAfter = await page.evaluate(async (id) => window.noryth!.memory.state(id), chapterId)
  expect(stateAfter.ok).toBe(true)
  if (!stateAfter.ok) throw new Error(stateAfter.error.code)
  expect(stateAfter.data.entries.find((entry) => entry.id === candidateId!)?.archivedAt).toBeNull()
  expect(stateAfter.data.counts.archived).toBe(0)

  // 正文与索引不变；审计有 archive + restore。
  const db = new Database(dbPath, { readonly: true })
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const entry = db
      .prepare('SELECT archived_at, archive_reason, status FROM memory_entry WHERE id = ?')
      .get(candidateId!) as { archived_at: string | null; archive_reason: string | null; status: string }
    expect(entry).toEqual({ archived_at: null, archive_reason: null, status: 'active' })

    const actions = db
      .prepare("SELECT action, COUNT(*) AS count FROM memory_audit WHERE action IN ('archive','restore') GROUP BY action")
      .all() as Array<{ action: string; count: number }>
    const byAction = Object.fromEntries(actions.map((row) => [row.action, row.count]))
    // 每条实体一行 + 一条批次汇总；恢复一条。
    expect(byAction['archive']).toBe(2)
    expect(byAction['restore']).toBe(1)

    const revisions = (db.prepare('SELECT COUNT(*) AS count FROM revision').get() as { count: number }).count
    expect(revisions).toBe(before.revisions)
    const hashes = db.prepare('SELECT id, content_hash FROM revision ORDER BY id').all() as Array<{
      id: string
      content_hash: string
    }>
    expect(hashes).toEqual(before.hashes)

    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }).count).toBe(before.vec)
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get() as { count: number }).count).toBe(before.fts)
  } finally {
    db.close()
  }
})
