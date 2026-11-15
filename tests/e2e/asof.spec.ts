import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-ASOF-01（PHASE-13 §6）：
 *
 * 20 章的真实项目里只演第 3 章与第 20 章：
 *   1. 第 20 章水位上新加的事实，在第 3 章的投影里**不存在**（futureFacts）；
 *   2. 第 3 章时就已存在、第 20 章才揭示的旧事实，第 3 章审批看得到（审计），
 *      但「读者已知」视图看不到——「读者未知」不等于「不存在」；
 *   3. 审批第 3 章用的是本章水位（review.state.asOf = 本章 covered_until_seq），
 *      报告引用的证据全部 ≤ 该水位；
 *   4. 作者在世界状态页新增 / 关闭事实：source_type=author + 审计 actor=author，
 *      as-of 回放与「关闭后仍可回放」都成立。
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
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_REVIEW_API_KEY

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
        title: '黑漆匣子 · as-of',
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
  return { path: result.data.path }
}

async function seed(page: Page, input: Record<string, unknown>): Promise<{ chapterIds: string[] }> {
  const seeded = await page.evaluate(async (payload) => window.noryth!.write.devSeed(payload), input)
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  return { chapterIds: seeded.data.chapters.map((chapter) => chapter.id) }
}

/** 把一章演到 draft_complete：G2 + 自动模式（exit=beats(2)）。 */
async function performChapter(page: Page, chapterId: string): Promise<void> {
  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapterId)
  expect(g2.ok).toBe(true)
  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), chapterId)
  expect(auto.ok).toBe(true)
  if (auto.ok) expect(auto.data.state.chapterStatus).toBe('draft_complete')
}

async function coverageOf(page: Page, chapterId: string) {
  const result = await page.evaluate(
    async (id) => window.noryth!.world.projection({ chapterId: id }),
    chapterId
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}

test.afterAll(() => {
  for (const app of apps) void app.close().catch(() => undefined)
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 偶发占用；临时目录可以留给系统清理。
    }
  }
})

