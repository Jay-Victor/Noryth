import type { Capabilities, ProviderProbeInput, ProviderProbeResult, ProviderSettings } from '../../shared/schema/model'
import { ProviderProbeResultSchema } from '../../shared/schema/model'
import type { ErrorCode } from '../../shared/domain/errors'
import { messageFor } from '../../shared/domain/errors'
import { ModelError, type ChatAdapter } from './adapter'
import { createOpenAiCompatAdapter } from './openai-compat'
import { baseUrlFor, capabilitiesFor } from './presets'

/**
 * 能力探测（PHASE-04 D2 / DEV-PLAN §7.5）。
 *
 * 结果写 settings.json（只有 baseUrl / capabilities / checkedAt），
 * Key 只在本次调用内存里存在，既不落盘也不进日志。
 */

export interface ProbeDeps {
  createAdapter?: (config: {
    provider: string
    baseUrl: string
    model: string
    apiKey?: string
    capabilities?: Capabilities
  }) => ChatAdapter
  now?: () => number
  /** 由调用方决定写盘（设置页/主进程）；测试用内存实现。 */
  save?: (preset: string, snapshot: ProviderSettings) => void
}

function errorOf(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof ModelError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'model_error',
    message: error instanceof Error ? error.message : String(error)
  }
}

export async function probeProvider(input: ProviderProbeInput, deps: ProbeDeps = {}): Promise<ProviderProbeResult> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const baseUrl = baseUrlFor(input.preset, input.baseUrl)
  const presetCapabilities = capabilitiesFor(input.preset, input.model)
  const config = {
    provider: input.preset,
    baseUrl,
    model: input.model,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(presetCapabilities ? { capabilities: presetCapabilities } : {})
  }
  const adapter = deps.createAdapter ? deps.createAdapter(config) : createOpenAiCompatAdapter(config)

  let capabilities = null
  let ok = false
  let error: { code: ErrorCode; message: string } | null = null

  try {
    capabilities = await adapter.probe()
    ok = true
  } catch (caught) {
    error = errorOf(caught)
    // UI 文案只回答能不能继续；探测失败统一给可操作文案。
    error = { code: error.code, message: messageFor(error.code) }
  }

  const checkedAt = new Date(now()).toISOString()
  const result = ProviderProbeResultSchema.parse({
    preset: input.preset,
    model: input.model,
    baseUrl,
    ok,
    capabilities,
    latencyMs: Math.max(0, now() - started),
    checkedAt,
    error
  })

  deps.save?.(input.preset, {
    baseUrl,
    model: input.model,
    capabilities: result.capabilities,
    checkedAt
  })

  return result
}
