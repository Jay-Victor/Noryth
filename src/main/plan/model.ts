import type { Capabilities } from '../../shared/schema/model'
import type { PlanModelStatus } from '../../shared/schema/plan'
import type { Settings } from '../../shared/schema/project'
import type { Repos } from '../db/repos'
import type { ChatAdapter } from '../model/adapter'
import type { CapabilitiesLookup, ResolvedBinding } from '../model/bindings'
import { resolveBinding } from '../model/bindings'
import { createOpenAiCompatAdapter } from '../model/openai-compat'
import { baseUrlFor, capabilitiesFor, findPreset } from '../model/presets'
import { FakePlannerAdapter } from './fake-adapter'

/**
 * 规划 Agent 的模型装配（PHASE-06）。
 *
 * 阶段 06 还没有 Key 管理 UI（阶段 10）；开发/作者环境用环境变量提供 Key：
 *   NORYTH_PLAN_API_KEY 或 NORYTH_<PROVIDER>_API_KEY
 * Key 只驻留内存，不写 settings、不写日志、不进项目目录。
 *
 * E2E 用 `NORYTH_PLAN_FAKE=1` + 未打包构建注入假适配器；生产包不认这个变量。
 */

export function capabilitiesLookupFromSettings(settings: Settings): CapabilitiesLookup {
  return (provider, model) => {
    const snapshot = settings.providers[provider]
    if (snapshot?.capabilities) return snapshot.capabilities
    return capabilitiesFor(provider, model)
  }
}

function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | null {
  const specific = env[`NORYTH_${provider.toUpperCase()}_API_KEY`]
  if (specific && specific.trim().length > 0) return specific.trim()
  const generic = env.NORYTH_PLAN_API_KEY
  return generic && generic.trim().length > 0 ? generic.trim() : null
}

export interface PlannerModel {
  binding: ResolvedBinding
  adapter: ChatAdapter
  status: PlanModelStatus
}

export interface PlannerModelOptions {
  /** 只有未打包构建才允许假适配器。 */
  allowFake: boolean
  env?: NodeJS.ProcessEnv
}

export function plannerModel(
  repos: Repos,
  settings: Settings,
  options: PlannerModelOptions
): PlannerModel {
  const project = repos.project.get()
  if (!project) throw new Error('project row missing')
  const lookup = capabilitiesLookupFromSettings(settings)
  const binding = resolveBinding(repos, project, 'planner', lookup)
  const env = options.env ?? process.env
  const fakeEnabled = options.allowFake && env.NORYTH_PLAN_FAKE === '1'

  const preset = findPreset(binding.provider)
  const providerSnapshot = settings.providers[binding.provider]
  const baseUrl = baseUrlFor(binding.provider, providerSnapshot?.baseUrl ?? null)
  const capabilities =
    providerSnapshot?.capabilities ?? capabilitiesFor(binding.provider, binding.model) ?? undefined
  const apiKey = apiKeyFor(binding.provider, env)
  const label = `${preset?.label ?? binding.provider} · ${fakeEnabled ? 'planner-fake' : binding.model}`

  if (fakeEnabled) {
    return {
      binding,
      adapter: new FakePlannerAdapter(),
      status: {
        provider: 'deepseek',
        model: 'planner-fake',
        label: '假模型 · E2E',
        ready: true
      }
    }
  }

  return {
    binding,
    adapter: createOpenAiCompatAdapter({
      provider: binding.provider,
      baseUrl,
      model: binding.model,
      ...(apiKey === null ? {} : { apiKey }),
      ...(capabilities === undefined ? {} : { capabilities })
    }),
    status: {
      provider: binding.provider,
      model: binding.model,
      label,
      ready: apiKey !== null
    }
  }
}

/** 只读状态：不构造适配器，不读 Key。 */
export function plannerModelStatus(repos: Repos, settings: Settings, allowFake: boolean): PlanModelStatus {
  try {
    const model = plannerModel(repos, settings, { allowFake })
    return model.status
  } catch {
    return { provider: 'deepseek', model: 'deepseek-flash', label: '未配置', ready: false }
  }
}

export type { Capabilities }
