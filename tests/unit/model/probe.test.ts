import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../../../src/shared/schema/model'
import type { ProviderSettings } from '../../../src/shared/schema/model'
import { ModelError } from '../../../src/main/model/adapter'
import { probeProvider } from '../../../src/main/model/probe'

const CAPS: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 8_192,
  pricing: { in: 1, out: 2 }
}

describe('能力探测（PHASE-04 D2）', () => {
  it('成功时把 baseUrl / capabilities / checkedAt 写入 settings 快照', async () => {
    const saved: Array<{ preset: string; snapshot: ProviderSettings }> = []
    const result = await probeProvider(
      { preset: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-test' },
      {
        now: () => 1_700_000_000_000,
        createAdapter: (config) => {
          expect(config.baseUrl).toBe('https://api.deepseek.com/v1')
          expect(config.apiKey).toBe('sk-test')
          return {
            provider: 'deepseek',
            model: 'deepseek-flash',
            probe: async () => CAPS,
            stream: async () => {
              throw new Error('not used')
            }
          }
        },
        save: (preset, snapshot) => saved.push({ preset, snapshot })
      }
    )

    expect(result.ok).toBe(true)
    expect(result.capabilities).toEqual(CAPS)
    expect(result.error).toBeNull()
    expect(result.checkedAt).toBe('2023-11-14T22:13:20.000Z')
    expect(saved).toEqual([
      {
        preset: 'deepseek',
        snapshot: {
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
          capabilities: CAPS,
          checkedAt: result.checkedAt
        }
      }
    ])
  })

  it('自定义 baseUrl 优先，探测失败返回可操作错误码', async () => {
    const saved: Array<ProviderSettings> = []
    const result = await probeProvider(
      { preset: 'openai', model: 'gpt-4.1-mini', baseUrl: 'https://proxy.local/v1' },
      {
        createAdapter: () => ({
          provider: 'openai',
          model: 'gpt-4.1-mini',
          probe: async () => {
            throw new ModelError('model_auth', '401 from upstream', { status: 401 })
          },
          stream: async () => {
            throw new Error('not used')
          }
        }),
        save: (_preset, snapshot) => saved.push(snapshot)
      }
    )
    expect(result.ok).toBe(false)
    expect(result.capabilities).toBeNull()
    expect(result.error?.code).toBe('model_auth')
    expect(result.error?.message).toBe('API Key 无效或过期')
    expect(result.baseUrl).toBe('https://proxy.local/v1')
    expect(saved[0]?.capabilities).toBeNull()
  })

  it('未知预设直接报错，不写 settings', async () => {
    const saved: ProviderSettings[] = []
    await expect(
      probeProvider(
        // 运行时非枚举值（schema 在 IPC 层已拒绝；这里验证预设表兜底）
        { preset: 'moonshot' as never, model: 'x' },
        { save: (_preset, snapshot) => saved.push(snapshot) }
      )
    ).rejects.toThrow(/未知供应商预设/)
    expect(saved).toHaveLength(0)
  })
})
