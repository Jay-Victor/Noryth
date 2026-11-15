import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import type { Repos } from '../db/repos'
import type { ChatAdapter } from '../model/adapter'
import { resolveBinding, type CapabilitiesLookup } from '../model/bindings'
import { createOpenAiCompatAdapter } from '../model/openai-compat'
import { AGENT_KEY_FALLBACKS, envApiKeyLookup, type ApiKeyLookup } from '../model/keys'
import { baseUrlFor, capabilitiesFor, findPreset } from '../model/presets'
import { FakeReviewModelAdapter } from './fake-adapter'

/**
 * 审批台的模型装配（PHASE-08 G1 / PHASE-10 I1）。
 *
 * 与创作台同构：按 job 冻结的绑定构造适配器；Key 由设置页经 safeStorage 保管，
 * 环境变量兜底。`NORYTH_REVIEW_FAKE=1` 只在未打包构建生效。
 *
 * M0 只做单模型复审；异构复检（换模型/换供应商）是 M1——设置里把 reviewer
 * 绑到另一家即可手动实现，不在本阶段自动切换。
 */

export interface ReviewModelOptions {
  allowFake: boolean
  getSettings: () => Settings
  env?: NodeJS.ProcessEnv
  fakeChunkDelayMs?: number
  apiKeyFor?: ApiKeyLookup
}

function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | null {
  return (
    envApiKeyLookup(AGENT_KEY_FALLBACKS.reviewer, env)(provider)
      ?.key ?? null
  )
}

/** 同一 provider/model 复用假适配器，保证多次报告的行为一致。 */
const fakeAdapters = new Map<string, FakeReviewModelAdapter>()

export class ReviewModelFactory {
  constructor(private readonly options: ReviewModelOptions) {}

  private fakeEnabled(): boolean {
    const env = this.options.env ?? process.env
    return this.options.allowFake && env.NORYTH_REVIEW_FAKE === '1'
  }

  adapter(binding: { provider: string; model: string }): ChatAdapter {
    if (this.fakeEnabled()) {
      const key = `${binding.provider}|${binding.model}`
      const existing = fakeAdapters.get(key)
      if (existing) return existing
      const created = new FakeReviewModelAdapter({
        provider: binding.provider,
        model: binding.model,
        chunkDelayMs: this.options.fakeChunkDelayMs ?? 2
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
    const binding = resolveBinding(repos, project, 'reviewer', this.capabilitiesLookup())
    if (this.fakeEnabled()) {
      return { provider: binding.provider, model: 'review-fake', label: '假模型 · E2E', ready: true }
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
}
