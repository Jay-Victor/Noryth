// 更新演练（PHASE-18 §5.1 / M1-7）：manifest 完整性 + 打包应用的通道/判定/降级。
//
// 用法：
//   node scripts/update-drill.mjs                     # 需要 release/latest.yml + 安装包 + win-unpacked
//   node scripts/update-drill.mjs --dir <安装目录>     # 用已安装目录（含 Noryth.exe）
//   node scripts/update-drill.mjs --skip-download     # 只检查版本判定，不尝试下载
//
// 做四件事：
//   1. release/latest.yml ↔ 安装包：version / path / sha512 / size 逐项核对；
//   2. 本地起一个 feed（稳定通道根目录），让打包应用手动检查更新；
//   3. 依次切换 manifest：同版本 → up_to_date、更高 → available、更低跨 minor → downgrade_blocked、
//      HTTP 500 → failed（不阻塞）；每次都用 app.info() 复核状态；
//   4. available 时让 electron-updater 真下载（可选），报告 pending 文件或失败日志。
//
// 不做自动安装/重启：那会替换本机应用并需要人工确认；安装 → 重启 → 迁移在
// docs/M1-ACCEPTANCE.md 的「更新演练」里作为人工步骤记录（同一份 feed/manifest 格式）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}
const skipDownload = args.includes('--skip-download')
const installDir = argValue('--dir') ?? join(ROOT, 'release', 'win-unpacked')
const exe = join(installDir, 'Noryth.exe')
const releaseYml = join(ROOT, 'release', 'latest.yml')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const results = []
function record(step, ok, detail) {
  results.push({ step, ok, detail })
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'
  console.log(`[update-drill] ${tag} ${step}: ${detail}`)
}

function fail(message) {
  console.error(`[update-drill] FAIL: ${message}`)
  process.exitCode = 1
}

function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

// ── 1. manifest 完整性 ───────────────────────────────────────────────────────

function verifyManifest() {
  if (!existsSync(releaseYml)) return record('manifest', null, '没有 release/latest.yml（先跑 pnpm dist）')
  const text = readFileSync(releaseYml, 'utf8')
  const version = /^\s*version:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null
  const path = /^\s*path:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null
  const sha512 = /^\s*sha512:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null
  const size = Number(/^\s*size:\s*(\d+)\s*$/m.exec(text)?.[1] ?? NaN)
  if (version !== pkg.version) return fail(`latest.yml version=${version} 与 package.json ${pkg.version} 不一致`)
  if (path === null) return fail('latest.yml 没有 path')
  const artifact = join(ROOT, 'release', path)
  if (!existsSync(artifact)) return fail(`latest.yml 指向的安装包不存在：${artifact}`)
  const actualSha = sha512Base64(artifact)
  if (sha512 !== actualSha) return fail(`latest.yml sha512 与安装包不一致`)
  if (Number.isFinite(size) && size !== readFileSync(artifact).length) return fail('latest.yml size 与安装包不一致')
  return record('manifest', true, `${path} · ${version} · sha512 ok · ${size} B`)
}

// ── 2/3. 本地 feed + 打包应用 ────────────────────────────────────────────────

const feedRoot = mkdtempSync(join(tmpdir(), 'noryth-update-feed-'))
const feedStable = join(feedRoot, 'stable')
mkdirSync(feedStable, { recursive: true })
const installer = join(ROOT, 'release', `Noryth-${pkg.version}-setup.exe`)
const installerBytes = existsSync(installer) ? readFileSync(installer) : null
let mode = 'same'

function manifestFor(nextVersion) {
  if (installerBytes === null) {
    // 没有安装包时只给版本号：应用照样能判定，只是下载一定失败（记为 INFO）。
    return `version: ${nextVersion}\n`
  }
  const url = `Noryth-${nextVersion}-setup.exe`
  return [
    `version: ${nextVersion}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512Base64(installer)}`,
    `    size: ${installerBytes.length}`,
    `path: ${url}`,
    `sha512: ${sha512Base64(installer)}`,
    `releaseDate: '2026-11-17T00:00:00.000Z'`,
    ''
  ].join('\n')
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/stable/latest.yml') {
    if (mode === 'error') {
      response.writeHead(500)
      response.end('boom')
      return
    }
    const version = mode === 'same' ? pkg.version : mode === 'newer' ? '99.0.0' : '0.1.9'
    response.writeHead(200, { 'content-type': 'text/yaml' })
    response.end(manifestFor(version))
    return
  }
  // 任何安装包请求都回真实安装包字节（sha512 用同一份文件算的）。
  if (url.pathname.startsWith('/stable/') && installerBytes !== null) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installerBytes.length })
    response.end(installerBytes)
    return
  }
  response.writeHead(404)
  response.end('not found')
})

