import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-REVIEW-01（PHASE-08 §6）。
 *
 * 未打包构建 + `NORYTH_REVIEW_FAKE=1`：
 *   devSeed（1 章 6 拍已确认 + draft_complete）→ 自动 G4 报告（fail，2 阻断 / 3 建议）
 *   → 讨论（不改稿）→ G5 → 3 条 patch → 接受 2 拒绝 1 → 新 revision → 复检 → G6 定稿。
 *
 * 定稿后：写正文被拒（already_finalized）、final 快照可读、G6 记录可查、memory.extract 已排队。
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
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_REVIEW_API_KEY

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
        title: '黑漆匣子 · 审批台',
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

test('E2E-REVIEW-01：报告 fail → G5 → 3 patch → 接受 2 拒绝 1 → 复检 → G6 定稿', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-review-user-')
  const parent = makeTemp('noryth-review-project-')
  const app = await launch(userData)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })

  const project = await createProject(page, parent, '审批台主流程')
  const seeded = await page.evaluate(async () => window.noryth!.review.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  expect(seeded.data.chapterStatus).toBe('draft_complete')
  const chapterId = seeded.data.chapterId
  const firstBeatId = seeded.data.draft[0]!.beatId

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="review"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // 进入审批台自动跑 G4：报告 fail（2 阻断 / 3 建议）。
  const verdict = page.locator('[data-testid="review-verdict"]')
  await expect(verdict).toHaveAttribute('data-verdict', 'fail', { timeout: 90_000 })
  await expect(page.locator('[data-testid="review-report"] .review-issue.is-blocking')).toHaveCount(2)
  await expect(page.locator('[data-testid="review-report"] .review-issue.is-suggestion')).toHaveCount(3)
  await expect(page.locator('[data-testid="review-issue-iss_01"]')).toBeVisible()
  await expect(page.locator('[data-testid="review-evidence-iss_01"]')).not.toBeEmpty()

  // 初稿 gutter 有实心阻断标记
  await page.locator('[data-testid="review-tab-draft"]').click()
  await expect(page.locator('[data-testid="review-mark-iss_01"]')).toBeVisible()
  await expect(page.locator('[data-testid="review-draft"]')).toContainText('茶盏')

  // 讨论阶段不改稿：追问后 revision 不变
  await page.locator('[data-testid="review-composer"]').fill('第 1 条阻断能具体指到哪一句？')
  await page.locator('[data-testid="review-composer"]').press('Control+Enter')
  await expect(page.locator('[data-testid="review-message-reviewer"]').last()).toContainText('阻断', {
    timeout: 30_000
  })
  const revisionBefore = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? result.data.revisionId : null
  }, chapterId)

  // G5 → 3 条 patch
  await page.locator('[data-testid="review-g5"]').click()
  await expect(page.locator('[data-testid="review-diff"]')).toBeVisible({ timeout: 60_000 })
  const patchCards = page.locator('[data-testid^="review-patch-"]').filter({ has: page.locator('.review-patch__reason') })
  await expect(patchCards).toHaveCount(3)

  // 接受 2 拒绝 1 → 一次执行 → 一个新 revision（卡按时间倒序渲染，最后一张是最早的 patch）
  await page.locator('[data-testid^="review-patch-accept-"]').nth(0).click()
  await page.locator('[data-testid^="review-patch-accept-"]').nth(1).click()
  await page.locator('[data-testid^="review-patch-reject-"]').nth(2).click()
  await page.locator('[data-testid="review-patch-apply"]').click()
  await expect(page.locator('.review-patch[data-status="applied"]')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.review-patch[data-status="rejected"]')).toHaveCount(1)

  const afterApply = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? { revisionId: result.data.revisionId, unreviewed: result.data.g6.unreviewedCount } : null
  }, chapterId)
  expect(afterApply?.revisionId).not.toBe(revisionBefore)
  expect(afterApply?.unreviewed).toBeGreaterThan(0)

  // 复检 → 只跑受影响维度
  await page.locator('[data-testid="review-recheck"]').click()
  await expect(page.locator('[data-testid="review-round"]')).toContainText('2/3', { timeout: 60_000 })
  await expect(verdict).toHaveAttribute('data-verdict', /pass/, { timeout: 60_000 })
  const recheck = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? { scope: result.data.reports.at(-1)?.scope ?? [], status: result.data.chapterStatus } : null
  }, chapterId)
  expect(recheck?.scope.length).toBeGreaterThan(0)
  expect(recheck?.status).toBe('approved')

  // 版本对比：任意两版
  await page.locator('[data-testid="review-tab-versions"]').click()
  await page.locator('[data-testid="review-compare-run"]').click()
  await expect(page.locator('[data-testid="review-compare-result"]')).toBeVisible()
  await expect(page.locator('[data-testid="review-compare-result"]')).toContainText('拍有变化')

  // 命令面板定稿走同一个确认框（不是另一套流程）
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.palette__input')
  await page.locator('.palette__input').fill('定稿')
  await expect(page.locator('.palette__item').first()).toContainText('定稿本章')
  await page.locator('.palette__item').first().click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-testid="review-finalize-dialog"]').getByRole('button', { name: '取消' }).click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeHidden()

  // G6：定稿按钮只在审批台 header；确认框 → 定稿
  await page.locator('[data-testid="review-finalize"]').click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeVisible()
  await page.locator('[data-testid="review-finalize-confirm"]').click()
  await expect(page.locator('[data-testid="review-finalize"]')).toContainText('已定稿', { timeout: 60_000 })

  // 定稿后写正文被拒
  const writeAttempt = await page.evaluate(
    async ({ beatId }) => {
      const result = await window.noryth!.write.edit({ beatId, body: '定稿后不该写进去的正文', expectedRevision: null })
      return result.ok ? null : result.error.code
    },
    { beatId: firstBeatId }
  )
  expect(writeAttempt).toBe('already_finalized')

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const chapter = db.prepare('SELECT status, final_revision_id FROM chapter WHERE id = ?').get(chapterId) as {
      status: string
      final_revision_id: string | null
    }
    expect(chapter.status).toBe('finalized')
    expect(chapter.final_revision_id).toBeTruthy()

    const final = db
      .prepare('SELECT kind, created_by, content_hash FROM revision WHERE id = ?')
      .get(chapter.final_revision_id!) as { kind: string; created_by: string; content_hash: string }
    expect(final.kind).toBe('final')
    expect(final.created_by).toBe('author')
    expect(final.content_hash).toHaveLength(64)

    const members = db
      .prepare('SELECT COUNT(*) AS count FROM revision_beat WHERE revision_id = ?')
      .get(chapter.final_revision_id!) as { count: number }
    expect(members.count).toBe(6)

    const gate = db
      .prepare("SELECT payload_json, consumed_at FROM gate_record WHERE gate_id = 'G6' AND entity_id = ?")
      .get(chapterId) as { payload_json: string; consumed_at: string | null }
    expect(gate.consumed_at).not.toBeNull()
    expect(JSON.parse(gate.payload_json).finalRevisionId).toBe(chapter.final_revision_id)

    const memoryJob = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE type = 'memory.extract' AND status = 'queued'")
      .get() as { count: number }
    expect(memoryJob.count).toBe(1)

    const liveBeats = db
      .prepare("SELECT status, COUNT(*) AS count FROM beat WHERE status <> 'superseded' GROUP BY status")
      .all() as Array<{ status: string; count: number }>
    const byStatus = Object.fromEntries(liveBeats.map((row) => [row.status, row.count]))
    expect(byStatus['confirmed']).toBe(6)
    expect(byStatus['draft']).toBeUndefined()

    const reports = db
      .prepare('SELECT round, verdict, scope_json FROM approval_report WHERE chapter_id = ? ORDER BY round')
      .all(chapterId) as Array<{ round: number; verdict: string; scope_json: string }>
    expect(reports).toHaveLength(2)
    expect(reports[0]!.verdict).toBe('fail')
    expect((JSON.parse(reports[1]!.scope_json) as string[]).length).toBeGreaterThan(0)

    const patches = db
      .prepare("SELECT status, COUNT(*) AS count FROM patch WHERE revision_id IS NOT NULL GROUP BY status")
      .all() as Array<{ status: string; count: number }>
    const patchStatus = Object.fromEntries(patches.map((row) => [row.status, row.count]))
    expect(patchStatus['applied']).toBe(2)
    expect(patchStatus['rejected']).toBe(1)
  } finally {
    db.close()
  }
})
