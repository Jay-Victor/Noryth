import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelManifest,
  channelOf,
  checkForUpdates,
  compareVersions,
  currentUpdateState,
  decideUpdate,
  feedUrlFor,
  isPrerelease,
  isSameMinor,
  parseVersion,
  resetUpdateState,
  runUpdateCheck,
  UPDATE_CHANNELS
} from '../../src/main/update'
import { UPDATE_STATUS_LABELS } from '../../src/shared/schema/update'

/**
 * 更新通道与版本判定（PHASE-18 M1-7）。
 *
 * 这些函数决定「装不装、退不退」：跨 minor 回退会让 schema 回退，必须拒绝；
 * stable 通道不能把预发布版本推给正式用户。
 */

function fakeFetch(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

afterEach(() => {
  resetUpdateState()
})

describe('更新通道', () => {
  it('未知通道回落 stable；清单文件名与目录固定', () => {
    expect(channelOf('beta')).toBe('beta')
    expect(channelOf(' DEV ')).toBe('dev')
    expect(channelOf('nightly')).toBe('stable')
    expect(channelOf(undefined)).toBe('stable')
    expect(UPDATE_CHANNELS).toEqual(['dev', 'beta', 'stable'])

    expect(channelManifest('stable')).toBe('latest.yml')
    expect(channelManifest('beta')).toBe('beta.yml')
    expect(channelManifest('dev')).toBe('dev.yml')

    expect(feedUrlFor('https://example.test/noryth/', 'stable')).toBe('https://example.test/noryth')
    expect(feedUrlFor('https://example.test/noryth', 'beta')).toBe('https://example.test/noryth/beta')
    expect(feedUrlFor('https://example.test/noryth///', 'dev')).toBe('https://example.test/noryth/dev')
  })

  it('版本解析与 semver 比较（含预发布）', () => {
    expect(parseVersion('v0.2.0-m1.1')?.parts).toEqual([0, 2, 0])
    expect(parseVersion('0.2.0-m1.1')?.prerelease).toEqual(['m1', '1'])
    expect(parseVersion('nope')).toBeNull()

    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.0-m1.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0-m1.2', '0.2.0-m1.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.2.0-alpha.9')).toBeGreaterThan(0)
    // 数字标识符优先级低于字母标识符（semver §11）
    expect(compareVersions('0.2.0-1', '0.2.0-alpha')).toBeLessThan(0)
    // build metadata 不参与比较
    expect(compareVersions('0.2.0+build5', '0.2.0+build1')).toBe(0)
    expect(() => compareVersions('x', '0.2.0')).toThrow(/无法解析版本/)

    expect(isSameMinor('0.2.3', '0.2.9')).toBe(true)
    expect(isSameMinor('0.2.0', '0.3.0')).toBe(false)
    expect(isPrerelease('0.2.0-m1.1')).toBe(true)
    expect(isPrerelease('0.2.0')).toBe(false)
  })

  it('判定：升级 / 同版本 / stable 忽略预发布 / 同 minor 回退 / 跨 minor 拒绝', () => {
    expect(decideUpdate({ current: '0.2.0', remote: '0.3.0', channel: 'stable' }).status).toBe('available')
    expect(decideUpdate({ current: '0.2.0', remote: '0.2.0', channel: 'stable' }).status).toBe('up_to_date')
    expect(decideUpdate({ current: '0.2.0', remote: '0.3.0-m2.1', channel: 'stable' }).status).toBe(
      'prerelease_skipped'
    )
    expect(decideUpdate({ current: '0.2.0', remote: '0.3.0-m2.1', channel: 'beta' }).status).toBe('available')
    expect(decideUpdate({ current: '0.2.2', remote: '0.2.1', channel: 'stable' })).toMatchObject({
      status: 'downgrade',
      downgrade: true
    })
    expect(decideUpdate({ current: '0.3.0', remote: '0.2.9', channel: 'stable' })).toMatchObject({
      status: 'downgrade_blocked',
      downgrade: false
    })
    // 0.2.0-m1.1 → 0.2.0 是升级（正式版高于预发布）
    expect(decideUpdate({ current: '0.2.0-m1.1', remote: '0.2.0', channel: 'stable' }).status).toBe('available')
  })

  it('checkForUpdates 走对应通道清单，失败归一为 failed 且不阻塞', async () => {
    const stable = fakeFetch('version: 0.3.0\nfiles:\n  - url: Noryth-0.3.0-setup.exe\n')
    const result = await checkForUpdates({
      feedUrl: 'https://example.test/noryth',
      currentVersion: '0.2.0',
      fetchImpl: stable
    })
    expect(result).toMatchObject({ status: 'available', version: '0.3.0', blocking: false, manifest: 'latest.yml' })
    expect(String((stable as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
      'https://example.test/noryth/latest.yml'
    )

    const beta = fakeFetch('version: 0.3.0-m2.1\n')
    const betaResult = await checkForUpdates({
      feedUrl: 'https://example.test/noryth',
      currentVersion: '0.2.0',
      channel: 'beta',
      fetchImpl: beta
    })
    expect(betaResult.status).toBe('available')
    expect(String((beta as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
      'https://example.test/noryth/beta/beta.yml'
    )

    const noVersion = await checkForUpdates({
      feedUrl: 'https://example.test/noryth',
      currentVersion: '0.2.0',
      fetchImpl: fakeFetch('files: []\n')
    })
    expect(noVersion.status).toBe('failed')
    expect(noVersion.error).toContain('没有 version')

    const http500 = await checkForUpdates({
      feedUrl: 'https://example.test/noryth',
      currentVersion: '0.2.0',
      fetchImpl: fakeFetch('', 500)
    })
    expect(http500.status).toBe('failed')
    expect(http500.error).toBe('HTTP 500')

    const disabled = await checkForUpdates({ currentVersion: '0.2.0' })
    expect(disabled.status).toBe('disabled')
  })
})

describe('更新状态', () => {
  it('开发构建/未配置 feed → disabled，不假装能更新', async () => {
    const log = vi.fn()
    const state = await runUpdateCheck({ packaged: false, currentVersion: '0.2.0', log })
    expect(state).toMatchObject({ status: 'disabled', configured: false, channel: 'stable' })
    expect(currentUpdateState()).toEqual(state)
    expect(log).toHaveBeenCalledWith('update_check_skipped', expect.objectContaining({ packaged: false }))

    const unconfigured = await runUpdateCheck({ packaged: true, currentVersion: '0.2.0', log })
    expect(unconfigured.status).toBe('disabled')
    expect(unconfigured.configured).toBe(false)
  })

  it('通道来自环境变量；检查结果写进 AppInfo 用的模块状态', async () => {
    process.env.NORYTH_UPDATE_CHANNEL = 'beta'
    try {
      const log = vi.fn()
      const state = await runUpdateCheck({
        packaged: true,
        currentVersion: '0.2.0',
        feedUrl: 'http://127.0.0.1:9/feed',
        download: false,
        now: () => new Date('2026-11-17T10:00:00.000Z'),
        log
      })
      expect(state.channel).toBe('beta')
      expect(state.status).toBe('failed')
      expect(state.checkedAt).toBe('2026-11-17T10:00:00.000Z')
      expect(currentUpdateState()).toEqual(state)
      expect(log).toHaveBeenCalledWith('update_check', expect.objectContaining({ status: 'failed', channel: 'beta' }))
    } finally {
      delete process.env.NORYTH_UPDATE_CHANNEL
    }
  })

  it('每种状态都有可读文案（设置页直接渲染）', () => {
    for (const status of [
      'idle',
      'checking',
      'disabled',
      'up_to_date',
      'available',
      'downgrade',
      'downgrade_blocked',
      'prerelease_skipped',
      'failed'
    ] as const) {
      expect(UPDATE_STATUS_LABELS[status].length).toBeGreaterThan(0)
    }
    // 失败文案必须写明「不阻塞」，避免被当成阻断错误。
    expect(UPDATE_STATUS_LABELS.failed).toContain('不阻塞')
  })
})
