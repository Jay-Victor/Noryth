import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { listChapters, memoryMb, runChapter, verifyProject } from './m1-flow'

/**
 * E2E-M1-SMOKE（PHASE-18 §5.2）：3 章连续闭环，进提交门。
 *
 * 每章：G2 → 逐拍 2 拍 → 自动跑完 → G4 → G5（2 接受 1 拒绝）→ 复检
 *   → G6 定稿 → G7 抽取 + 全部接受 + 应用。
 * 断言：3 个 final、`db.verify()` 绿、记忆 active > 0、无孤儿拍、
 *   无 context_overflow、RSS < 600MB、tool_call 按章落库（M1-23）。
 *
 * 30 章版本是 `tests/e2e-long/m1-a.spec.ts`（nightly），两者共用 `m1-flow.ts`。
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
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '0'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '0'
  env.NORYTH_MEMORY_STREAM_DELAY_MS = '0'
  env.NORYTH_MEMORY_EMBED = 'hash'
  for (const name of ['NORYTH_DEEPSEEK_API_KEY', 'NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY', 'NORYTH_REVIEW_API_KEY', 'NORYTH_MEMORY_API_KEY']) {
    delete env[name]
  }
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
  if (process.env.NORYTH_E2E_KEEP === '1') {
    // 排障用：保留临时目录并打印路径（日志/DB 都在里面）。
    console.warn(`E2E-M1-SMOKE kept temp dirs: ${tempDirs.join(' ; ')}`)
    return
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用
    }
  }
})

test('E2E-M1-SMOKE：3 章连续闭环 + 定稿 + 记忆固化 + DB 校验', async () => {
  test.setTimeout(900_000)
  const userData = makeTemp('noryth-m1smoke-user-')
  const parent = makeTemp('noryth-m1smoke-project-')
  const { app, page } = await launch(userData)

  const created = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · M1 冒烟',
        genre: '悬疑',
        targetWords: 120_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parentDir: parent, name: 'M1 冒烟' }
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.code)
  const dbPath = join(created.data.path, 'noryth.db')
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  // 3 章 × 3 场 × 6 拍 = 54 拍；每章同一套分镜草案（18 拍）。
  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({
      chapters: 3,
      scenes: 3,
      beatsPerScene: 6,
      seedEveryChapter: true,
      characters: 2
    })
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)

  const chapters = await listChapters(page)
  expect(chapters.map((chapter) => chapter.ord)).toEqual([1, 2, 3])

  const results = []
  for (const chapter of chapters) {
    const result = await runChapter(page, chapter)
    // 每章都当章校验：3 章 smoke 用「逐章」，30 章长跑用「每 5 章」。
    const verified = await verifyProject(page)
    expect(verified.ok, `ch${chapter.ord} verify: ${verified.errors.join('; ')}`).toBe(true)
    results.push(result)
  }

  expect(results.map((result) => result.reportVerdict)).toEqual(['fail', 'fail', 'fail'])
  expect(results.every((result) => result.patches === 3)).toBe(true)
  expect(results.every((result) => result.accepted === 2)).toBe(true)
  expect(results.every((result) => result.memoryApplied > 0)).toBe(true)

  // ── DB 断言：3 final、无孤儿、无 context_overflow、记忆 active ────────────
  const db = new Database(dbPath, { readonly: true })
  // memory_vec 是 vec0 虚表：只读连接也要显式加载扩展才能 COUNT。
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const finals = db
      .prepare("SELECT COUNT(*) AS count FROM chapter WHERE status = 'finalized' AND final_revision_id IS NOT NULL")
      .get() as { count: number }
    expect(finals.count).toBe(3)

    const finalRevisions = db
      .prepare("SELECT COUNT(*) AS count FROM revision WHERE kind = 'final'")
      .get() as { count: number }
    expect(finalRevisions.count).toBe(3)

    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS count FROM beat
         WHERE status IN ('generating','regenerating')
            OR (status <> 'superseded' AND chapter_id NOT IN (SELECT id FROM chapter))`
      )
      .get() as { count: number }
    expect(orphans.count).toBe(0)

    const overflow = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE error_code = 'context_overflow'")
      .get() as { count: number }
    expect(overflow.count).toBe(0)

    const memory = db
      .prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE status = 'active'")
      .get() as { count: number }
    expect(memory.count).toBeGreaterThan(0)

    const vectors = db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
    expect(vectors.count).toBeGreaterThan(0)

    // M1-23：工具调用按章落库（审批回合调 consistency.check 等）。
    const toolCalls = db
      .prepare('SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NOT NULL')
      .get() as { count: number }
    expect(toolCalls.count).toBeGreaterThan(0)
    const unmapped = db
      .prepare('SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NULL')
      .get() as { count: number }
    expect(unmapped.count).toBe(0)

    // 三章各有定稿清单与章末摘要（M1-13）。
    const summaries = db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }
    expect(summaries.count).toBeGreaterThanOrEqual(3)
  } finally {
    db.close()
  }

  // ── UI 断言：审批台章列表 3 章都已定稿 ────────────────────────────────────
  await page.locator('[data-nav="review"]').click()
  await page.waitForSelector('[data-testid^="review-chapter-"]', { timeout: 30_000 })
  const finalizedRows = page.locator(
    '[data-testid^="review-chapter-"] .write-chapter-status[data-status="finalized"]'
  )
  await expect(finalizedRows).toHaveCount(3, { timeout: 30_000 })

  // ── 内存：三章长跑后主进程 + 渲染进程 working set < 600MB ────────────────
  const usage = await memoryMb(page, app)
  expect(usage.privateBytes).toBeLessThan(600)
  // eslint-disable-next-line no-console
  console.log(`E2E-M1-SMOKE ws=${usage.workingSet}MB priv=${usage.privateBytes}MB`)

  // 项目仍可重新打开（会话收尾不残留锁/半条正文）。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  const reopened = await verifyProject(page)
  expect(reopened.ok).toBe(true)
})
