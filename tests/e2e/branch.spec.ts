import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { verifyDatabase } from '../../src/main/db/verify'
import type { Db } from '../../src/main/db/project-db'

/**
 * E2E-M1-BRANCH-01（PHASE-16 §6）。
 *
 * 未打包构建 + 假模型（review / memory）+ hash 嵌入：
 *   定稿 → 记忆固化（旧记忆存在）→ 重新打开 → 改一拍 → 开分支写 2 拍 →
 *   对比两版 → 切回主线不丢分支 → 再定稿（新 final，旧 final 可读）→
 *   自动 memory.rebuild（旧记忆 inactive，不重复入队 memory.extract）→ db.verify 绿。
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
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_MEMORY_EMBED = 'hash'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
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
        title: '黑漆匣子 · 分支',
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

test('E2E-M1-BRANCH-01：重开定稿 → 分支对比/切换 → 再定稿 → 记忆重建', async () => {
  test.setTimeout(300_000)
  const userData = makeTemp('noryth-branch-user-')
  const parent = makeTemp('noryth-branch-project-')
  const app = await launch(userData)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })

  const project = await createProject(page, parent, '分支与重开')
  const seeded = await page.evaluate(async () => window.noryth!.review.devSeed({}))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)
  const chapterId = seeded.data.chapterId
  const beatIds = seeded.data.draft.map((beat) => beat.beatId)

  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="review"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')

  // G4 自动报告（假模型）。
  await expect(page.locator('[data-testid="review-verdict"]')).toHaveAttribute('data-verdict', 'fail', {
    timeout: 90_000
  })

  // 第一次定稿（有阻断 → 勾选「我已复核」）。
  await page.locator('[data-testid="review-finalize"]').click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeVisible()
  const ackBlocking = page.locator('[data-testid="review-ack-blocking"]')
  if (await ackBlocking.count()) await ackBlocking.check()
  const ackUnreviewed = page.locator('[data-testid="review-ack-unreviewed"]')
  if (await ackUnreviewed.count()) await ackUnreviewed.check()
  await page.locator('[data-testid="review-finalize-confirm"]').click()
  await expect(page.locator('[data-testid="review-finalize"]')).toContainText('已定稿', { timeout: 60_000 })

  const firstFinal = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? result.data.finalRevisionId : null
  }, chapterId)
  expect(firstFinal).toBeTruthy()

  // 固化第一版记忆：extract → 全部接受 → G7 apply。
  const applied = await page.evaluate(async (id) => {
    const extracted = await window.noryth!.memory.extract(id)
    if (!extracted.ok) return { ok: false, code: extracted.error.code, message: extracted.error.message }
    const state = await window.noryth!.memory.state(id)
    if (!state.ok) return { ok: false, code: state.error.code, message: state.error.message }
    const items = state.data.proposals
    if (items.length === 0) return { ok: false, code: 'no_items', message: 'no proposals' }
    await window.noryth!.memory.decideMany({
      decisions: items.map((item) => ({ itemId: item.id, decision: 'accept' as const }))
    })
    const token = await window.noryth!.memory.issueG7Token(id)
    if (!token.ok) return { ok: false, code: token.error.code, message: token.error.message }
    const result = await window.noryth!.memory.apply({ chapterId: id, token: token.data.token })
    return result.ok
      ? { ok: true, count: result.data.state.entries.length }
      : { ok: false, code: result.error.code, message: result.error.message, details: result.error.details }
  }, chapterId)
  expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true })
  if (!applied.ok) throw new Error(applied.code)
  expect(applied.count).toBeGreaterThan(0)

  // 重新打开定稿。
  await page.locator('[data-testid="review-reopen"]').click()
  await expect(page.locator('[data-testid="review-reopen-dialog"]')).toBeVisible()
  await page.locator('[data-testid="review-reopen-reason"]').fill('第 1 拍需要重写')
  await page.locator('[data-testid="review-reopen-confirm"]').click()
  await expect(page.locator('[data-testid="review-reopen"]')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('[data-testid="review-finalize"]')).toContainText('定稿 G6')

  const reopened = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok
      ? {
          status: result.data.chapterStatus,
          revisionId: result.data.revisionId,
          finalRevisionId: result.data.finalRevisionId
        }
      : null
  }, chapterId)
  expect(reopened?.status).toBe('revising')
  expect(reopened?.finalRevisionId).toBe(firstFinal)
  expect(reopened?.revisionId).not.toBe(firstFinal)

  // 改一拍（主线 draft）。
  const edited = await page.evaluate(
    async ({ beatId, expectedRevision }) =>
      window.noryth!.write.edit({ beatId, body: '重开后的第一处修改。', expectedRevision }),
    { beatId: beatIds[0]!, expectedRevision: reopened!.revisionId }
  )
  expect(edited.ok).toBe(true)

  // 开分支（版本 tab）+ 在分支上写 2 拍。
  await page.locator('[data-testid="review-tab-versions"]').click()
  await expect(page.locator('[data-testid="review-branch-tree"]')).toBeVisible()
  await page.locator('[data-testid="review-branch-name"]').fill('改写线')
  await page.locator('[data-testid="review-branch-create-run"]').click()
  await expect(page.locator('[data-testid^="review-branch-row-"]')).toHaveCount(1, { timeout: 30_000 })

  const branch = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? result.data.branches[0] ?? null : null
  }, chapterId)
  expect(branch).not.toBeNull()

  let branchHead = branch!.headRevisionId
  for (const [index, beatId] of [beatIds[1]!, beatIds[2]!].entries()) {
    const result = await page.evaluate(
      async ({ beatId: id, expectedRevision, body }) =>
        window.noryth!.write.edit({ beatId: id, body, expectedRevision }),
      { beatId, expectedRevision: branchHead, body: `分支上的第 ${index + 1} 处改法。` }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.code)
    branchHead = result.data.state.revisionId!
  }

  // 对比：主线 vs 分支 head，按拍对齐。
  // 分支上的两次写入走的是 bridge（不经过审批台 store），先点一次章行重载 state，
  // 让版本下拉包含新的分支 head。
  await page.locator(`[data-testid="review-chapter-${chapterId}"]`).click()
  await expect(page.locator('[data-testid="review-branch-tree"]')).toBeVisible({ timeout: 30_000 })
  const overview = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok
      ? { mainlineHeadId: result.data.mainlineHeadId, branchHeadId: result.data.branches[0]?.headRevisionId ?? null }
      : null
  }, chapterId)
  expect(overview?.mainlineHeadId).toBeTruthy()
  await page.locator('[data-testid="review-compare-left"]').selectOption(overview!.mainlineHeadId!)
  await page.locator('[data-testid="review-compare-right"]').selectOption(overview!.branchHeadId!)
  await page.locator('[data-testid="review-compare-run"]').click()
  await expect(page.locator('[data-testid="review-compare-result"]')).toContainText('拍有变化')
  const compare = await page.evaluate(
    async ({ id, left, right }) => {
      const result = await window.noryth!.review.compare({ chapterId: id, leftRevisionId: left, rightRevisionId: right })
      return result.ok ? { changed: result.data.changedBeats, hunks: result.data.hunks.length } : null
    },
    { id: chapterId, left: overview!.mainlineHeadId!, right: overview!.branchHeadId! }
  )
  expect(compare?.changed).toBeGreaterThanOrEqual(2)
  expect(compare?.hunks).toBeGreaterThanOrEqual(6)

  // 切回主线：分支保留，当前 revision = 主线末梢。
  await page.locator('[data-testid="review-branch-switch-mainline"]').click()
  await expect(page.locator('[data-testid="review-branch-mainline"]')).toHaveAttribute('data-current', 'true', {
    timeout: 30_000
  })
  const backToMain = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok
      ? { revisionId: result.data.revisionId, branchId: result.data.branchId, branches: result.data.branches.length }
      : null
  }, chapterId)
  expect(backToMain?.branchId).toBeNull()
  expect(backToMain?.revisionId).toBe(overview!.mainlineHeadId)
  expect(backToMain?.branches).toBe(1)

  // 再定稿（主线，含重开后的修改）。
  await page.locator('[data-testid="review-finalize"]').click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeVisible()
  for (const testId of ['review-ack-blocking', 'review-ack-unreviewed']) {
    const box = page.locator(`[data-testid="${testId}"]`)
    if (await box.count()) await box.check()
  }
  await page.locator('[data-testid="review-finalize-confirm"]').click()
  await expect(page.locator('[data-testid="review-finalize"]')).toContainText('已定稿', { timeout: 60_000 })

  const secondFinal = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.state(id)
    return result.ok ? result.data.finalRevisionId : null
  }, chapterId)
  expect(secondFinal).toBeTruthy()
  expect(secondFinal).not.toBe(firstFinal)

  // 自动 memory.rebuild 完成（后台任务）。用显式轮询而不是 waitForFunction：
  // 这里要读的是 bridge 的异步状态，轮询失败时也能打印最后状态。
  let rebuildState: { jobStatus: string | null; errorCode: string | null; running: boolean } | null = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    rebuildState = await page.evaluate(async (id) => {
      const result = await window.noryth!.memory.state(id)
      return result.ok
        ? {
            jobStatus: result.data.rebuild.jobStatus,
            errorCode: result.data.rebuild.errorCode,
            running: result.data.running
          }
        : null
    }, chapterId)
    if (rebuildState?.jobStatus === 'applied' || rebuildState?.jobStatus === 'failed') break
    await page.waitForTimeout(1000)
  }
  expect(rebuildState, JSON.stringify(rebuildState)).toMatchObject({ jobStatus: 'applied' })

  // 旧 final 仍可读，对比旧 final → 新 final 有差异。
  const finalDiff = await page.evaluate(
    async ({ id, left, right }) => {
      const result = await window.noryth!.review.compare({ chapterId: id, leftRevisionId: left, rightRevisionId: right })
      return result.ok ? result.data.changedBeats : null
    },
    { id: chapterId, left: firstFinal!, right: secondFinal! }
  )
  expect(finalDiff).toBeGreaterThanOrEqual(1)

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const chapter = db
      .prepare('SELECT status, final_revision_id FROM chapter WHERE id = ?')
      .get(chapterId) as { status: string; final_revision_id: string }
    expect(chapter.status).toBe('finalized')
    expect(chapter.final_revision_id).toBe(secondFinal)

    const finals = db
      .prepare("SELECT id, parent_revision_id FROM revision WHERE chapter_id = ? AND kind = 'final' ORDER BY created_at")
      .all(chapterId) as Array<{ id: string; parent_revision_id: string }>
    expect(finals).toHaveLength(2)
    expect(finals[0]!.id).toBe(firstFinal)
    expect(finals[1]!.id).toBe(secondFinal)

    const oldMembers = db
      .prepare('SELECT COUNT(*) AS count FROM revision_beat WHERE revision_id = ?')
      .get(firstFinal!) as { count: number }
    expect(oldMembers.count).toBe(6)
    const newMembers = db
      .prepare('SELECT COUNT(*) AS count FROM revision_beat WHERE revision_id = ?')
      .get(secondFinal!) as { count: number }
    expect(newMembers.count).toBe(6)

    const branches = db
      .prepare('SELECT id, head_revision_id FROM revision_branch WHERE chapter_id = ?')
      .all(chapterId) as Array<{ id: string; head_revision_id: string }>
    expect(branches).toHaveLength(1)
    expect(branches[0]!.head_revision_id).toBe(branchHead)
    const branchRevisions = db
      .prepare('SELECT COUNT(*) AS count FROM revision WHERE chapter_id = ? AND branch_id = ?')
      .get(chapterId, branches[0]!.id) as { count: number }
    expect(branchRevisions.count).toBeGreaterThanOrEqual(3)

    const summaries = db
      .prepare('SELECT revision_id, tokens FROM chapter_summary WHERE chapter_id = ?')
      .all(chapterId) as Array<{ revision_id: string; tokens: number }>
    expect(summaries.map((row) => row.revision_id).sort()).toEqual([firstFinal!, secondFinal!].sort())
    expect(summaries.every((row) => row.tokens <= 300)).toBe(true)

    const memory = db
      .prepare("SELECT status, COUNT(*) AS count FROM memory_entry WHERE source_chapter_id = ? GROUP BY status")
      .all(chapterId) as Array<{ status: string; count: number }>
    const memoryByStatus = Object.fromEntries(memory.map((row) => [row.status, row.count]))
    expect(memoryByStatus['inactive'] ?? 0).toBeGreaterThan(0)
    expect(memoryByStatus['active'] ?? 0).toBeGreaterThan(0)

    const rebuild = db
      .prepare("SELECT status, result_json FROM job WHERE type = 'memory.rebuild' AND expected_revision = ?")
      .get(secondFinal!) as { status: string; result_json: string } | undefined
    expect(rebuild?.status).toBe('succeeded')
    expect((JSON.parse(rebuild!.result_json) as { applied?: boolean }).applied).toBe(true)

    const duplicateExtract = db
      .prepare(
        `SELECT COUNT(*) AS count FROM job
         WHERE type = 'memory.extract' AND expected_revision = ? AND payload_json NOT LIKE '%"rebuild":true%'`
      )
      .get(secondFinal!) as { count: number }
    expect(duplicateExtract.count).toBe(0)

    const report = verifyDatabase(db as unknown as Db, { checkMirror: false })
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(report.ok).toBe(true)
  } finally {
    db.close()
  }
})
