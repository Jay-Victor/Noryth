import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { hashFile, hashManifestRows } from '../../src/main/db/hash'

/**
 * E2E-SLICE-01（PHASE-05 §6）：
 *   seed → 生成 2 拍 → 确认 1 拍 → 重生成 1 拍 → 编辑 1 次 → 重启 → 状态一致
 * 以及强杀：生成第 2 拍时 taskkill，重启后第 1 拍仍在、第 2 拍 interrupted 可重试。
 *
 * 只读 DB 断言用 better-sqlite3；UI 断言只看状态，不比对文案全文。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string, delayMs = 2): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_SLICE = '1'
  env.NORYTH_SLICE_STREAM_DELAY_MS = String(delayMs)

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 切片',
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

async function openSlice(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/dev/slice'
  })
  await page.waitForSelector('[data-testid="slice-page"]')
}

function statusOf(page: Page, ord: number) {
  return page.locator(`[data-testid="slice-status-ord-${ord}"]`)
}

function bodyOf(page: Page, ord: number) {
  return page.locator(`[data-testid="slice-body-ord-${ord}"]`)
}

async function generateAndWait(page: Page, ord: number): Promise<void> {
  await page.locator(`[data-testid="slice-generate-ord-${ord}"]`).click()
  await expect(statusOf(page, ord)).toHaveAttribute('data-status', 'waiting_for_human', { timeout: 30_000 })
}

function killTree(app: ElectronApplication): void {
  const pid = app.process().pid
  if (!pid) throw new Error('electron process has no pid')
  execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' })
}

interface DbManifestRow {
  scene_id: string
  scene_ord: number
  beat_ord: number
  speaker_type: 'character' | 'narrator'
  speaker_id: string
  body: string
}

function readManifest(db: Database.Database, revisionId: string): DbManifestRow[] {
  return db
    .prepare(
      `SELECT b.scene_id, rb.scene_ord, rb.beat_ord, b.speaker_type, b.speaker_id, b.body
       FROM revision_beat rb JOIN beat b ON b.id = rb.beat_id
       WHERE rb.revision_id = ?
       ORDER BY rb.scene_ord, rb.beat_ord`
    )
    .all(revisionId) as DbManifestRow[]
}

function hashRows(rows: readonly DbManifestRow[]): string {
  return hashManifestRows(
    rows.map((row) => ({
      sceneId: row.scene_id,
      sceneOrd: row.scene_ord,
      beatOrd: row.beat_ord,
      speakerType: row.speaker_type,
      speakerId: row.speaker_id,
      body: row.body
    }))
  )
}

test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  for (const app of apps) {
    try {
      await app.close()
    } catch {
      // 强杀后已退出
    }
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用，留给系统清理
    }
  }
})

test('E2E-SLICE-01：seed → 两拍 → 确认 → 重生成 → 编辑 → 重启', async () => {
  const userData = makeTemp('noryth-slice-user-')
  const parent = makeTemp('noryth-slice-project-')
  const { app, page } = await launch(userData, 30)
  const project = await createProject(page, parent, '切片主流程')

  await expect(page.locator('[data-nav="slice"]')).toHaveCount(0)
  await openSlice(page)

  await page.locator('[data-testid="slice-seed"]').click()
  await expect(statusOf(page, 1)).toHaveAttribute('data-status', 'proposed')
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'proposed')
  await expect(page.locator('[data-testid="slice-empty"]')).toHaveCount(0)

  // 第一拍：旁白
  await generateAndWait(page, 1)
  const body1 = await bodyOf(page, 1).innerText()
  expect(body1.length).toBeGreaterThan(5)
  await expect(page.locator('[data-testid="slice-trace-ord-1"]')).toContainText('logs/trace/')

  // 确认：150ms 内下一拍占位可见（乐观更新，不等 IPC 往返）
  await page.locator('[data-testid="slice-confirm-ord-1"]').click()
  await expect(statusOf(page, 1)).toHaveAttribute('data-status', 'confirmed', { timeout: 150 })
  await expect(page.locator('[data-testid="slice-beat-ord-2"]')).toBeVisible({ timeout: 150 })
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'proposed', { timeout: 150 })

  // 第二拍：角色 + 一次工具调用 + 依据 chips
  await page.locator('[data-testid="slice-generate-ord-2"]').click()
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'generating', { timeout: 5_000 })
  await page.waitForTimeout(120)
  // 流式只更新当前拍：已确认段落不变
  expect(await bodyOf(page, 1).innerText()).toBe(body1)
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'waiting_for_human', { timeout: 30_000 })

  const body2a = await bodyOf(page, 2).innerText()
  expect(body2a.length).toBeGreaterThan(5)
  const chip = page.locator('[data-testid="slice-chip-memory-mem_slice_lin_1"]')
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.locator('[data-testid="slice-quote-memory-mem_slice_lin_1"]')).toContainText(
    '父亲书房有一只上锁的黑漆匣子'
  )

  // 重生成：换一版正文
  await page.locator('[data-testid="slice-regenerate-ord-2"]').click()
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'waiting_for_human', { timeout: 30_000 })
  const body2b = await bodyOf(page, 2).innerText()
  expect(body2b).not.toBe(body2a)

  // 编辑：作者直接改
  const edited = '「那匣子，你见过没有？」她把茶盏推了回去。'
  await page.locator('[data-testid="slice-edit-toggle-ord-2"]').click()
  await page.locator('[data-testid="slice-edit-input-ord-2"]').fill(edited)
  await page.locator('[data-testid="slice-edit-save-ord-2"]').click()
  await expect(statusOf(page, 2)).toHaveAttribute('data-status', 'author_edited', { timeout: 10_000 })
  await expect(bodyOf(page, 2)).toHaveText(edited)
  expect(await bodyOf(page, 1).innerText()).toBe(body1)

  await app.close()

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const chapter = db
      .prepare('SELECT current_revision_id, covered_until_seq FROM chapter WHERE id = ?')
      .get('ch_slice_01') as { current_revision_id: string; covered_until_seq: number }
    expect(chapter.current_revision_id).toBeTruthy()
    expect(chapter.covered_until_seq).toBeGreaterThan(0)

    const revisions = db
      .prepare("SELECT id, content_hash FROM revision WHERE chapter_id = 'ch_slice_01' ORDER BY rowid")
      .all() as Array<{ id: string; content_hash: string }>
    expect(revisions).toHaveLength(5)
    for (const revision of revisions) {
      const rows = readManifest(db, revision.id)
      expect(rows).toHaveLength(2)
      expect(hashRows(rows)).toBe(revision.content_hash)
    }

    const live = db
      .prepare("SELECT status FROM beat WHERE chapter_id = 'ch_slice_01' AND status <> 'superseded' ORDER BY ord")
      .all() as Array<{ status: string }>
    expect(live.map((row) => row.status)).toEqual(['confirmed', 'author_edited'])

    const outbox = db
      .prepare("SELECT expected_hash, published_at FROM outbox WHERE chapter_id = 'ch_slice_01' ORDER BY rowid DESC LIMIT 1")
      .get() as { expected_hash: string; published_at: string | null }
    expect(outbox.published_at).toBeTruthy()
    const mirror = join(project.path, 'manuscript', 'ch-001.md')
    expect(existsSync(mirror)).toBe(true)
    expect(hashFile(mirror)).toBe(outbox.expected_hash)

    const trace = db
      .prepare("SELECT trace_ref FROM beat WHERE chapter_id = 'ch_slice_01' AND trace_ref IS NOT NULL LIMIT 1")
      .get() as { trace_ref: string }
    expect(existsSync(join(project.path, trace.trace_ref))).toBe(true)
  } finally {
    db.close()
  }
})

test('强杀重启：已确认拍零丢失，生成中的拍 interrupted 可重试', async () => {
  const userData = makeTemp('noryth-slice-kill-user-')
  const parent = makeTemp('noryth-slice-kill-project-')
  const first = await launch(userData, 120)
  const project = await createProject(first.page, parent, '切片强杀')
  await openSlice(first.page)
  await first.page.locator('[data-testid="slice-seed"]').click()
  await generateAndWait(first.page, 1)
  await first.page.locator('[data-testid="slice-confirm-ord-1"]').click()
  await expect(statusOf(first.page, 1)).toHaveAttribute('data-status', 'confirmed', { timeout: 150 })

  // 第二拍开始流式后强杀
  await first.page.locator('[data-testid="slice-generate-ord-2"]').click()
  await expect(statusOf(first.page, 2)).toHaveAttribute('data-status', 'generating', { timeout: 5_000 })
  killTree(first.app)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200))
  try {
    await first.app.close()
  } catch {
    // 已强杀
  }

  // 重启：项目锁按 pid 判定过期；启动扫描把 running → interrupted
  const second = await launch(userData, 2)
  const opened = await second.page.evaluate(async (path) => window.noryth!.project.open({ path }), project.path)
  expect(opened.ok).toBe(true)
  if (!opened.ok) throw new Error(opened.error.code)
  expect(opened.data.readOnly).toBe(false)
  await second.page.reload()
  await second.page.waitForSelector('[data-testid="app-ready"]')
  await openSlice(second.page)

  await expect(statusOf(second.page, 1)).toHaveAttribute('data-status', 'confirmed', { timeout: 10_000 })
  await expect(statusOf(second.page, 2)).toHaveAttribute('data-status', 'interrupted', { timeout: 10_000 })
  await expect(second.page.locator('[data-testid="slice-last-job"]')).toContainText('interrupted')

  // 重试：interrupted → generating → waiting_for_human
  await generateAndWait(second.page, 2)
  await second.app.close()

  const db = new Database(join(project.path, 'noryth.db'), { readonly: true })
  try {
    const live = db
      .prepare("SELECT status FROM beat WHERE chapter_id = 'ch_slice_01' AND status <> 'superseded' ORDER BY ord")
      .all() as Array<{ status: string }>
    expect(live.map((row) => row.status)).toEqual(['confirmed', 'waiting_for_human'])

    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS count FROM revision_beat rb
         LEFT JOIN beat b ON b.id = rb.beat_id WHERE b.id IS NULL`
      )
      .get() as { count: number }
    expect(orphans.count).toBe(0)

    const current = db
      .prepare("SELECT current_revision_id FROM chapter WHERE id = 'ch_slice_01'")
      .get() as { current_revision_id: string }
    const rows = readManifest(db, current.current_revision_id)
    expect(rows).toHaveLength(2)
    const hash = db
      .prepare('SELECT content_hash FROM revision WHERE id = ?')
      .get(current.current_revision_id) as { content_hash: string }
    expect(hashRows(rows)).toBe(hash.content_hash)

    const pending = db
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE chapter_id = 'ch_slice_01' AND published_at IS NULL")
      .get() as { count: number }
    expect(pending.count).toBe(0)

    const interrupted = db
      .prepare("SELECT COUNT(*) AS count FROM job WHERE status = 'interrupted'")
      .get() as { count: number }
    expect(interrupted.count).toBeGreaterThanOrEqual(1)
  } finally {
    db.close()
  }
})
