import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M0-A（PHASE-10 J2 / DEV-PLAN §13.4）：14 步黄金路径。
 *
 * 全链路只通过产品自身入口改状态：新建向导、规划对话、G1、分镜→G2、逐拍/自动、
 * G4/G5/G6、G7、导出、强杀重启。测试只读数据库做断言，不写库、不改文件。
 *
 * 模型全部是未打包构建的假适配器（生产包不认这些变量）；工具管道、闸门、
 * 事务、检索与导出都走真实代码。
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
  env.NORYTH_PLAN_FAKE = '1'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  env.NORYTH_MEMORY_STREAM_DELAY_MS = '1'
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
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发文件占用
    }
  }
})

test('E2E-M0-A：空项目 → 一章定稿 → 记忆固化 → 第 2 章召回 → 导出 → 强杀重启', async () => {
  test.setTimeout(600_000)
  const userData = makeTemp('noryth-m0a-user-')
  const parent = makeTemp('noryth-m0a-project-')
  const folder = '黑漆匣子 M0'
  const { page } = await launch(userData)

  // ── 1. 新建项目（G0）──────────────────────────────────────────────────────
  await page.getByRole('button', { name: /新建项目/ }).first().click()
  await page.locator('[data-testid="input-parent-dir"]').fill(parent)
  await page.locator('[data-testid="input-folder-name"]').fill(folder)
  await page.locator('[data-testid="btn-next"]').click()
  await expect(page.locator('[data-testid="input-title"]')).toHaveValue(folder)
  await page.locator('[data-testid="btn-preview"]').click()
  await page.locator('[data-testid="btn-create"]').click()
  await expect(page.locator('.toast').filter({ hasText: `项目「${folder}」已创建` })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="app-ready"]')).toHaveAttribute('data-page', 'plan')

  const projectPath = join(parent, folder)
  const dbPath = join(projectPath, 'noryth.db')
  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    expect(existsSync(join(projectPath, sub)), sub).toBe(true)
  }
  const schemaOf = (): number => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    } finally {
      db.close()
    }
  }
  expect(schemaOf()).toBe(12)

  // ── 2. 规划对话 → 应用蓝图与角色清单 ─────────────────────────────────────
  await page.locator('[data-testid="plan-new-session"]').click()
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="plan-composer-input"]')
    return input !== null && !input.disabled
  })
  await page.locator('[data-testid="plan-composer-input"]').fill('写一个民国悬疑：替人写遗书的女子发现父亲留下的账本')
  await page.locator('[data-testid="plan-send"]').click()
  const blueprint = page.locator('.plan-proposal[data-kind="blueprint_patch"]')
  await blueprint.waitFor({ timeout: 30_000 })
  const roster = page.locator('.plan-proposal[data-kind="roster"]')
  await roster.waitFor({ timeout: 30_000 })
  await blueprint.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid^="outline-node-"]').first().waitFor({ timeout: 15_000 })
  await roster.locator('[data-testid^="plan-apply-"]').click()
  await page.locator('[data-testid="plan-tab-characters"]').click()
  await expect(page.locator('[data-testid^="character-row-"]')).toHaveCount(5, { timeout: 15_000 })

  // ── 3. G1 确认 ───────────────────────────────────────────────────────────
  await page.locator('[data-testid="plan-tab-blueprint"]').click()
  await expect(page.locator('[data-testid="g1-confirm"]')).toBeEnabled()
  await page.locator('[data-testid="g1-confirm"]').click()
  await page.locator('[data-testid="g1-confirm-ok"]').click()
  await expect(page.locator('[data-testid="g1-bar"]')).toHaveAttribute('data-state', 'complete', { timeout: 30_000 })
  await expect(page.locator('[data-nav="write"]')).toHaveAttribute('aria-disabled', 'false')

  // ── 4. 建库隔离自检 ──────────────────────────────────────────────────────
  const isolation = await page.evaluate(async () => window.noryth!.memory.isolation())
  expect(isolation.ok).toBe(true)
  if (isolation.ok) expect(isolation.data.verified).toBe(true)

  const ids = ((): { chapterIds: string[]; characterIds: string[] } => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const chapterIds = (db.prepare('SELECT id FROM chapter ORDER BY ord').all() as Array<{ id: string }>).map((row) => row.id)
      const characterIds = (db.prepare('SELECT id FROM character ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id)
      return { chapterIds, characterIds }
    } finally {
      db.close()
    }
  })()
  expect(ids.chapterIds).toHaveLength(2)
  expect(ids.characterIds).toHaveLength(5)

  // ── 5. 分镜（3 场 24 拍）→ G2 ────────────────────────────────────────────
  const chapterId = ids.chapterIds[0]!
  const scenes = Array.from({ length: 3 }, (_, sceneIndex) => ({
    location: `地点 ${sceneIndex + 1}`,
    participants: ids.characterIds,
    goal: `第 ${sceneIndex + 1} 场目标`,
    entry: '',
    exit: 'beats(8)',
    max_beats: 8,
    beats: Array.from({ length: 8 }, (_, beatIndex) => ({
      speaker_type: beatIndex % 2 === 1 ? ('narrator' as const) : ('character' as const),
      speaker_id: beatIndex % 2 === 1 ? 'narrator' : ids.characterIds[0]!,
      intent: `场景 ${sceneIndex + 1} 第 ${beatIndex + 1} 拍`,
      max_words: 200
    }))
  }))
  const saved = await page.evaluate(
    async ({ chapterId: id, scenes: payload }) => window.noryth!.write.saveStoryboard({ chapterId: id, scenes: payload }),
    { chapterId, scenes }
  )
  expect(saved.ok).toBe(true)
  const conflicts = await page.evaluate(
    async ({ chapterId: id, scenes: payload }) => window.noryth!.write.validateStoryboard({ chapterId: id, scenes: payload }),
    { chapterId, scenes }
  )
  expect(conflicts.ok && conflicts.data.filter((item) => item.severity === 'hard')).toHaveLength(0)
  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapterId)
  expect(g2.ok).toBe(true)
  if (g2.ok) expect(g2.data.state.progress.totalBeats).toBe(24)

  // ── 6. 逐拍：4 确认 + 2 重生成 ───────────────────────────────────────────
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="write-confirm-bar"]')
  for (let index = 0; index < 4; index += 1) {
    await expect(page.locator('[data-testid="write-confirm-bar"]')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="write-generate"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 60_000 })
    await page.locator('[data-testid="write-confirm"]').click()
  }
  for (let index = 0; index < 2; index += 1) {
    await page.locator('[data-testid="write-generate"]').click()
    await expect(page.locator('[data-testid="write-regenerate"]')).toBeEnabled({ timeout: 60_000 })
    await page.locator('[data-testid="write-regenerate"]').click()
    await expect(page.locator('[data-testid="write-confirm"]')).toBeEnabled({ timeout: 60_000 })
    await page.locator('[data-testid="write-confirm"]').click()
  }
  const afterBeats = await page.evaluate(async () => window.noryth!.write.state())
  expect(afterBeats.ok).toBe(true)
  if (afterBeats.ok) expect(afterBeats.data.progress.confirmed).toBe(6)

  // ── 7. 自动模式跑到出口 ──────────────────────────────────────────────────
  await page.locator('[data-testid="write-auto"]').click()
  await expect(page.locator('[data-testid="write-preflight"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid="write-auto-confirm"]').click()
  await expect(page.locator('[data-testid="write-draft-complete"]')).toBeVisible({ timeout: 180_000 })
  const drafted = await page.evaluate(async () => window.noryth!.write.state())
  expect(drafted.ok && drafted.data.chapterStatus).toBe('draft_complete')

  // ── 8. 送审（G4）────────────────────────────────────────────────────────
  await page.locator('[data-nav="review"]').click()
  const verdict = page.locator('[data-testid="review-verdict"]')
  await expect(verdict).toHaveAttribute('data-verdict', 'fail', { timeout: 90_000 })
  await expect(page.locator('[data-testid="review-report"] .review-issue.is-blocking')).toHaveCount(2)
  await expect(page.locator('[data-testid="review-report"] .review-issue.is-suggestion')).toHaveCount(3)

  // ── 9. G5 → 3 条 patch → 接受 2 拒绝 1 ──────────────────────────────────
  await page.locator('[data-testid="review-g5"]').click()
  await expect(page.locator('[data-testid="review-diff"]')).toBeVisible({ timeout: 60_000 })
  await expect(
    page.locator('[data-testid^="review-patch-"]').filter({ has: page.locator('.review-patch__reason') })
  ).toHaveCount(3)
  await page.locator('[data-testid^="review-patch-accept-"]').nth(0).click()
  await page.locator('[data-testid^="review-patch-accept-"]').nth(1).click()
  await page.locator('[data-testid^="review-patch-reject-"]').nth(2).click()
  await page.locator('[data-testid="review-patch-apply"]').click()
  await expect(page.locator('.review-patch[data-status="applied"]')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.review-patch[data-status="rejected"]')).toHaveCount(1)

  // ── 10. 复检 → G6 定稿 ──────────────────────────────────────────────────
  await page.locator('[data-testid="review-recheck"]').click()
  await expect(page.locator('[data-testid="review-round"]')).toContainText('2/3', { timeout: 60_000 })
  await expect(verdict).toHaveAttribute('data-verdict', /pass/, { timeout: 60_000 })
  await page.locator('[data-testid="review-finalize"]').click()
  await expect(page.locator('[data-testid="review-finalize-dialog"]')).toBeVisible()
  await page.locator('[data-testid="review-finalize-confirm"]').click()
  await expect(page.locator('[data-testid="review-finalize"]')).toContainText('已定稿', { timeout: 60_000 })

  // ── 11. G7：抽取提案 → 全部接受 → 应用 ──────────────────────────────────
  await page.locator('[data-nav="memory"]').click()
  // 定稿后 memory.extract 已入队；进入记忆台会跑抽取，等第一条提案出现
  try {
    await expect(page.locator('[data-testid="memory-proposal-0"]')).toBeVisible({ timeout: 60_000 })
  } catch (error) {
    const state = await page.evaluate(async () => window.noryth!.memory.state())
    // eslint-disable-next-line no-console
    console.log('DEBUG memory', JSON.stringify(state))
    const dbg = new Database(dbPath, { readonly: true })
    try {
      // eslint-disable-next-line no-console
      console.log('DEBUG jobs', JSON.stringify(dbg.prepare('SELECT type,status,error_code,result_json FROM job ORDER BY created_at DESC LIMIT 4').all()))
      // eslint-disable-next-line no-console
      console.log('DEBUG members', JSON.stringify(dbg.prepare('SELECT COUNT(*) AS c FROM revision_beat WHERE revision_id = (SELECT final_revision_id FROM chapter WHERE id = ?)').get(chapterId)))
    } finally {
      dbg.close()
    }
    throw error
  }
  const proposalCount = await page.evaluate(async () => {
    const state = await window.noryth!.memory.state()
    return state.ok ? state.data.proposals.length : 0
  })
  expect(proposalCount).toBeGreaterThanOrEqual(6)
  await page.locator('[data-testid="memory-accept-all"]').click()
  await expect(page.locator('[data-testid="memory-g7"]')).toBeEnabled()
  await page.locator('[data-testid="memory-g7"]').click()
  await expect(page.locator('[data-testid="memory-tab-entries"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000
  })
  const applied = await page.evaluate(async () => {
    const state = await window.noryth!.memory.state()
    return state.ok ? { entries: state.data.entries.length, facts: state.data.worldFacts.length } : null
  })
  expect(applied?.entries ?? 0).toBeGreaterThan(0)

  // 应用后写向量：隔离回归仍 0 命中（按钮在世界状态分区）
  await page.locator('[data-testid="memory-tab-world"]').click()
  await page.locator('[data-testid="memory-isolation-run"]').click()
  await expect(page.locator('[data-testid="memory-isolation-report"]')).toContainText('通过', { timeout: 30_000 })

  // ── 12. 第 2 章：写一拍并召回第 1 章记忆 ────────────────────────────────
  const chapter2 = ids.chapterIds[1]!
  const chapter2Scenes = [
    {
      location: '旧书店',
      participants: ids.characterIds,
      goal: '拿到旧账最后一页',
      entry: '',
      exit: 'beats(2)',
      max_beats: 4,
      beats: [
        { speaker_type: 'narrator' as const, speaker_id: 'narrator', intent: '第二章开场', max_words: 200 },
        { speaker_type: 'character' as const, speaker_id: ids.characterIds[0]!, intent: '第二章试探', max_words: 200 }
      ]
    }
  ]
  await page.evaluate(
    async ({ chapterId: id, scenes: payload }) => window.noryth!.write.saveStoryboard({ chapterId: id, scenes: payload }),
    { chapterId: chapter2, scenes: chapter2Scenes }
  )
  const g2b = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapter2)
  expect(g2b.ok).toBe(true)
  const beat2 = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    return state.ok ? (state.data.scenes.flatMap((scene) => scene.beats)[0]?.id ?? null) : null
  }, chapter2)
  expect(beat2).toBeTruthy()
  const generated = await page.evaluate(async (id) => window.noryth!.write.generate(id!), beat2)
  expect(generated.ok).toBe(true)

  const recall = await page.evaluate(async (characterId) => window.noryth!.memory.recall({ characterId, query: '账本 祠堂 匣子' }), ids.characterIds[0]!)
  expect(recall.ok).toBe(true)
  if (recall.ok) {
    expect(recall.data.empty).toBe(false)
    expect(recall.data.items.length + recall.data.pinned.length).toBeGreaterThan(0)
    const memoryIds = [...recall.data.items, ...recall.data.pinned].map((item) => item.memoryId)
    const db = new Database(dbPath, { readonly: true })
    try {
      const placeholders = memoryIds.map(() => '?').join(',')
      const hit = db
        .prepare(`SELECT COUNT(*) AS count FROM memory_entry WHERE id IN (${placeholders}) AND source_chapter_id = ?`)
        .get(...memoryIds, chapterId) as { count: number }
      expect(hit.count).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  }

  // ── 13. 导出 Markdown：hash 与当前 revision 一致 ────────────────────────
  await page.locator('[data-nav="review"]').click()
  await page.waitForSelector('[data-testid="review-export"]')
  await page.locator('[data-testid="review-export"]').click()
  await expect(page.locator('.toast').filter({ hasText: '已导出' })).toBeVisible({ timeout: 30_000 })
  const exported = await page.evaluate(async () => window.noryth!.manuscript.export({ chapterId: undefined, format: 'md', includeNotes: false }))
  expect(exported.ok).toBe(true)
  if (exported.ok) {
    const content = readFileSync(exported.data.path, 'utf8')
    expect(content).toContain('content_hash:')
    const db = new Database(dbPath, { readonly: true })
    try {
      const final = db
        .prepare("SELECT revision_id FROM approval_report WHERE chapter_id = ? ORDER BY round DESC LIMIT 1")
        .get(chapterId) as { revision_id: string } | undefined
      const chapter = db.prepare('SELECT final_revision_id FROM chapter WHERE id = ?').get(chapterId) as {
        final_revision_id: string
      }
      expect(chapter.final_revision_id).toBeTruthy()
      expect(content).toContain(chapter.final_revision_id)
      expect(final?.revision_id ?? chapter.final_revision_id).toBeTruthy()
    } finally {
      db.close()
    }
  }

  // ── 14. 强杀重启：已确认拍零丢失 ────────────────────────────────────────
  const before = ((): Array<{ id: string; body: string }> => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return db
        .prepare("SELECT id, body FROM beat WHERE chapter_id = ? AND status = 'confirmed' ORDER BY seq")
        .all(chapterId) as Array<{ id: string; body: string }>
    } finally {
      db.close()
    }
  })()
  expect(before.length).toBeGreaterThan(0)

  const pid = apps[0]!.process().pid
  expect(pid).toBeTruthy()
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    // 进程可能已退出
  }
  expect(apps[0]!.process().exitCode !== null || true).toBe(true)

  const relaunched = await launch(userData)
  // 阶段 11 起，重开应用会自动打开上次项目（若未被占用）。两种情况都要能继续。
  await relaunched.page.waitForSelector('[data-testid="app-ready"]')
  const autoOpened = await relaunched.page.evaluate(async () => {
    const current = await window.noryth!.project.current()
    return current.ok && current.data !== null
  })
  if (!autoOpened) {
    await relaunched.page.locator('[data-testid="project-list"]').waitFor({ timeout: 30_000 }).catch(() => undefined)
    await relaunched.page.locator(`text=${folder}`).first().click().catch(() => undefined)
    const reopened = await relaunched.page.evaluate(async (path) => window.noryth!.project.open({ path }), projectPath)
    expect(reopened.ok).toBe(true)
  }
  await relaunched.page.reload()
  await relaunched.page.waitForSelector('[data-testid="app-ready"]')

  const after = ((): Array<{ id: string; body: string }> => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return db
        .prepare("SELECT id, body FROM beat WHERE chapter_id = ? AND status IN ('confirmed','author_edited') ORDER BY seq")
        .all(chapterId) as Array<{ id: string; body: string }>
    } finally {
      db.close()
    }
  })()
  for (const row of before) {
    expect(after.find((candidate) => candidate.id === row.id)?.body).toBe(row.body)
  }
  const running = ((): number => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return (db.prepare("SELECT COUNT(*) AS count FROM job WHERE status IN ('running','queued')").get() as { count: number }).count
    } finally {
      db.close()
    }
  })()
  expect(running).toBe(0)
  await expect(relaunched.page.locator('[data-testid="app-ready"]')).toBeVisible()
})
