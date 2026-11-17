import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { unzip } from '../support/unzip'

/**
 * E2E-M1-DOCX-01（PHASE-17 §6）。
 *
 * 未打包构建 + 假模型：devSeed 3 章（每章 1 场 2 拍）→ 逐章 G2、生成并确认第一拍 →
 * 创作台「导出」对话框导出全书 DOCX → 文件落在项目 exports/ → 解压 word/document.xml
 * 含所有章标题与每章首段、标「草稿」（未定稿章）→ 无 Key / 日志 / secrets 字符串。
 * 再直接调两次 manuscript.export：同一天同一清单 sha256 相同（zip 时间戳归一）、
 * 且导出不产生 revision。
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
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_WRITE_API_KEY

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
        title: '黑漆匣子 · 导出',
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

function revisionCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS count FROM revision').get() as { count: number }).count
  } finally {
    db.close()
  }
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

test('E2E-M1-DOCX-01：3 章导出 DOCX，XML 含章标题与首段，只读可复现', async () => {
  test.setTimeout(300_000)
  const userData = makeTemp('noryth-export-user-')
  const parent = makeTemp('noryth-export-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent, 'DOCX 导出')

  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({ chapters: 3, seedEveryChapter: true, scenes: 1, beatsPerScene: 2 })
  )
  expect(seeded.ok).toBe(true)

  // 每章：G2 → 生成第一拍 → 确认（产生带正文的 draft revision）
  const chapters = await page.evaluate(async () => {
    const state = await window.noryth!.write.state()
    if (!state.ok) return []
    return state.data.chapters.map((chapter) => ({ id: chapter.id, ord: chapter.ord, title: chapter.title }))
  })
  expect(chapters).toHaveLength(3)

  for (const chapter of chapters) {
    const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapter.id)
    expect(g2.ok).toBe(true)
    const beatId = await page.evaluate(async (id) => {
      const state = await window.noryth!.write.state(id)
      return state.ok ? (state.data.scenes.flatMap((scene) => scene.beats)[0]?.id ?? null) : null
    }, chapter.id)
    expect(beatId).toBeTruthy()
    const generated = await page.evaluate(async (id) => window.noryth!.write.generate(id!), beatId)
    expect(generated.ok).toBe(true)

    // 生成是后台任务：等这一拍落到 draft / waiting_for_human 再确认。
    // 注意：确认/生成会把槽位换成新的拍 id（supersede），所以用状态找现行拍，不沿用旧 id。
    const ready = await page.evaluate(
      async ({ chapterId }) => {
        for (let index = 0; index < 200; index += 1) {
          const state = await window.noryth!.write.state(chapterId)
          if (state.ok) {
            const beat = state.data.scenes
              .flatMap((scene) => scene.beats)
              .find((item) => item.status === 'draft' || item.status === 'waiting_for_human')
            if (beat) return { status: beat.status, beatId: beat.id }
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const state = await window.noryth!.write.state(chapterId)
        return {
          status: 'timeout',
          beatId: '',
          detail: JSON.stringify({
            chapterStatus: state.ok ? state.data.chapterStatus : 'state_error',
            running: state.ok ? state.data.running : null,
            pauseReason: state.ok ? state.data.pauseReason : null,
            beats: state.ok
              ? state.data.scenes.flatMap((scene) => scene.beats).map((beat) => `${beat.id}:${beat.status}`)
              : []
          })
        }
      },
      { chapterId: chapter.id }
    )
    expect(ready.status, `章 ${chapter.ord} 未落 draft：${JSON.stringify(ready)}`).toMatch(/^(draft|waiting_for_human)$/)
    const confirmed = await page.evaluate(async (id) => window.noryth!.write.confirm(id!), ready.beatId)
    expect(confirmed.ok, confirmed.ok ? '' : JSON.stringify(confirmed.error)).toBe(true)
  }

  const bodyByChapter = await page.evaluate(async (ids: string[]) => {
    const result: Record<string, string> = {}
    for (const id of ids) {
      const state = await window.noryth!.write.state(id)
      if (!state.ok) continue
      const body = state.data.scenes.flatMap((scene) => scene.beats).find((beat) => beat.body.trim().length > 0)
      if (body) result[id] = body.body
    }
    return result
  }, chapters.map((chapter) => chapter.id))

  const dbPath = join(project.path, 'noryth.db')
  const revisionsBefore = revisionCount(dbPath)

  // ── UI：创作台「导出」对话框（默认 DOCX / 全书）─────────────────────────
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="write-export-open"]').click()
  await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()
  await expect(page.locator('[data-testid="export-filename"]')).toContainText('exports/')
  await page.locator('[data-testid="export-author"]').fill('沈昼')
  await page.locator('[data-testid="export-run"]').click()
  await expect(page.locator('.toast').filter({ hasText: '已导出 3 章' })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="export-dialog"]')).toHaveCount(0)

  const files = readdirSync(join(project.path, 'exports')).filter((name) => name.endsWith('.docx'))
  expect(files.length).toBeGreaterThan(0)
  const docxPath = join(project.path, 'exports', files[files.length - 1]!)
  const entries = unzip(readFileSync(docxPath))
  expect(entries.map((entry) => entry.name)).toContain('word/document.xml')
  const documentXml = entries.find((entry) => entry.name === 'word/document.xml')!.data.toString('utf8')
  const text = [...documentXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1] ?? '').join('')
  const coreXml = entries.find((entry) => entry.name === 'docProps/core.xml')!.data.toString('utf8')

  expect(text).toContain('黑漆匣子 · 导出')
  expect(text).toContain('沈昼')
  expect(text).toContain('目录')
  for (const chapter of chapters) {
    expect(text).toContain(chapter.title)
    const body = bodyByChapter[chapter.id]
    expect(body).toBeTruthy()
    expect(text).toContain(body!.trim())
  }
  // 未定稿章不冒充定稿
  expect(text).toContain('草稿 · 尚未定稿')
  // 文件属性带 revision（导出可核对版本）
  expect(coreXml).toMatch(/rev_/)
  // 不泄漏 Key / 日志 / 机密文件
  const allEntries = entries.map((entry) => entry.data.toString('utf8')).join('\n')
  expect(allEntries).not.toMatch(/sk-[A-Za-z0-9]/)
  expect(allEntries).not.toContain('secrets.bin')
  expect(allEntries).not.toContain('[INFO]')

  // ── 只读 + 可复现：两次直接导出 sha256 相同，revision 数不变 ──────────────
  const first = await page.evaluate(async () => window.noryth!.manuscript.export({ format: 'docx', toc: true }))
  const second = await page.evaluate(async () => window.noryth!.manuscript.export({ format: 'docx', toc: true }))
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  if (first.ok && second.ok) {
    expect(first.data.sha256).toBe(second.data.sha256)
    expect(first.data.path).not.toBe(second.data.path)
    expect(first.data.chapters).toBe(3)
    expect(first.data.drafts).toBe(3)
    expect(readFileSync(first.data.path).equals(readFileSync(second.data.path))).toBe(true)
    expect(first.data.path.startsWith(join(project.path, 'exports'))).toBe(true)
  }
  expect(revisionCount(dbPath)).toBe(revisionsBefore)
})
