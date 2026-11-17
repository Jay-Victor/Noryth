import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { listChapters, memoryMb, runChapter, verifyProject } from '../e2e/m1-flow'

/**
 * E2E-M1-A（PHASE-18 §5.2）：3 卷 × 10 章 × 3 场 × 6 拍 = 30 章 / 540 拍连续创作。
 *
 * 运行时机：nightly / 发布前（`pnpm test:e2e:m1a`）；提交门只跑 3 章
 * `E2E-M1-SMOKE`。两者共用 `tests/e2e/m1-flow.ts` 的一章闭环。
 *
 * 每章：G2 → 逐拍 2 拍 → 自动跑完 → G4 → G5（2 接受 1 拒绝）→ 复检
 *   → G6 定稿 → G7 抽取 + 全部接受 + 应用。
 * 断言：每 5 章 `db.verify()`；30 个 final；`memory_entry > 0`；无孤儿；
 *   无 `context_overflow`；working set < 600MB。
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
    console.warn(`E2E-M1-A kept temp dirs: ${tempDirs.join(' ; ')}`)
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

test('E2E-M1-A：30 章连续创作（3 卷 × 10 章）', async () => {
  test.setTimeout(3_600_000)
  const userData = makeTemp('noryth-m1a-user-')
  const parent = makeTemp('noryth-m1a-project-')
  const { app, page } = await launch(userData)

  const created = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 三十章',
        genre: '悬疑',
        targetWords: 600_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parentDir: parent, name: '三十章长跑' }
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.code)
  const dbPath = join(created.data.path, 'noryth.db')
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({
      volumes: 3,
      chaptersPerVolume: 10,
      scenes: 3,
      beatsPerScene: 6,
      seedEveryChapter: true,
      characters: 2
    })
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(`devSeed: ${seeded.error.code} ${seeded.error.message}`)

  const chapters = await listChapters(page)
  expect(chapters).toHaveLength(30)
  expect(chapters.map((chapter) => chapter.ord)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))

  // 卷层：3 个 volume 节点（大纲树），章挂在卷下。
  const volumes = await page.evaluate(async () => {
    const tree = await window.noryth!.project.tree()
    return tree.ok ? tree.data : null
  })
  expect(volumes).not.toBeNull()

  let baselinePrivate = 0
  for (const chapter of chapters) {
    const started = Date.now()
    const result = await runChapter(page, chapter)
    expect(result.reportVerdict).toBe('fail')
    expect(result.patches).toBe(3)
    expect(result.accepted).toBe(2)
    expect(result.memoryApplied).toBeGreaterThan(0)
    if (chapter.ord % 5 === 0) {
      const verified = await verifyProject(page)
      expect(verified.ok, `ch${chapter.ord} verify: ${verified.errors.join('; ')}`).toBe(true)
      const usage = await memoryMb(page, app)
      // eslint-disable-next-line no-console
      console.log(
        `E2E-M1-A ch${chapter.ord}/30 ok in ${Date.now() - started}ms; ws=${usage.workingSet}MB priv=${usage.privateBytes}MB ${JSON.stringify(usage.processes)}`
      )
      // PHASE-18 §5.2：内存门槛按「全部进程私有工作集」计（共享 DLL 页不重复计入）。
      expect(usage.privateBytes).toBeLessThan(600)
      if (chapter.ord === 5) baselinePrivate = usage.privateBytes
    }
  }

  const verified = await verifyProject(page)
  expect(verified.ok, `final verify: ${verified.errors.join('; ')}`).toBe(true)

  // ── 最终断言：30 final / 无孤儿 / 无 context_overflow / 记忆与摘要 ────────
  const db = new Database(dbPath, { readonly: true })
  db.loadExtension(join(ROOT, 'resources', 'native', 'vec0.dll'))
  try {
    const finals = db
      .prepare("SELECT COUNT(*) AS count FROM chapter WHERE status = 'finalized' AND final_revision_id IS NOT NULL")
      .get() as { count: number }
    expect(finals.count).toBe(30)

    const finalRevisions = db.prepare("SELECT COUNT(*) AS count FROM revision WHERE kind = 'final'").get() as {
      count: number
    }
    expect(finalRevisions.count).toBe(30)

    const chaptersCount = db.prepare('SELECT COUNT(*) AS count FROM chapter').get() as { count: number }
    expect(chaptersCount.count).toBe(30)

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

    const failedJobs = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE status = 'failed'")
      .get() as { count: number }
    expect(failedJobs.count).toBe(0)

    const memory = db.prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE status = 'active'").get() as {
      count: number
    }
    expect(memory.count).toBeGreaterThan(0)

    const summaries = db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }
    expect(summaries.count).toBeGreaterThanOrEqual(30)

    const toolCalls = db
      .prepare('SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NOT NULL')
      .get() as { count: number }
    expect(toolCalls.count).toBeGreaterThan(0)
    const unmapped = db
      .prepare('SELECT COUNT(*) AS count FROM tool_call WHERE chapter_id IS NULL')
      .get() as { count: number }
    expect(unmapped.count).toBe(0)

    const words = db
      .prepare("SELECT SUM(word_count) AS words FROM beat WHERE status IN ('confirmed','author_edited')")
      .get() as { words: number | null }
    // 540 拍；正文规模由假适配器决定，这里只确认不是空稿。
    expect(words.words ?? 0).toBeGreaterThan(30 * 6)
  } finally {
    db.close()
  }

  const usage = await memoryMb(page, app)
  // eslint-disable-next-line no-console
  console.log(`E2E-M1-A final ws=${usage.workingSet}MB priv=${usage.privateBytes}MB ${JSON.stringify(usage.processes)}`)
  expect(usage.privateBytes).toBeLessThan(600)
  // 长跑不泄漏：后 25 章的私有内存增长不超过 50%（ch5 → ch30）。
  expect(baselinePrivate).toBeGreaterThan(0)
  expect(usage.privateBytes).toBeLessThanOrEqual(Math.round(baselinePrivate * 1.5))

  // 收尾：重开项目仍可校验（会话不残留孤儿/锁）。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  const reopened = await verifyProject(page)
  expect(reopened.ok).toBe(true)
})
