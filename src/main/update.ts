/**
 * 更新检查与通道（PHASE-10 J4 / PHASE-18 M1-7）。
 *
 * 两条路径：
 * - `checkForUpdates()`：纯函数式检查（拉通道清单、比较版本），可在测试与混沌注入里跑，
 *   任何网络/解析错误都归一为 `failed`，不抛错。
 * - `runUpdateCheck()`：启动后台检查与设置页「检查更新」共用；打包构建且配置了
 *   `NORYTH_UPDATE_FEED` 时才走 electron-updater 下载，失败只记日志。
 *
 * 通道（PHASE-18 §5.1）：
 * - `stable` → `<feed>/latest.yml`，不接收预发布版本；
 * - `beta`   → `<feed>/beta.yml`，接收预发布；
 * - `dev`    → `<feed>/dev.yml`，接收预发布。
 * 默认 stable；用 `NORYTH_UPDATE_CHANNEL` 覆盖。
 *
 * 降级（D5）：只允许同一 minor 回退（例如 0.2.2 → 0.2.1），跨 minor 一律拒绝，
 * 避免 schema 回退。`allowDowngrade` 只在判定为 `downgrade` 时打开。
 */

import type { UpdateChannel, UpdateState, UpdateStatus } from '../shared/schema/update'

export type { UpdateChannel, UpdateState, UpdateStatus }
export { UPDATE_CHANNELS } from '../shared/schema/update'

export interface UpdateCheckOptions {
  feedUrl?: string
  currentVersion: string
  channel?: UpdateChannel
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface UpdateCheckResult {
  status: UpdateStatus
  /** 远端版本；解析不到为 null。 */
  version: string | null
  /** 永远 false：调用方可以据此断言「不阻塞启动」。 */
  blocking: false
  error: string | null
  channel: UpdateChannel
  /** 实际读取的清单文件名（latest.yml / beta.yml / dev.yml）。 */
  manifest: string
  /** true = 远端更低但同 minor，允许回退。 */
  downgrade: boolean
}

// ── 通道 ────────────────────────────────────────────────────────────────────

export function channelOf(raw: string | undefined | null): UpdateChannel {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'dev' || value === 'beta' || value === 'stable' ? value : 'stable'
}

export function channelManifest(channel: UpdateChannel): string {
  return channel === 'stable' ? 'latest.yml' : `${channel}.yml`
}

/** feed 根地址 → 通道目录；stable 就用根，beta/dev 各一层子目录。 */
export function feedUrlFor(base: string, channel: UpdateChannel): string {
  const trimmed = base.replace(/\/+$/, '')
  return channel === 'stable' ? trimmed : `${trimmed}/${channel}`
}

// ── 版本 ────────────────────────────────────────────────────────────────────

interface ParsedVersion {
  parts: [number, number, number]
  prerelease: string[]
}

export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(raw)
  if (!match) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.').filter((part) => part.length > 0)
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  // 无预发布标记 > 有预发布标记（semver §11）。
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** semver 比较：>0 = a 更新；<0 = b 更新；0 = 相同。解析失败抛错。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) throw new Error(`无法解析版本：${left === null ? a : b}`)
  for (let index = 0; index < 3; index += 1) {
    const diff = left.parts[index]! - right.parts[index]!
    if (diff !== 0) return diff
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function isSameMinor(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return false
  return left.parts[0] === right.parts[0] && left.parts[1] === right.parts[1]
}

export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.prerelease.length > 0
}

export interface UpdateDecision {
  status: Extract<
    UpdateStatus,
    'up_to_date' | 'available' | 'downgrade' | 'downgrade_blocked' | 'prerelease_skipped'
  >
  compare: number
  downgrade: boolean
}

/**
 * 判定远端版本怎么处理：
 * - 更高：stable 通道忽略预发布；其余 → available
 * - 相同：up_to_date
 * - 更低：同 minor → downgrade（允许）；跨 minor → downgrade_blocked
 */
export function decideUpdate(input: {
  current: string
  remote: string
  channel: UpdateChannel
}): UpdateDecision {
  const compare = compareVersions(input.remote, input.current)
  if (compare === 0) return { status: 'up_to_date', compare, downgrade: false }
  if (compare > 0) {
    if (input.channel === 'stable' && isPrerelease(input.remote)) {
      return { status: 'prerelease_skipped', compare, downgrade: false }
    }
    return { status: 'available', compare, downgrade: false }
  }
  if (isSameMinor(input.current, input.remote)) {
    return { status: 'downgrade', compare, downgrade: true }
  }
  return { status: 'downgrade_blocked', compare, downgrade: false }
}

// ── 检查 ────────────────────────────────────────────────────────────────────

