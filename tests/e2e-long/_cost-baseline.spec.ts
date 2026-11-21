import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { listChapters, runChapter } from '../e2e/m1-flow'

/**
 * 临时夹具：为 `docs/M2-COST-BASELINE.md` 生成 30 章项目（5 角色）。
 * 不进入提交门；跑法：
 *   pnpm build && NORYTH_E2E_KEEP=1 pnpm exec playwright test \
 *     --config playwright.m1a.config.ts tests/e2e-long/_cost-baseline.spec.ts
 * 结束后用打印出的项目路径跑 `node scripts/m2-cost-baseline.mjs <path>`。
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

test.afterAll(async () => {
  for (const app of apps) {
    try {
      await app.close()
    } catch {
      // 已退出
    }
  }
  if (process.env.NORYTH_E2E_KEEP === '1') {
    console.warn(`COST-BASELINE kept temp dirs: ${tempDirs.join(' ; ')}`)
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

test('成本基线夹具：30 章 / 3 卷 / 5 角色', async () => {
  test.skip(process.env.NORYTH_COST_BASELINE !== '1', '基线夹具：仅在 NORYTH_COST_BASELINE=1 时生成')
  test.setTimeout(3_600_000)
  const userData = makeTemp('noryth-cost-baseline-user-')
  const parent = makeTemp('noryth-cost-baseline-project-')
  const { page } = await launch(userData)

  const created = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 成本基线',
        genre: '悬疑',
        targetWords: 600_000,
        pov: 'third_limited',
        boundaries: ''
      }),
    { parentDir: parent, name: '成本基线' }
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')

  const seeded = await page.evaluate(async () =>
    window.noryth!.write.devSeed({
      volumes: 3,
      chaptersPerVolume: 10,
      scenes: 3,
      beatsPerScene: 6,
      seedEveryChapter: true,
      characters: 5
    })
  )
  expect(seeded.ok).toBe(true)

  const chapters = await listChapters(page)
  expect(chapters).toHaveLength(30)
  for (const chapter of chapters) {
    await runChapter(page, chapter)
  }
  // eslint-disable-next-line no-console
  console.log(`COST-BASELINE project: ${created.data.path}`)
})