async function listen() {
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return server.address().port
}

async function launchApp(userData, feedUrl) {
  const env = { ...process.env, NORYTH_USER_DATA: userData, NORYTH_SINGLE_INSTANCE: '0', NORYTH_UPDATE_FEED: feedUrl, NORYTH_UPDATE_CHANNEL: 'stable' }
  delete env.NORYTH_DEEPSEEK_API_KEY
  return electron.launch({ executablePath: exe, args: [], env })
}

async function checkState(app, page, label) {
  const info = await page.evaluate(async () => window.noryth.app.info())
  if (!info.ok) return fail(`${label}: app.info 失败`)
  if (!info.data.packaged) return fail(`${label}: 不是打包形态`)
  if (info.data.update.channel !== 'stable' || !info.data.update.configured) {
    return fail(`${label}: 通道未按预期配置 ${JSON.stringify(info.data.update)}`)
  }
  return info.data
}

async function main() {
  if (!existsSync(exe)) {
    fail(`找不到 ${exe}；先跑 pnpm pack 或传 --dir <安装目录>`)
    return
  }
  verifyManifest()

  const port = await listen()
  const feedUrl = `http://127.0.0.1:${port}/stable`
  const userData = mkdtempSync(join(tmpdir(), 'noryth-update-user-'))
  console.log(`[update-drill] feed=${feedUrl} app=${exe}`)

  const app = await launchApp(userData, feedUrl)
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="app-ready"]', { timeout: 60_000 })
    const info = await checkState(app, page, 'boot')
    record('boot', true, `version=${info.version} channel=${info.update.channel} status=${info.update.status}`)
    if (info.version !== pkg.version) fail(`应用版本 ${info.version} 与 package.json ${pkg.version} 不一致`)

    const expectations = [
      ['same', 'up_to_date', pkg.version],
      ['newer', 'available', '99.0.0'],
      ['older-minor', 'downgrade_blocked', '0.1.9'],
      ['error', 'failed', null]
    ]
    for (const [nextMode, expected, version] of expectations) {
      mode = nextMode
      const result = await page.evaluate(async () => window.noryth.app.checkUpdates())
      if (!result.ok) {
        record(`check:${nextMode}`, false, result.error.code)
        continue
      }
      const ok = result.data.status === expected && (version === null || result.data.version === version)
      record(`check:${nextMode}`, ok, `status=${result.data.status} version=${result.data.version} error=${result.data.error ?? '—'}`)
      const refreshed = await page.evaluate(async () => window.noryth.app.info())
      if (!refreshed.ok || refreshed.data.update.status !== expected) {
        record(`state:${nextMode}`, false, 'app.info().update 没有反映最近一次检查')
      }
      // 检查失败/被拒后应用仍可用：再取一次项目列表。
      const alive = await page.evaluate(async () => window.noryth.project.list())
      if (!alive.ok) record(`alive:${nextMode}`, false, '更新检查后应用不可用')
    }

    // 4. 下载（可选）：available 时让 electron-updater 拉一次；失败只记 INFO。
    if (!skipDownload && installerBytes !== null) {
      mode = 'newer'
      await page.evaluate(async () => window.noryth.app.checkUpdates())
      const cacheRoot = join(process.env.LOCALAPPDATA ?? join(tmpdir()), 'noryth-updater')
      let found = null
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (existsSync(cacheRoot)) {
          const stack = [cacheRoot]
          while (stack.length > 0 && found === null) {
            const dir = stack.pop()
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const path = join(dir, entry.name)
              if (entry.isDirectory()) stack.push(path)
              else if (entry.name.endsWith('.exe')) found = path
            }
          }
        }
        if (found !== null) break
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
      }
      if (found === null) {
        record('download', null, `60s 内未在 ${cacheRoot} 看到安装包（下载路径未跑通，不阻塞判定）`)
      } else {
        const same = sha512Base64(found) === (installerBytes === null ? '' : sha512Base64(installer))
        record('download', same, found)
      }
    }
  } finally {
    try {
      await app.close()
    } catch {
      // 已退出
    }
    server.close()
    if (process.env.NORYTH_KEEP_DRILL !== '1') {
      rmSync(feedRoot, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  }

  const failed = results.filter((entry) => entry.ok === false).length
  const infoCount = results.filter((entry) => entry.ok === null).length
  console.log(`[update-drill] ${failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed})`}${infoCount > 0 ? ` · ${infoCount} 项未覆盖` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
