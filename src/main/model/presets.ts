import type { Capabilities, ProviderPreset } from '../../shared/schema/model'

/**
 * 内置预设（PRD §9.3）：作者只需填 Key，其余预填。
 *
 * - `baseUrl` 与模型清单来自各家的 OpenAI-compatible 端点。
 * - `contextWindow` / `maxOutput` 是保守默认值，能力探测与真实 usage 可以覆盖；
 *   `pricing` 未核实时写 0，成本显示「未知」而不是假装精确。
 * - 第二家真实补测按 ADR-0003 执行；CI 只跑假服务器，不调真实 API。
 */

const UNPRICED = { in: 0, out: 0 }

function capabilities(patch: Partial<Capabilities> = {}): Capabilities {
  return {
    stream: true,
    tools: true,
    jsonMode: true,
    contextWindow: 64_000,
    maxOutput: 8_192,
    pricing: UNPRICED,
    ...patch
  }
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    preset: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-flash', capabilities: capabilities({ contextWindow: 64_000, maxOutput: 8_192 }) },
      { id: 'deepseek-chat', capabilities: capabilities({ contextWindow: 64_000, maxOutput: 8_192 }) }
    ]
  },
  {
    preset: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4.1-mini', capabilities: capabilities({ contextWindow: 128_000, maxOutput: 16_384 }) },
      { id: 'gpt-4.1', capabilities: capabilities({ contextWindow: 128_000, maxOutput: 16_384 }) }
    ]
  },
  {
    preset: 'tongyi',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', capabilities: capabilities({ contextWindow: 128_000, maxOutput: 8_192 }) }
    ]
  }
]

export function findPreset(preset: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((item) => item.preset === preset)
}

export function defaultModelFor(preset: string): string {
  const found = findPreset(preset)
  const model = found?.models[0]?.id
  if (!model) throw new Error(`未知供应商预设：${preset}`)
  return model
}

export function capabilitiesFor(preset: string, model: string): Capabilities | null {
  const found = findPreset(preset)
  return found?.models.find((item) => item.id === model)?.capabilities ?? null
}

export function baseUrlFor(preset: string, override?: string | null): string {
  if (override && override.trim().length > 0) return override.trim()
  const found = findPreset(preset)
  if (!found) throw new Error(`未知供应商预设：${preset}`)
  return found.baseUrl
}

/** 成本只做估算；pricing 为 0 时返回 null，由 UI 显示「未知」。 */
export function estimateCostCny(
  capabilities: Capabilities | null,
  tokensIn: number | null,
  tokensOut: number | null
): number | null {
  if (!capabilities || tokensIn === null || tokensOut === null) return null
  const { in: priceIn, out: priceOut } = capabilities.pricing
  if (priceIn <= 0 && priceOut <= 0) return null
  return (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000
}
