import type { Capabilities } from '../../shared/schema/model'
import type { PlanModelStatus } from '../../shared/schema/plan'
import type { Settings } from '../../shared/schema/project'
import type { Repos } from '../db/repos'
import type { ChatAdapter } from '../model/adapter'
import type { CapabilitiesLookup, ResolvedBinding } from '../model/bindings'
import { resolveBinding } from '../model/bindings'
import type { RoutingPort } from '../model/router'
import type { RoutingTrace } from '../../shared/schema/routing'
import { createOpenAiCompatAdapter } from '../model/openai-compat'
import { AGENT_KEY_FALLBACKS, envApiKeyLookup, type ApiKeyLookup } from '../model/keys'
import { baseUrlFor, capabilitiesFor, findPreset } from '../model/presets'
import { FakePlannerAdapter } from './fake-adapter'

/**
 * 规划 Agent 的模型装配（PHASE-06 / PHASE-10 I1）。
 *
 * Key 由设置页经 safeStorage 保管，环境变量只做兜底：
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
  return envApiKeyLookup(AGENT_KEY_FALLBACKS.planner, env)(provider)?.key ?? null
}

export interface PlannerModel {
  binding: ResolvedBinding
  adapter: ChatAdapter
  status: PlanModelStatus
  /** 路由切换留痕（PHASE-21）；不切换时为 null。 */
  routingTrace?: RoutingTrace | null
}

export interface PlannerModelOptions {
  /** 只有未打包构建才允许假适配器。 */
  allowFake: boolean
  env?: NodeJS.ProcessEnv
  /** 设置页注入的 Key 解析（safeStorage 优先，环境变量兜底）。 */
  apiKeyFor?: ApiKeyLookup
  /** 多供应商路由（PHASE-21）：回合开始前决定主家/备用。 */
  routing?: RoutingPort
}

export function plannerModel(
  repos: Repos,
  settings: Settings,
  options: PlannerModelOptions
): PlannerModel {
  const project = repos.project.get()
  if (!project) throw new Error('project row missing')
  const lookup = capabilitiesLookupFromSettings(settings)
  const primary = resolveBinding(repos, project, 'planner', lookup)
  const env = options.env ?? process.env
  const fakeEnabled = options.allowFake && env.NORYTH_PLAN_FAKE === '1'
  // 假适配器固定 provider=deepseek，路由只在真实适配器上生效，避免归因分叉。
  const decision =
    fakeEnabled || options.routing === undefined
      ? { binding: primary, trace: null }
      : options.routing.route({ projectId: project.id, agentKey: 'planner', primary })
  const binding = decision.binding

  const preset = findPreset(binding.provider)
  const providerSnapshot = settings.providers[binding.provider]
  const baseUrl = baseUrlFor(binding.provider, providerSnapshot?.baseUrl ?? null)
  const capabilities =
    providerSnapshot?.capabilities ?? capabilitiesFor(binding.provider, binding.model) ?? undefined
  const apiKey = options.apiKeyFor ? (options.apiKeyFor(binding.provider)?.key ?? null) : apiKeyFor(binding.provider, env)
  const label = `${preset?.label ?? binding.provider} · ${fakeEnabled ? 'planner-fake' : binding.model}`

  if (fakeEnabled) {
    return {
      binding,
      adapter: new FakePlannerAdapter(),
      routingTrace: null,
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
    routingTrace: decision.trace,
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
