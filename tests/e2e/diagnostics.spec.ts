import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

test('设置页导出诊断包：文件可读、不含 Key 与正文', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'noryth-e2e-diag-'))
  const { app, page } = await launch(userData)
  try {
    await page.locator('[data-nav="settings"]').click()
    await page.getByRole('button', { name: '导出诊断包' }).click()
    const toast = page.locator('.toast').filter({ hasText: '诊断包已导出' })
    await expect(toast).toBeVisible()
    const detail = await toast.locator('span').innerText()
    const file = detail.trim()
    expect(existsSync(file)).toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('"schemaVersion": 1')
    expect(content).not.toContain('sk-abcdefghijklmnop')
    expect(content).not.toContain('她把茶盏')
  } finally {
    await app.close()
  }
})
