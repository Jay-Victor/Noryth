/**
 * 更新检查（PHASE-10 J4 / PRD §9.1「更新检查失败不阻塞启动」）。
 *
 * 两条路径：
 * - `checkForUpdates()`：纯函数式检查（拉 `latest.yml`、比较版本），可在测试与
 *   混沌注入里跑，任何网络/解析错误都归一为 `failed`，不抛错。
 * - `startBackgroundUpdateCheck()`：启动后 fire-and-forget；打包构建 + 配置了
 *   `NORYTH_UPDATE_FEED` 时才走 electron-updater，失败只记日志。
 *
 * M0 不在启动路径上 `await`：窗口先可用，更新是后台事。发布地址缺失时状态为
 * `disabled`，不假装能更新。
 */

export type UpdateStatus = 'disabled' | 'up_to_date' | 'available' | 'failed'

export interface UpdateCheckOptions {
  feedUrl?: string
  currentVersion: string
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
}

function parseVersion(text: string): string | null {
  const match = /^\s*version:\s*([0-9A-Za-z.+-]+)\s*$/m.exec(text)
  return match ? match[1]! : null
}

function compare(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10))
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = Number.isNaN(left[index]) ? 0 : (left[index] ?? 0)
    const r = Number.isNaN(right[index]) ? 0 : (right[index] ?? 0)
    if (l !== r) return l - r
  }
  return 0
}

export async function checkForUpdates(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const { feedUrl, currentVersion } = options
  if (!feedUrl) return { status: 'disabled', version: null, blocking: false, error: null }

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000)
  try {
    const response = await fetchImpl(`${feedUrl.replace(/\/$/, '')}/latest.yml`, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' }
    })
    if (!response.ok) {
      return { status: 'failed', version: null, blocking: false, error: `HTTP ${response.status}` }
    }
    const version = parseVersion(await response.text())
    if (version === null) {
      return { status: 'failed', version: null, blocking: false, error: 'latest.yml 里没有 version' }
    }
    return {
      status: compare(version, currentVersion) > 0 ? 'available' : 'up_to_date',
      version,
      blocking: false,
      error: null
    }
  } catch (error) {
    return {
      status: 'failed',
      version: null,
      blocking: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface BackgroundUpdateOptions {
  packaged: boolean
  currentVersion: string
  feedUrl?: string
  log: (message: string, details?: Record<string, unknown>) => void
}

/**
 * 启动时在后台跑一次检查。返回 Promise 只为测试；调用方不应 await 它来开窗。
 * 失败路径全部走日志，不向 UI 抛错（PRD §9.1 / 风险表「自动更新不可达」）。
 */
export async function startBackgroundUpdateCheck(options: BackgroundUpdateOptions): Promise<UpdateCheckResult | null> {
  if (!options.packaged || !options.feedUrl) {
    options.log('update_check_skipped', { packaged: options.packaged, configured: Boolean(options.feedUrl) })
    return null
  }
  try {
    const result = await checkForUpdates({ currentVersion: options.currentVersion, feedUrl: options.feedUrl })
    options.log('update_check', { status: result.status, version: result.version, error: result.error })
    if (result.status === 'available') {
      // 只从 electron-updater 走真实下载；失败同样不阻塞（下载失败由 electron-updater 记日志）
      try {
        const updater = (await import('electron-updater')).autoUpdater
        updater.setFeedURL({ provider: 'generic', url: options.feedUrl })
        updater.on('error', (error) => options.log('update_download_failed', { error: error.message }))
        updater.checkForUpdates().catch((error: unknown) => {
          options.log('update_download_failed', { error: error instanceof Error ? error.message : String(error) })
        })
      } catch (error) {
        options.log('update_download_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  } catch (error) {
    options.log('update_check_failed', { error: error instanceof Error ? error.message : String(error) })
    return { status: 'failed', version: null, blocking: false, error: String(error) }
  }
}
