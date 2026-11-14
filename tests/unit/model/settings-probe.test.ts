import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capabilities } from '../../../src/shared/schema/model'
import { probeProvider } from '../../../src/main/model/probe'
import { SettingsStore } from '../../../src/main/settings/store'

const CAPS: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 8_192,
  pricing: { in: 0, out: 0 }
}

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('能力探测落 settings.json（PHASE-04 D2）', () => {
  it('只写 baseUrl / capabilities / checkedAt，不写 Key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noryth-probe-'))
    const settings = new SettingsStore(join(dir, 'settings.json'))

    const result = await probeProvider(
      { preset: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-secret-should-not-persist' },
      {
        now: () => 1_700_000_000_000,
        createAdapter: () => ({
          provider: 'deepseek',
          model: 'deepseek-flash',
          probe: async () => CAPS,
          stream: async () => {
            throw new Error('not used')
          }
        }),
        save: (preset, snapshot) => {
          const current = settings.read()
          settings.write({ providers: { ...current.providers, [preset]: snapshot } })
        }
      }
    )

    expect(result.ok).toBe(true)
    const saved = settings.read()
    expect(saved.providers.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      capabilities: CAPS,
      checkedAt: '2023-11-14T22:13:20.000Z'
    })

    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(raw).not.toContain('sk-secret-should-not-persist')
    expect(raw).not.toContain('apiKey')
    expect(raw).toContain('deepseek-flash')
  })

  it('探测失败也记录 checkedAt 与错误，但 capabilities 为 null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noryth-probe-fail-'))
    const settings = new SettingsStore(join(dir, 'settings.json'))
    const result = await probeProvider(
      { preset: 'openai', model: 'gpt-4.1-mini' },
      {
        now: () => 1_700_000_000_000,
        createAdapter: () => ({
          provider: 'openai',
          model: 'gpt-4.1-mini',
          probe: async () => {
            throw new Error('network down')
          },
          stream: async () => {
            throw new Error('not used')
          }
        }),
        save: (preset, snapshot) => {
          const current = settings.read()
          settings.write({ providers: { ...current.providers, [preset]: snapshot } })
        }
      }
    )
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('model_error')
    expect(settings.read().providers.openai?.capabilities).toBeNull()
    expect(settings.read().providers.openai?.checkedAt).toBe('2023-11-14T22:13:20.000Z')
  })
})
