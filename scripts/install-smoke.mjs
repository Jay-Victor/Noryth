// 安装冒烟（PHASE-10 J4）：静默安装 → 启动安装版 → 建项目（跑迁移 + vec0）→ 卸载。
//
// 用法：node scripts/install-smoke.mjs [installer.exe] [installDir]
// 退出码 0 = 通过；非 0 = 失败，并在 stdout 打印原因。
//
// 说明：只在 Windows 上有意义；CI 里按 tag 跑 package job 时手工触发。

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron } from '@playwright/test'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const installer = resolve(process.argv[2] ?? join(ROOT, 'release', 'Noryth-0.1.0-setup.exe'))
const installDir = resolve(process.argv[3] ?? join(tmpdir(), `noryth-install-${Date.now()}`))
const userData = mkdtempSync(join(tmpdir(), 'noryth-install-user-'))
const projectParent = mkdtempSync(join(tmpdir(), 'noryth-install-project-'))

const log = (message) => console.log(`[install-smoke] ${message}`)

function runInstaller(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(installer, args, { stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`installer exit ${code}`))))
    child.on('error', reject)
  })
}

function fail(message) {
  console.error(`[install-smoke] FAIL: ${message}`)
  process.exitCode = 1
}

async function main() {
  if (!existsSync(installer)) {
    fail(`找不到安装包 ${installer}；先跑 pnpm dist`)
    return
  }
  rmSync(installDir, { recursive: true, force: true })

  log(`静默安装到 ${installDir}`)
  // NSIS：/D= 必须是最后一个参数且不加引号
  await runInstaller(['/S', `/D=${installDir}`])
  const exe = join(installDir, 'Noryth.exe')
  if (!existsSync(exe)) {
    fail('安装后找不到 Noryth.exe')
    return
  }
  if (!existsSync(join(installDir, 'resources', 'native', 'vec0.dll'))) {
    fail('安装包缺少 resources/native/vec0.dll')
    return
  }
  if (!existsSync(join(installDir, 'resources', 'models'))) {
    fail('安装包缺少 resources/models（嵌入模型目录）')
    return
  }

  log('启动安装版')
  const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, NORYTH_USER_DATA: userData, NORYTH_SINGLE_INSTANCE: '0' } })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="app-ready"]', { timeout: 60_000 })
    const info = await page.evaluate(async () => window.noryth.app.info())
    if (!info.ok || !info.data.packaged) {
      fail(`app.info 不是打包形态：${JSON.stringify(info)}`)
      return
    }
    log(`app.info：version=${info.data.version} schema=${info.data.schemaVersion} packaged=${info.data.packaged}`)
    if (info.data.schemaVersion !== 7) fail(`schemaVersion=${info.data.schemaVersion}，期望 7`)

    const created = await page.evaluate(
      async ({ parentDir }) =>
        window.noryth.project.create({
          parentDir,
          folderName: '安装冒烟',
          title: '安装冒烟项目',
          genre: '悬疑',
          targetWords: 100_000,
          pov: 'third_limited',
          boundaries: ''
        }),
      { parentDir: projectParent }
    )
    if (!created.ok) {
      fail(`建项目失败：${created.error.code} ${created.error.message}`)
      return
    }
    log(`建项目成功：${created.data.path}`)

    // 真证明 vec0 从安装目录加载：打开项目库并 COUNT 虚拟表
    const dbPath = join(created.data.path, 'noryth.db')
    const db = new Database(dbPath, { readonly: true })
    try {
      db.loadExtension(join(installDir, 'resources', 'native', 'vec0.dll'))
      const vec = db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get()
      const version = db.prepare('PRAGMA user_version').get()
      log(`memory_vec COUNT=${vec.count}；PRAGMA user_version=${version.user_version}`)
      if (version.user_version !== 7) fail(`安装版迁移版本 ${version.user_version} != 7`)
    } finally {
      db.close()
    }
  } finally {
    await app.close()
  }

  log('卸载')
  const uninstaller = join(installDir, 'Uninstall Noryth.exe')
  if (existsSync(uninstaller)) {
    try {
      execFileSync(uninstaller, ['/S'], { stdio: 'ignore' })
    } catch (error) {
      log(`卸载器返回非 0（可能已自删）：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    fail('找不到卸载器 Uninstall Noryth.exe')
  }
  // NSIS 卸载是异步的，给它一点时间
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))
  if (existsSync(join(installDir, 'Noryth.exe'))) {
    fail('卸载后 Noryth.exe 仍在')
  } else {
    log('卸载完成，主程序已移除')
  }

  if (process.exitCode !== 1) log('PASS')
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.stack ?? error.message : String(error))
  })
  .finally(() => {
    for (const dir of [installDir, userData, projectParent]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // Windows 文件占用：留给系统清理
      }
    }
  })