function parseManifestVersion(text: string): string | null {
  const match = /^\s*version:\s*([0-9A-Za-z.+-]+)\s*$/m.exec(text)
  return match ? match[1]! : null
}

export async function checkForUpdates(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const channel = options.channel ?? 'stable'
  const manifest = channelManifest(channel)
  const base = { channel, manifest, downgrade: false, blocking: false as const }
  const { feedUrl, currentVersion } = options
  if (!feedUrl) {
    return { ...base, status: 'disabled', version: null, error: null }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000)
  const url = `${feedUrlFor(feedUrl, channel)}/${manifest}`
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' }
    })
    if (!response.ok) {
      return { ...base, status: 'failed', version: null, error: `HTTP ${response.status}` }
    }
    const version = parseManifestVersion(await response.text())
    if (version === null) {
      return { ...base, status: 'failed', version: null, error: `${manifest} 里没有 version` }
    }
    let decision: UpdateDecision
    try {
      decision = decideUpdate({ current: currentVersion, remote: version, channel })
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        version,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    return { ...base, status: decision.status, version, error: null, downgrade: decision.downgrade }
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      version: null,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── 状态（设置页 + AppInfo）──────────────────────────────────────────────────

let lastState: UpdateState = {
  channel: 'stable',
  configured: false,
  status: 'idle',
  version: null,
  checkedAt: null,
  error: null
}

export function currentUpdateState(): UpdateState {
  return { ...lastState }
}

export function setUpdateState(patch: Partial<UpdateState>): UpdateState {
  lastState = { ...lastState, ...patch }
  return currentUpdateState()
}

/** 测试/演练用：重置模块级状态，避免用例互相污染。 */
export function resetUpdateState(): void {
  lastState = {
    channel: 'stable',
    configured: false,
    status: 'idle',
    version: null,
    checkedAt: null,
    error: null
  }
}

export interface RunUpdateOptions {
  packaged: boolean
  currentVersion: string
  feedUrl?: string
  channel?: UpdateChannel
  log: (message: string, details?: Record<string, unknown>) => void
  /** false = 只检查不下载；启动检查与设置页手动检查都下载（下载仍由 electron-updater 后台做）。 */
  download?: boolean
  now?: () => Date
}

/**
 * 跑一次检查并把结果写进模块级状态。
 *
 * 非打包构建或未配置 feed → `disabled`；网络/解析失败 → `failed`；都不抛错，
 * 也都不阻塞启动（PRD §9.1）。
 */
export async function runUpdateCheck(options: RunUpdateOptions): Promise<UpdateState> {
  const channel = options.channel ?? channelOf(process.env.NORYTH_UPDATE_CHANNEL)
  const configured = Boolean(options.feedUrl)
  setUpdateState({ channel, configured, status: 'checking', error: null })
  if (!options.packaged || !options.feedUrl) {
    options.log('update_check_skipped', { packaged: options.packaged, configured, channel })
    return setUpdateState({ status: 'disabled', version: null, checkedAt: null })
  }

  let result: UpdateCheckResult
  try {
    result = await checkForUpdates({
      feedUrl: options.feedUrl,
      currentVersion: options.currentVersion,
      channel
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.log('update_check_failed', { error: message })
    return setUpdateState({
      status: 'failed',
      error: message,
      checkedAt: (options.now ?? (() => new Date()))().toISOString()
    })
  }
  options.log('update_check', {
    status: result.status,
    version: result.version,
    channel,
    manifest: result.manifest,
    error: result.error
  })
  const state = setUpdateState({
    status: result.status,
    version: result.version,
    error: result.error,
    checkedAt: (options.now ?? (() => new Date()))().toISOString()
  })

  const shouldDownload =
    (result.status === 'available' || result.status === 'downgrade') && options.download !== false
  if (!shouldDownload) return state

  try {
    const updater = (await import('electron-updater')).autoUpdater
    // generic provider + 通道目录：stable 用根，beta/dev 用子目录。
    updater.setFeedURL({ provider: 'generic', url: feedUrlFor(options.feedUrl!, channel) })
    updater.allowPrerelease = channel !== 'stable'
    // D5：只有判定为同 minor 回退时才允许降级。
    updater.allowDowngrade = result.status === 'downgrade'
    updater.on('error', (error) => options.log('update_download_failed', { error: error.message }))
    updater.checkForUpdates().catch((error: unknown) => {
      options.log('update_download_failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  } catch (error) {
    options.log('update_download_failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return state
}

/** 兼容旧入口：启动后 fire-and-forget 的检查（不 await 开窗）。 */
export async function startBackgroundUpdateCheck(options: RunUpdateOptions): Promise<UpdateState | null> {
  try {
    return await runUpdateCheck(options)
  } catch (error) {
    options.log('update_check_failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}
