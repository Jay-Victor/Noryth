import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * E2E-M1-TIME-01（PHASE-12 §6）：三章，第 3 章标闪回且故事时间早于第 1 章。
 *
 * 未打包构建 + 假模型（写作 + 审批）：
 *   devSeed（3 章各 1 场 2 拍）→ 第 1、3 章 G2 + 自动跑完 → 第 1 章故事时间「民国二十三年」，
 *   第 3 章标「闪回 · 民国二十年 冬」→ T23 三轴分开返回（idx/故事时间/时间轴）
 *   → 审批第 3 章：报告不出现时间线阻断（闪回不被判成时间线矛盾）。
 *
 * E2E-M1-SCENE-01：第 1 章演出过的场景在第 2 章是只读引用；直接链接被拒（要求 fork），
 *   fork 之后第 2 章可写，第 1 章 revision 与正文不变。
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
        title: '黑漆匣子 · 时间三轴',
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
  // IPC 直调绕过 store；重载让创作台读到物化后的状态（草案里已有 scene_id）。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
}

async function openChapter(page: Page, chapterId: string): Promise<void> {
  const row = page.locator(`[data-testid="write-chapter-${chapterId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.locator('[data-testid="write-chapter-list"]')).toBeVisible()
  await expect(row).toHaveClass(/is-active/)
}

test.afterAll(() => {
  for (const app of apps) void app.close().catch(() => undefined)
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上偶发占用；临时目录可以留给系统清理。
    }
  }
})

test('E2E-M1-TIME-01：闪回不被判成时间线矛盾，T23 三轴分开', async () => {
  const userData = makeTemp('noryth-time-user-')
  const parent = makeTemp('noryth-time-proj-')
  const { page } = await launch(userData)
  const { path } = await createProject(page, parent, 'time')
  const { chapterIds } = await seed(page, {
    chapters: 3,
    seedEveryChapter: true,
    scenes: 1,
    beatsPerScene: 2,
    exit: 'beats(2)'
  })
  const [chapterOne, , chapterThree] = chapterIds
  expect(chapterIds).toHaveLength(3)

  await performChapter(page, chapterOne!)
  await performChapter(page, chapterThree!)

  // 第 1 章：故事时间「民国二十三年 三月初七 夜」。
  await openChapter(page, chapterOne!)
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  const startOne = page.locator('[data-testid="write-scene-story-start-1"]')
  await startOne.fill('民国二十三年 三月初七 夜')
  await startOne.press('Enter')
  await expect(page.locator('[data-testid="write-scene-timeline-1"]')).toHaveValue('main')
  await expect(startOne).toHaveValue('民国二十三年 三月初七 夜')

  // 第 3 章：整章闪回，故事时间早于第 1 章。
  await openChapter(page, chapterThree!)
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="write-scene-timeline-1"]').selectOption('flashback')
  const startThree = page.locator('[data-testid="write-scene-story-start-1"]')
  await startThree.fill('民国二十年 冬')
  await startThree.press('Enter')
  await expect(page.locator('[data-testid="write-scene-timeline-badge-1"]')).toContainText('闪回')
  await expect(startThree).toHaveValue('民国二十年 冬')

  // T23：三轴分开返回，闪回只换标签。
  const t1 = await page.evaluate(async (id) => window.noryth!.write.timeline(id), chapterOne!)
  const t3 = await page.evaluate(async (id) => window.noryth!.write.timeline(id), chapterThree!)
  expect(t1.ok).toBe(true)
  expect(t3.ok).toBe(true)
  if (!t1.ok || !t3.ok) throw new Error('timeline query failed')

  expect(t1.data.idx).toBe(1)
  expect(t3.data.idx).toBe(3)
  expect(t1.data.storyStart).toBe('民国二十三年 三月初七 夜')
  expect(t3.data.storyStart).toBeNull() // 章内没有 main 场景
  expect(t3.data.scenes).toHaveLength(1)
  expect(t3.data.scenes[0]!.timeline).toBe('flashback')
  expect(t3.data.scenes[0]!.storyStart).toBe('民国二十年 冬')
  expect(t3.data.timeline).toHaveLength(2)
  expect(t3.data.timeline.every((row) => row.timeline === 'flashback')).toBe(true)
  expect(t3.data.timeline.every((row) => row.storyTime === '民国二十年 冬')).toBe(true)
  expect(t1.data.timeline.every((row) => row.storyTime === '民国二十三年 三月初七 夜')).toBe(true)
  // 叙事序（seq）仍按章递增：闪回不参与先后判定。
  expect(Math.min(...t3.data.timeline.map((row) => row.seq))).toBeGreaterThan(
    Math.max(...t1.data.timeline.map((row) => row.seq))
  )

  // 审批第 3 章：报告里没有时间线阻断或 timeline issue。
  const review = await page.evaluate(async (id) => window.noryth!.review.run(id), chapterThree!)
  expect(review.ok).toBe(true)
  if (!review.ok) throw new Error(review.error.code)
  const state = review.data.state
  expect(state.hasReport).toBe(true)
  expect(state.report).not.toBeNull()
  const issues = [...(state.report?.blocking ?? []), ...(state.report?.suggestions ?? [])]
  // Issue 的类别字段是 type（timeline / continuity / ...）；闪回不应产生 timeline 类阻断。
  expect(issues.filter((issue) => issue.type === 'timeline')).toHaveLength(0)

  // DB 兜底：scene 的三轴真的落盘，且没有跨章拍。
  const db = new Database(join(path, 'noryth.db'), { readonly: true })
  try {
    const scenes = db.prepare('SELECT timeline, story_start FROM scene ORDER BY ord').all() as Array<{
      timeline: string
      story_start: string | null
    }>
    expect(scenes.filter((row) => row.timeline === 'flashback')).toHaveLength(1)
    expect(scenes.filter((row) => row.timeline === 'main')).toHaveLength(1)
    expect(scenes).toHaveLength(2) // 只有第 1、3 章开演；第 2 章停在分镜草案
    const cross = db
      .prepare(
        `SELECT scene_id, COUNT(DISTINCT chapter_id) AS chapters FROM beat
         WHERE status <> 'superseded' GROUP BY scene_id HAVING COUNT(DISTINCT chapter_id) > 1`
      )
      .all() as Array<{ scene_id: string }>
    expect(cross).toHaveLength(0)
  } finally {
    db.close()
  }
})

test('E2E-M1-SCENE-01：引用场只读，链接被拒，fork 后新章可写', async () => {
  const userData = makeTemp('noryth-scene-user-')
  const parent = makeTemp('noryth-scene-proj-')
  const { page } = await launch(userData)
  await createProject(page, parent, 'scenes')
  const { chapterIds } = await seed(page, { chapters: 2, scenes: 1, beatsPerScene: 2, exit: 'beats(2)' })
  const [chapterOne, chapterTwo] = chapterIds

  await performChapter(page, chapterOne!)
  const before = await page.evaluate(async (id) => window.noryth!.write.state(id), chapterOne!)
  expect(before.ok).toBe(true)
  if (!before.ok) throw new Error('state failed')
  const sourceScene = before.data.scenes[0]!
  const sourceRevision = before.data.revisionId
  const sourceBody = sourceScene.beats.map((beat) => beat.body).join('\n')

  // 第 2 章：场景库把这场标成「第 1 章演出」，直接链接被拒并要求 fork。
  await openChapter(page, chapterTwo!)
  await page.locator('[data-testid="write-tab-storyboard"]').click()
  await page.locator('[data-testid="scene-library-toggle"]').click()
  await expect(page.locator(`[data-testid="scene-library-item-${sourceScene.id}"]`)).toContainText('第 1 章演出')
  await expect(page.locator(`[data-testid="scene-fork-${sourceScene.id}"]`)).toBeVisible()

  const link = await page.evaluate(
    async ({ chapterId, sceneId }) => window.noryth!.write.linkScene({ chapterId, sceneId }),
    { chapterId: chapterTwo!, sceneId: sourceScene.id }
  )
  expect(link.ok).toBe(false)
  if (!link.ok) {
    expect(link.error.code).toBe('invalid_args')
    // 作者文案统一走 ERROR_MESSAGES（「参数不合法」），机器可读细节在 details。
    expect((link.error.details as { needsFork?: boolean } | undefined)?.needsFork).toBe(true)
  }

  // fork：新场景带着 2 拍进入第 2 章。
  await page.locator(`[data-testid="scene-fork-${sourceScene.id}"]`).click()
  await expect(page.locator('[data-testid="write-storyboard-summary"]')).toContainText('1 场')
  const after = await page.evaluate(async (id) => window.noryth!.write.state(id), chapterTwo!)
  expect(after.ok).toBe(true)
  if (!after.ok) throw new Error('state failed')
  expect(after.data.scenes).toHaveLength(1)
  const forked = after.data.scenes[0]!
  expect(forked.id).not.toBe(sourceScene.id)
  expect(forked.referenceChapterOrd).toBeNull()
  expect(forked.beats).toHaveLength(2)
  expect(forked.beats.every((beat) => beat.status === 'waiting_for_human')).toBe(true)
  expect(forked.beats.map((beat) => beat.body).join('\n')).toBe(sourceBody)

  // 第 2 章可写；第 1 章 revision 与正文一字不变。
  const confirm = await page.evaluate(async (beatId) => window.noryth!.write.confirm(beatId), forked.beats[0]!.id)
  expect(confirm.ok).toBe(true)
  const again = await page.evaluate(async (id) => window.noryth!.write.state(id), chapterOne!)
  expect(again.ok).toBe(true)
  if (!again.ok) throw new Error('state failed')
  expect(again.data.revisionId).toBe(sourceRevision)
  expect(again.data.scenes[0]!.beats.map((beat) => beat.body).join('\n')).toBe(sourceBody)
})
