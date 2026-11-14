import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export const LOCK_FILE = '.noryth.lock'
export const HEARTBEAT_INTERVAL_MS = 5_000
export const STALE_AFTER_MS = 30_000

export interface LockInfo {
  pid: number
  host: string
  windowId: string
  appVersion: string
  heartbeatAt: string
}

export type AcquireResult =
  | { acquired: true; recovered: boolean; holder: null }
  | { acquired: false; recovered: false; holder: LockInfo }

export function lockPath(projectDir: string): string {
  return join(projectDir, LOCK_FILE)
}

export function readLock(projectDir: string): LockInfo | null {
  const file = lockPath(projectDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.windowId !== 'string' ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.heartbeatAt !== 'string'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      windowId: parsed.windowId,
      appVersion: parsed.appVersion,
      heartbeatAt: parsed.heartbeatAt
    }
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM：进程存在但无权发信号
    return code === 'EPERM'
  }
}

/** 过期 = 本机进程不存在，或心跳超过 30s；跨主机无法探活，按存活处理。 */
export function isLockStale(info: LockInfo, nowMs = Date.now()): boolean {
  if (info.host !== hostname()) return false
  if (!isProcessAlive(info.pid)) return true
  const heartbeat = Date.parse(info.heartbeatAt)
  if (Number.isNaN(heartbeat)) return true
  return nowMs - heartbeat > STALE_AFTER_MS
}

function writeLock(projectDir: string, info: LockInfo): void {
  const file = lockPath(projectDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8')
  renameSync(tmp, file)
}

export interface AcquireOptions {
  windowId: string
  appVersion: string
  now?: () => number
}

export function acquireLock(projectDir: string, options: AcquireOptions): AcquireResult {
  const now = options.now ?? Date.now
  const existing = readLock(projectDir)
  if (existing && !isLockStale(existing, now())) {
    return { acquired: false, recovered: false, holder: existing }
  }
  writeLock(projectDir, {
    pid: process.pid,
    host: hostname(),
    windowId: options.windowId,
    appVersion: options.appVersion,
    heartbeatAt: new Date(now()).toISOString()
  })
  return { acquired: true, recovered: existing !== null, holder: null }
}

export interface LockHandle {
  readonly projectDir: string
  readonly windowId: string
  heartbeat(): void
  release(): void
  stop(): void
}

/** 持锁句柄：心跳 5s；release/stop 后不再写文件。 */
export function startLock(projectDir: string, options: AcquireOptions): LockHandle | null {
  const result = acquireLock(projectDir, options)
  if (!result.acquired) return null

  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const heartbeat = (): void => {
    if (stopped) return
    const info = readLock(projectDir)
    if (!info || info.windowId !== options.windowId) {
      stopped = true
      if (timer) clearInterval(timer)
      return
    }
    writeLock(projectDir, { ...info, heartbeatAt: new Date().toISOString() })
  }

  timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)
  timer.unref()

  const release = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    const info = readLock(projectDir)
    if (info && info.windowId === options.windowId) {
      try {
        rmSync(lockPath(projectDir), { force: true })
      } catch {
        // 锁文件删除失败：下次启动按心跳判定过期
      }
    }
  }

  return {
    projectDir,
    windowId: options.windowId,
    heartbeat,
    release,
    stop: release
  }
}
