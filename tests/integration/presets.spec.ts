import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../../src/shared/schema/model'
import { createOpenAiCompatAdapter } from '../../src/main/model/openai-compat'
import { PROVIDER_PRESETS, baseUrlFor, defaultModelFor, estimateCostCny } from '../../src/main/model/presets'
import { startFakeLlm, type FakeLlmServer } from './support/fake-llm'

/**
 * 两家预设的流式与工具调用（PHASE-04 §6 第 1 条）。
 * 这里用同一套 OpenAI-compatible 协议跑两家预设；真实第二家按 ADR-0003
 * 仍需作者提供 Key 补测，CI 不调真实 API。
 */

const CAPS: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 8_192,
  pricing: { in: 0, out: 0 }
}

async function runPreset(server: FakeLlmServer, provider: string, model: string) {
  const adapter = createOpenAiCompatAdapter(
    { provider, baseUrl: server.baseUrl, model, capabilities: CAPS },
    { retry: { sleep: async () => undefined, jitter: () => 0 } }
  )
  return adapter.stream(
    {
      messages: [{ role: 'user', content: '写一拍' }],
      stream: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'memory.retrieve_own',
            description: '检索私有记忆',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ]
    },
    {}
  )
}

describe('两家预设（DeepSeek / OpenAI 兼容）', () => {
  it('两家都能流式返回正文并拼装工具调用', async () => {
    const servers: FakeLlmServer[] = []
    try {
      const deepseek = await startFakeLlm(
        () => ({
          text: '雨停了。',
          toolCalls: [{ id: 'call_ds', name: 'memory.retrieve_own', args: { query: '匣子' } }],
          usage: { in: 100, out: 20 }
        }),
        'deepseek-flash'
      )
      const openai = await startFakeLlm(
        () => ({
          text: '风起了。',
          toolCalls: [{ id: 'call_oa', name: 'memory.retrieve_own', args: { query: '灯' } }],
          usage: { in: 90, out: 18 }
        }),
        'gpt-4.1-mini'
      )
      servers.push(deepseek, openai)

      const ds = await runPreset(deepseek, 'deepseek', 'deepseek-flash')
      expect(ds.text).toBe('雨停了。')
      expect(ds.toolCalls).toEqual([{ id: 'call_ds', name: 'memory.retrieve_own', arguments: '{"query":"匣子"}' }])
      expect(ds.usage).toEqual({ promptTokens: 100, completionTokens: 20 })

      const oa = await runPreset(openai, 'openai', 'gpt-4.1-mini')
      expect(oa.text).toBe('风起了。')
      expect(oa.toolCalls[0]?.name).toBe('memory.retrieve_own')
      expect(oa.usage).toEqual({ promptTokens: 90, completionTokens: 18 })
    } finally {
      await Promise.all(servers.map((server) => server.close()))
    }
  })

  it('预设表覆盖 PRD 允许的三家，baseUrl 可被代理覆盖', () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.preset).sort()).toEqual(['deepseek', 'openai', 'tongyi'])
    expect(baseUrlFor('deepseek')).toBe('https://api.deepseek.com/v1')
    expect(baseUrlFor('deepseek', 'https://proxy.local/v1')).toBe('https://proxy.local/v1')
    expect(defaultModelFor('deepseek')).toBe('deepseek-flash')
  })

  it('pricing 为 0 时成本返回 null，不假装精确', () => {
    expect(estimateCostCny(CAPS, 1000, 500)).toBeNull()
    expect(estimateCostCny({ ...CAPS, pricing: { in: 1, out: 2 } }, 1_000_000, 1_000_000)).toBe(3)
  })
})
