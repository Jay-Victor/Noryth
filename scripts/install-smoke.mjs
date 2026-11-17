// 安装冒烟（PHASE-10 J4）：静默安装 → 启动安装版 → 建项目（跑迁移 + vec0）→ 卸载。
//
// 用法：node scripts/install-smoke.mjs [installer.exe] [installDir]
// 退出码 0 = 通过；非 0 = 失败，并在 stdout 打印原因。
//
// 说明：只在 Windows 上有意义；CI 里按 tag 跑 package job 时手工触发。

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron } from '@playwright/test'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const installer = resolve(process.argv[2] ?? join(ROOT, 'release', `Noryth-${pkg.version}-setup.exe`))
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

/**
 * 列出 asar 内的文件路径（PHASE-17 §6：确认 docx / fflate 随包）。
 * asar 布局：0..3 pickle 头、4..11 尺寸、12..15 JSON 长度、16.. JSON 头。
 */
function asarFilePaths(asarPath) {
  if (!existsSync(asarPath)) return []
  const buffer = readFileSync(asarPath)
  const jsonLength = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  const paths = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`
      if (entry.files) walk(entry, path)
      else paths.push(path)
    }
  }
  walk(header, '')
  return paths
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
  // PHASE-18 M1-25：品牌资源随包（窗口/任务栏图标）。
  for (const icon of ['noryth-16.png', 'noryth-256.png', 'noryth-512.png']) {
    if (!existsSync(join(installDir, 'resources', 'icons', icon))) {
      fail(`安装包缺少 resources/icons/${icon}`)
      return
    }
  }
  // PHASE-14 M1-20：bge 权重随包（q8 / 512 维）
  if (!existsSync(join(installDir, 'resources', 'models', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx'))) {
    fail('安装包缺少 bge 权重（resources/models/bge-small-zh-v1.5/onnx/model_quantized.onnx）')
    return
  }
  // PHASE-17 M1-6：DOCX 依赖随包（纯 JS）。asar 头部是 JSON，直接列路径判断。
  const asarPaths = asarFilePaths(join(installDir, 'resources', 'app.asar'))
  if (!asarPaths.some((path) => path.includes('/docx/dist/index.cjs'))) {
    fail('安装包缺少 docx（DOCX 导出不可用）')
    return
  }
  if (!asarPaths.some((path) => path.includes('/fflate/'))) {
    fail('安装包缺少 fflate（DOCX 可复现归一化依赖）')
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
    if (info.data.schemaVersion < 11) fail(`schemaVersion=${info.data.schemaVersion}，期望 >= 11`)

    // 日志确认嵌入装配走了真模型（不是哈希降级）：source=model + bge 模型名
    const appLog = join(userData, 'logs', 'app.log')
    let embedLine = ''
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (existsSync(appLog)) {
        const text = readFileSync(appLog, 'utf8')
        embedLine =
          text
            .split(/\r?\n/)
            .find((line) => line.includes('embedder_ready') && line.includes('bge-small-zh-v1.5')) ?? ''
        if (embedLine.length > 0) break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (embedLine.length === 0) {
      fail('运行日志里没有 embedder_ready（bge-small-zh-v1.5）')
    } else if (!embedLine.includes('"source":"model"')) {
      fail(`嵌入器没有用真模型：${embedLine.slice(0, 200)}`)
    } else {
      log(`嵌入器：${embedLine.slice(embedLine.indexOf('"model"'), embedLine.indexOf('"dim"') + 12)}`)
    }

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
      if (version.user_version !== info.data.schemaVersion) {
        fail(`安装版迁移版本 ${version.user_version} != ${info.data.schemaVersion}`)
      }
    } finally {
      db.close()
    }
  } finally {
    await app.close()
  }
  // Electron 退出是异步的：给主进程一点时间释放可执行文件，否则卸载器删不掉 Noryth.exe。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))

  log('卸载')
  const uninstaller = join(installDir, 'Uninstall Noryth.exe')
  if (existsSync(uninstaller)) {
    try {
      execFileSync(uninstaller, ['/S', `_?=${installDir}`], { stdio: 'ignore' })
    } catch (error) {
      log(`卸载器返回非 0（可能已自删）：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    fail('找不到卸载器 Uninstall Noryth.exe')
  }
  // NSIS 卸载是异步的：轮询到主程序消失（最多 20s）
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(join(installDir, 'Noryth.exe'))) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
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
