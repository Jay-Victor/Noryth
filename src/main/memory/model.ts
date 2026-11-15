import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import type { Repos } from '../db/repos'
import type { ChatAdapter } from '../model/adapter'
import { resolveBinding, type CapabilitiesLookup } from '../model/bindings'
import { createOpenAiCompatAdapter } from '../model/openai-compat'
import { baseUrlFor, capabilitiesFor, findPreset } from '../model/presets'
import { FakeMemoryModelAdapter } from './fake-adapter'
import { memoryApiKeyFor } from './run'

/**
 * 记忆台的模型装配（PHASE-09 H1）。
 *
 * 与审批台同构：按项目绑定构造适配器；Key 只驻留内存（阶段 10 接设置页）。
 * `NORYTH_MEMORY_FAKE=1` 只在未打包构建生效。
 */

export interface MemoryModelOptions {
  allowFake: boolean
  getSettings: () => Settings
  env?: NodeJS.ProcessEnv
  fakeChunkDelayMs?: number
}

const fakeAdapters = new Map<string, FakeMemoryModelAdapter>()

export class MemoryModelFactory {
  constructor(private readonly options: MemoryModelOptions) {}

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  fakeEnabled(): boolean {
    return this.options.allowFake && this.env().NORYTH_MEMORY_FAKE === '1'
  }

  adapter(binding: { provider: string; model: string }): ChatAdapter {
    if (this.fakeEnabled()) {
      const key = `${binding.provider}|${binding.model}`
      const existing = fakeAdapters.get(key)
      if (existing) return existing
      const created = new FakeMemoryModelAdapter({
        provider: binding.provider,
        model: binding.model,
        chunkDelayMs: this.options.fakeChunkDelayMs ?? 2
      })
      fakeAdapters.set(key, created)
      return created
    }
    const env = this.env()
    const apiKey = memoryApiKeyFor(binding.provider, env)
    if (apiKey === null) {
      throw new AppError('model_auth', `未配置 ${binding.provider} 的 API Key`, { provider: binding.provider })
    }
    const snapshot = this.options.getSettings().providers[binding.provider]
    const capabilities = snapshot?.capabilities ?? capabilitiesFor(binding.provider, binding.model) ?? undefined
    return createOpenAiCompatAdapter({
      provider: binding.provider,
      baseUrl: baseUrlFor(binding.provider, snapshot?.baseUrl ?? null),
      model: binding.model,
      apiKey,
      ...(capabilities === undefined ? {} : { capabilities })
    })
  }

  capabilitiesLookup(): CapabilitiesLookup {
    return (provider, model) => {
      const snapshot = this.options.getSettings().providers[provider]
      return snapshot?.capabilities ?? capabilitiesFor(provider, model)
    }
  }

  status(repos: Repos): { provider: string; model: string; label: string; ready: boolean } {
    const project = repos.project.get()
    if (!project) {
      return { provider: 'deepseek', model: 'deepseek-flash', label: '未打开项目', ready: false }
    }
    const binding = resolveBinding(repos, project, 'memory', this.capabilitiesLookup())
    if (this.fakeEnabled()) {
      return { provider: binding.provider, model: 'memory-fake', label: '假模型 · E2E', ready: true }
    }
    const ready = memoryApiKeyFor(binding.provider, this.env()) !== null
    const preset = findPreset(binding.provider)
    return {
      provider: binding.provider,
      model: binding.model,
      label: `${preset?.label ?? binding.provider} · ${binding.model}`,
      ready
    }
  }
}
