import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { unzip } from '../support/unzip'

/**
 * 诊断包（PHASE-11 M1-24）：
 * zip 可解压、含 README + 摘要 + 日志、全文扫描无 Key 与正文。
 *
 * 走 `bridge.diagnostics.export({ path })` 而不是点按钮：正常路径会弹系统保存对话框，
 * Playwright 无法关闭原生对话框。按钮本身只断言存在（设置页）。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []

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
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

test.afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用
    }
  }
})

test('诊断包 zip：可解压、无 Key、无正文（PHASE-11 M1-24）', async () => {
  test.setTimeout(180_000)
  const userData = makeTemp('noryth-e2e-diag-user-')
  const parent = makeTemp('noryth-e2e-diag-project-')
  const { app, page } = await launch(userData)
  try {
    const created = await page.evaluate(
      async (parentDir) =>
        window.noryth!.project.create({
          parentDir,
          folderName: '诊断项目',
          title: '黑漆匣子',
          genre: '悬疑',
          targetWords: 100_000,
          pov: 'third_limited',
          boundaries: ''
        }),
      parent
    )
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.code)

    // 造真实正文：devSeed → G2 → 生成一拍（假适配器）
    await page.evaluate(() => window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 2 }))
    await page.reload()
    await page.waitForSelector('[data-testid="app-ready"]')
    const chapterId = await page.evaluate(async () => {
      const state = await window.noryth!.write.state()
      return state.ok ? state.data.chapterId : null
    })
    expect(chapterId).toBeTruthy()
    await page.evaluate(async (id) => window.noryth!.write.confirmG2(id!), chapterId)
    const beatId = await page.evaluate(async () => {
      const state = await window.noryth!.write.state()
      return state.ok ? (state.data.scenes[0]?.beats[0]?.id ?? null) : null
    })
    expect(beatId).toBeTruthy()
    const generated = await page.evaluate(async (id) => window.noryth!.write.generate(id!), beatId)
    expect(generated.ok).toBe(true)

    const db = new Database(join(created.data.path, 'noryth.db'), { readonly: true })
    let bodySample = ''
    try {
      const row = db
        .prepare("SELECT body FROM beat WHERE status <> 'superseded' AND length(body) > 0 LIMIT 1")
        .get() as { body: string } | undefined
      expect(row?.body.length ?? 0).toBeGreaterThan(10)
      bodySample = (row?.body ?? '').slice(0, 16)
    } finally {
      db.close()
    }

    const info = await page.evaluate(() => window.noryth!.app.info())
    const schemaVersion = info.ok ? info.data.schemaVersion : 0

    // 设置页按钮存在（正常路径会弹保存对话框）
    await page.locator('[data-nav="settings"]').click()
    await expect(page.getByRole('button', { name: '导出诊断包' })).toBeVisible()
    await expect(page.locator('[data-testid="open-last-project"]')).toBeVisible()

    const target = join(userData, 'export', 'noryth-diagnostics-e2e.zip')
    const exported = await page.evaluate(async (path) => window.noryth!.diagnostics.export({ path }), target)
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error(exported.error.code)
    expect(exported.data.cancelled).toBe(false)
    expect(exported.data.path).toBe(target)
    expect(existsSync(target)).toBe(true)

    const bytes = readFileSync(target)
    // 解压：条目名与 CRC 都校验
    const entries = unzip(bytes)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('README.txt')
    expect(names).toContain('diagnostics.json')
    expect(names).toContain('logs/app.log')
    expect(names).not.toContain('secrets.bin')
    expect(names.some((name) => name.startsWith('exports/'))).toBe(false)

    const text = Buffer.concat(entries.map((entry) => entry.data)).toString('utf8')
    expect(text).toContain(`"schemaVersion": ${schemaVersion}`)
    expect(text).toContain('黑漆匣子')
    // 全文扫描：无 Key 形态、无正文片段
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/)
    expect(text).not.toContain(bodySample)
  } finally {
    await app.close()
  }
})

