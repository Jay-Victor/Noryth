import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capabilities } from '../../../src/shared/schema/model'
import { SettingsPatchSchema } from '../../../src/shared/schema/project'
import { SettingsStore } from '../../../src/main/settings/store'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const CAPS: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 8_192,
  pricing: { in: 0, out: 0 }
}

function store() {
  const dir = tempDir('noryth-settings-')
  cleanups.push(dir.cleanup)
  return new SettingsStore(join(dir.path, 'settings.json'))
}

describe('settings.json 写入（I1 / I4）', () => {
  it('补丁不带 default：写 lastOpenedProjectId 不会清空探测快照（回归）', () => {
    const settings = store()
    settings.write({
      providers: {
        deepseek: {
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'deepseek-flash',
          capabilities: CAPS,
          checkedAt: '2026-11-15T00:00:00.000Z'
        }
      }
    })
    settings.write({ lastOpenedProjectId: 'prj_1' })

    const next = settings.read()
    expect(next.lastOpenedProjectId).toBe('prj_1')
    expect(next.providers.deepseek?.baseUrl).toBe('http://127.0.0.1:1/v1')
    expect(next.providers.deepseek?.capabilities?.tools).toBe(true)
  })

  it('外观按浅合并写入，其他字段不动', () => {
    const settings = store()
    settings.write({ providersEnabled: { tongyi: false }, appearance: { accent: 'ink' } })
    settings.write({ appearance: { theme: 'dark' } })

    const next = settings.read()
    expect(next.appearance).toMatchObject({ theme: 'dark', accent: 'ink' })
    expect(next.providersEnabled.tongyi).toBe(false)
    // 旧字段 theme 与外观保持一致
    expect(next.theme).toBe('dark')
  })

  it('补丁 schema 只包含显式传入的键', () => {
    expect(Object.keys(SettingsPatchSchema.parse({ lastOpenedProjectId: 'x' }))).toEqual(['lastOpenedProjectId'])
    expect(Object.keys(SettingsPatchSchema.parse({}))).toEqual([])
  })

  it('损坏的 settings.json 回落到默认值，不抛错', () => {
    const dir = tempDir('noryth-settings-bad-')
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'settings.json')
    writeFileSync(file, '{not json', 'utf8')
    const settings = new SettingsStore(file)
    expect(settings.read().appearance.theme).toBe('light')
  })

  it('启动自动打开开关：默认 true，可关闭且不影响其他键（PHASE-11 M1-24）', () => {
    const settings = store()
    expect(settings.read().openLastProject).toBe(true)

    settings.write({ lastOpenedProjectId: 'prj_1', providersEnabled: { tongyi: false } })
    settings.write({ openLastProject: false })

    const next = settings.read()
    expect(next.openLastProject).toBe(false)
    expect(next.lastOpenedProjectId).toBe('prj_1')
    expect(next.providersEnabled.tongyi).toBe(false)
  })
})