test('E2E-M1-ASOF-01：第 3 章读不到第 20 章新事实，读者未知 ≠ 不存在', async () => {
  const userData = makeTemp('noryth-asof-user-')
  const parent = makeTemp('noryth-asof-proj-')
  const { page } = await launch(userData)
  const { path } = await createProject(page, parent, 'asof')
  const { chapterIds } = await seed(page, {
    chapters: 20,
    seedEveryChapter: true,
    scenes: 1,
    beatsPerScene: 2,
    exit: 'beats(2)'
  })
  expect(chapterIds).toHaveLength(20)
  const chapterThree = chapterIds[2]!
  const chapterTwenty = chapterIds[19]!

  await performChapter(page, chapterThree)
  await performChapter(page, chapterTwenty)

  const ch3 = await coverageOf(page, chapterThree)
  const ch20 = await coverageOf(page, chapterTwenty)
  expect(ch3.asOf).toBeGreaterThan(0)
  expect(ch20.asOf).toBeGreaterThan(ch3.asOf)

  // ── 两条作者事实 ────────────────────────────────────────────────────────
  // A. 第 20 章水位才产生：第 3 章「还不存在」。
  const future = await page.evaluate(
    async ({ chapterId, seq }) =>
      window.noryth!.world.addFact({
        chapterId,
        subject: '账本',
        predicate: '位置',
        object: '祠堂夹层',
        truth: 'objective',
        visibility: 'public',
        revealSeq: seq,
        validFromSeq: seq
      }),
    { chapterId: chapterTwenty, seq: ch20.asOf }
  )
  expect(future.ok).toBe(true)
  if (!future.ok) throw new Error(future.error.code)

  // B. 第 1 章就存在、第 20 章才揭示：审批看得到，读者看不到。
  const lateReveal = await page.evaluate(
    async ({ chapterId, seq }) =>
      window.noryth!.world.addFact({
        chapterId,
        asOf: seq,
        subject: '沈老太爷',
        predicate: '秘密',
        object: '早夭的名字',
        truth: 'objective',
        visibility: 'public',
        revealSeq: seq,
        validFromSeq: 0
      }),
    { chapterId: chapterTwenty, seq: ch20.asOf }
  )
  expect(lateReveal.ok).toBe(true)
  if (!lateReveal.ok) throw new Error(lateReveal.error.code)

  // ── 世界状态页：第 3 章水位看不到新事实，但看得到旧事实 ──────────────────
  await page.locator('[data-nav="memory"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="memory-tab-world"]').click()
  await expect(page.locator('[data-testid="memory-world"]')).toBeVisible()
  await page.locator('[data-testid="world-chapter"]').selectOption(chapterThree)
  await expect(page.locator('[data-testid="world-asof-value"]')).toContainText(`${ch3.asOf} / ${ch20.seqHead}`)
  const table = page.locator('[data-testid="memory-world-facts"]')
  await expect(table).toContainText('早夭的名字')
  await expect(table).not.toContainText('祠堂夹层')
  await expect(page.locator('[data-testid="world-counts"]')).toContainText('更晚章节 1')

  // 读者视图：旧事实仍在，但读者不知道（第 3 章水位下读者已知为 0）。
  await page.locator('[data-testid="world-reader-only"]').check()
  await expect(page.locator('[data-testid="world-fact-count"]')).toHaveText('0')
  await expect(page.locator('[data-testid="memory-world"]')).not.toContainText('早夭的名字')
  await page.locator('[data-testid="world-reader-only"]').uncheck()
  await expect(page.locator('[data-testid="memory-world-facts"]')).toContainText('早夭的名字')

  // 第 20 章水位：两条都在。
  await page.locator('[data-testid="world-chapter"]').selectOption(chapterTwenty)
  await expect(page.locator('[data-testid="memory-world-facts"]')).toContainText('祠堂夹层')

  // ── 作者编辑器：UI 新增 + 关闭（source_type=author，可回放） ─────────────
  await page.locator('[data-testid="world-chapter"]').selectOption(chapterThree)
  await page.locator('[data-testid="world-new-subject"]').fill('账本')
  await page.locator('[data-testid="world-new-predicate"]').fill('页数')
  await page.locator('[data-testid="world-new-object"]').fill('三十七页')
  // 生效序与揭示序都定在第 3 章水位：这一条在当前视图里可见。
  await page.locator('[data-testid="world-new-validfrom"]').fill(String(ch3.asOf))
  await page.locator('[data-testid="world-new-reveal"]').fill(String(ch3.asOf))
  await page.locator('[data-testid="world-fact-add"]').click()
  await expect(page.locator('[data-testid="memory-world-facts"]')).toContainText('三十七页')

  const row = page.locator('[data-testid="memory-world-facts"] tr').filter({ hasText: '三十七页' })
  await row.locator('button', { hasText: /^关闭$/ }).click()
  await row.locator('button', { hasText: /^确认关闭$/ }).click()

  // 关闭序 = 当前项目水位（第 20 章）：第 20 章视图看不到，第 3 章回放仍看得到。
  await page.locator('[data-testid="world-chapter"]').selectOption(chapterTwenty)
  await expect(page.locator('[data-testid="memory-world-facts"]')).not.toContainText('三十七页')
  await page.locator('[data-testid="world-chapter"]').selectOption(chapterThree)
  await expect(page.locator('[data-testid="memory-world-facts"]')).toContainText('三十七页')

  // ── 审批第 3 章：asOf = 本章水位，证据 ≤ 该水位 ──────────────────────────
  const review = await page.evaluate(async (id) => window.noryth!.review.run(id), chapterThree)
  expect(review.ok).toBe(true)
  if (!review.ok) throw new Error(review.error.code)
  const reviewState = review.data.state
  expect(reviewState.asOf).toBe(ch3.asOf)
  expect(reviewState.asOf).toBeLessThan(ch20.asOf)
  expect(reviewState.hasReport).toBe(true)

  const evidenceSeqs = [...(reviewState.report?.blocking ?? []), ...(reviewState.report?.suggestions ?? [])]
    .map((issue) => issue.beat_id)
    .filter((beatId) => beatId.length > 0)
  const db = new Database(join(path, 'noryth.db'), { readonly: true })
  try {
    for (const beatId of evidenceSeqs) {
      const row = db.prepare('SELECT chapter_id, seq FROM beat WHERE id = ?').get(beatId) as
        | { chapter_id: string; seq: number | null }
        | undefined
      if (!row) continue
      expect(row.chapter_id).toBe(chapterThree)
      expect(row.seq ?? 0).toBeLessThanOrEqual(ch3.asOf)
    }

    // A. 作者事实真的落成 source_type='author'，并被审计。
    const authorFacts = db
      .prepare(`SELECT subject, predicate, object FROM world_fact WHERE source_type = 'author'`)
      .all() as Array<{ subject: string; predicate: string; object: string }>
    expect(authorFacts.some((row) => row.object === '祠堂夹层')).toBe(true)
    expect(authorFacts.some((row) => row.object === '早夭的名字')).toBe(true)
    const audits = db
      .prepare(`SELECT COUNT(*) AS count FROM memory_audit WHERE actor = 'author' AND entity_type = 'world_fact'`)
      .get() as { count: number }
    expect(audits.count).toBeGreaterThanOrEqual(3) // 2 新增 + 1 关闭

    // B. 关闭事实只写 valid_to_seq，不物理删除。
    const closed = db
      .prepare(`SELECT valid_to_seq FROM world_fact WHERE object = '三十七页'`)
      .get() as { valid_to_seq: number | null } | undefined
    expect(closed).toBeDefined()
    expect(closed!.valid_to_seq).not.toBeNull()
  } finally {
    db.close()
  }
})
