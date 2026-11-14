import { existsSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireLock, isLockStale, isProcessAlive, readLock, startLock, LOCK_FILE } from '../../src/main/lock'
import { tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('project lock', () => {
  it('本机存活进程 + 新心跳视为已持有', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    writeFileSync(
      join(dir.path, LOCK_FILE),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        windowId: 'win_a',
        appVersion: '0.1.0',
        heartbeatAt: new Date().toISOString()
      })
    )
    const result = acquireLock(dir.path, { windowId: 'win_b', appVersion: '0.1.0' })
    expect(result.acquired).toBe(false)
    if (!result.acquired) expect(result.holder.windowId).toBe('win_a')
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('死亡 pid 的残留锁会被接管并标记 recovered', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    writeFileSync(
      join(dir.path, LOCK_FILE),
      JSON.stringify({
        pid: 999_999,
        host: hostname(),
        windowId: 'win_dead',
        appVersion: '0.1.0',
        heartbeatAt: new Date(Date.now() - 60_000).toISOString()
      })
    )
    const stale = readLock(dir.path)
    expect(stale).not.toBeNull()
    expect(isLockStale(stale!)).toBe(true)

    const result = acquireLock(dir.path, { windowId: 'win_new', appVersion: '0.1.0' })
    expect(result).toEqual({ acquired: true, recovered: true, holder: null })
    expect(readLock(dir.path)?.windowId).toBe('win_new')
  })

  it('心跳超过 30s 视为过期（即使进程存活）', () => {
    const stale = {
      pid: process.pid,
      host: hostname(),
      windowId: 'win',
      appVersion: '0.1.0',
      heartbeatAt: new Date(Date.now() - 31_000).toISOString()
    }
    expect(isLockStale(stale)).toBe(true)
    expect(isLockStale({ ...stale, heartbeatAt: new Date().toISOString() })).toBe(false)
  })

  it('startLock 释放后删除锁文件；非持有者不能释放', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const handle = startLock(dir.path, { windowId: 'win_a', appVersion: '0.1.0' })
    expect(handle).not.toBeNull()
    expect(existsSync(join(dir.path, LOCK_FILE))).toBe(true)
    handle?.release()
    expect(existsSync(join(dir.path, LOCK_FILE))).toBe(false)

    const second = startLock(dir.path, { windowId: 'win_b', appVersion: '0.1.0' })
    const third = startLock(dir.path, { windowId: 'win_c', appVersion: '0.1.0' })
    expect(third).toBeNull()
    expect(readLock(dir.path)?.windowId).toBe('win_b')
    // 非持有者试图释放：不会删除别人的锁
    second?.release()
    expect(existsSync(join(dir.path, LOCK_FILE))).toBe(false)
  })

  it('损坏的锁文件被当作不存在', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    writeFileSync(join(dir.path, LOCK_FILE), '{ not json')
    expect(readLock(dir.path)).toBeNull()
    expect(acquireLock(dir.path, { windowId: 'win', appVersion: '0.1.0' }).acquired).toBe(true)
  })
})
