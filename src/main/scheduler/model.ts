import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import type { WriteModelStatus } from '../../shared/schema/write'
import type { Repos } from '../db/repos'
import type { ChatAdapter } from '../model/adapter'
import { resolveBinding, type CapabilitiesLookup, type ResolvedBinding } from '../model/bindings'
import { createOpenAiCompatAdapter } from '../model/openai-compat'
import { AGENT_KEY_FALLBACKS, envApiKeyLookup, type ApiKeyLookup } from '../model/keys'
import { baseUrlFor, capabilitiesFor, findPreset } from '../model/presets'
import { FakeWriteModelAdapter } from './fake-adapter'

/**
 * 创作台的模型装配（PHASE-07 F4 / PHASE-10 I1）。
 *
 * 每个拍按 job 冻结的绑定构造适配器；Key 由设置页经 safeStorage 保管，
 * 环境变量兜底。`NORYTH_WRITE_FAKE=1` 只在未打包构建生效。
 */

export interface WriteModelOptions {
  allowFake: boolean
  /** 每次读当前设置：设置页改绑定后下一个 job 生效（DEV-PLAN §7.7）。 */
  getSettings: () => Settings
  env?: NodeJS.ProcessEnv
  /** 假模型的分片延迟（E2E 用来观察流式）。 */
  fakeChunkDelayMs?: number
  apiKeyFor?: ApiKeyLookup
}

function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | null {
  return envApiKeyLookup(AGENT_KEY_FALLBACKS.narrator, env)(provider)?.key ?? null
}

/** 同一 provider/model 复用假适配器，重生成才会换下一句（与切片一致）。 */
const fakeAdapters = new Map<string, FakeWriteModelAdapter>()

function parseCachedTokens(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

export class WriteModelFactory {
  constructor(private readonly options: WriteModelOptions) {}

  private fakeEnabled(): boolean {
    const env = this.options.env ?? process.env
    return this.options.allowFake && env.NORYTH_WRITE_FAKE === '1'
  }

  adapter(binding: ResolvedBinding): ChatAdapter {
    if (this.fakeEnabled()) {
      const longMode = (this.options.env ?? process.env).NORYTH_WRITE_FAKE_LONG === '1'
      const key = `${binding.provider}|${binding.model}|${longMode ? 'long' : 'short'}`
      const existing = fakeAdapters.get(key)
      if (existing) return existing
      const created = new FakeWriteModelAdapter({
        provider: binding.provider,
        model: binding.model,
        chunkDelayMs: this.options.fakeChunkDelayMs ?? 4,
        longMode,
        cachedTokens: parseCachedTokens(
          (this.options.env ?? process.env).NORYTH_WRITE_FAKE_CACHED_TOKENS
        )
      })
      fakeAdapters.set(key, created)
      return created
    }
    const env = this.options.env ?? process.env
    const apiKey = this.options.apiKeyFor
      ? (this.options.apiKeyFor(binding.provider)?.key ?? null)
      : apiKeyFor(binding.provider, env)
    if (apiKey === null) {
      throw new AppError('model_auth', `未配置 ${binding.provider} 的 API Key`, { provider: binding.provider })
    }
    const snapshot = this.options.getSettings().providers[binding.provider]
    const capabilities =
      snapshot?.capabilities ?? capabilitiesFor(binding.provider, binding.model) ?? undefined
    return createOpenAiCompatAdapter({
      provider: binding.provider,
      baseUrl: baseUrlFor(binding.provider, snapshot?.baseUrl ?? null),
      model: binding.model,
      apiKey,
      ...(capabilities === undefined ? {} : { capabilities })
    })
  }

  status(repos: Repos): WriteModelStatus {
    const project = repos.project.get()
    if (!project) {
      return { provider: 'deepseek', model: 'deepseek-flash', label: '未打开项目', ready: false }
    }
    const settings = this.options.getSettings()
    const lookup: CapabilitiesLookup = (provider, model) => {
      const snapshot = settings.providers[provider]
      return snapshot?.capabilities ?? capabilitiesFor(provider, model)
    }
    const binding = resolveBinding(repos, project, 'narrator', lookup)
    if (this.fakeEnabled()) {
      return { provider: binding.provider, model: 'write-fake', label: '假模型 · E2E', ready: true }
    }
    const ready = this.options.apiKeyFor
      ? this.options.apiKeyFor(binding.provider) !== null
      : apiKeyFor(binding.provider, this.options.env ?? process.env) !== null
    const preset = findPreset(binding.provider)
    return {
      provider: binding.provider,
      model: binding.model,
      label: `${preset?.label ?? binding.provider} · ${binding.model}`,
      ready
    }
  }

  capabilitiesLookup(): CapabilitiesLookup {
    return (provider, model) => {
      const snapshot = this.options.getSettings().providers[provider]
      return snapshot?.capabilities ?? capabilitiesFor(provider, model)
    }
  }

  /** 该 provider 是否真的能发请求：假模型模式视为可用，否则要求有 Key（PHASE-21）。 */
  providerReady(provider: string): boolean {
    if (this.fakeEnabled()) return true
    const env = this.options.env ?? process.env
    return this.options.apiKeyFor
      ? this.options.apiKeyFor(provider) !== null
      : apiKeyFor(provider, env) !== null
  }
}
