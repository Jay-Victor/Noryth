import { AppError, isAppError } from '../../shared/domain/app-error'
import type { ErrorCode } from '../../shared/domain/errors'
import { messageFor } from '../../shared/domain/errors'
import type { Settings } from '../../shared/schema/project'
import type {
  RoutingFallback,
  RoutingSettings,
  RoutingStatus,
  RoutingTrace,
  RoutingTrigger
} from '../../shared/schema/routing'
import { AGENT_KEYS } from '../../shared/schema/settings'
import type { AgentInstanceKey } from '../tools/types'
import { ModelError } from './adapter'
import type { CapabilitiesLookup, ResolvedBinding } from './bindings'
import { HealthRegistry } from './health'
import { PROVIDER_PRESETS, capabilitiesFor, defaultModelFor, findPreset } from './presets'

/**
 * 多供应商路由器（PHASE-21 §5.1 / M2-4）。
 *
 * 解析顺序：先按绑定继承链拿到主绑定，再在「路由开关打开 + 该 Agent 配了备用」时
 * 查内存健康状态：
 *   - 主家可用 → 主家（不产生 routing 留痕）；
 *   - 主家最近失败 / 熔断打开 → 备用；
 *   - 备用也不可用 → `routing_exhausted`，不在同一拍里反复重试。
 *
 * 两个硬边界：
 * 1. 切换只发生在回合开始前，runTurn 拿到的是本次实际绑定；job 快照仍是初始绑定。
 * 2. `auth` / `content_filter` / `protocol` / `context_overflow` 永不触发切换。
 */

/** 适配器归一化错误 → 路由触发类别；null 表示不切换。 */
export function routingTriggerOf(error: unknown): { trigger: RoutingTrigger; code: ErrorCode; status: number | null } | null {
  if (error instanceof ModelError) {
    // 作者取消不是供应商故障，不能计入健康状态。
    if (error.aborted) return null
    if (error.code === 'rate_limit') return { trigger: 'rate_limit', code: error.code, status: error.status }
    if (error.code === 'timeout') return { trigger: 'timeout', code: error.code, status: error.status }
    if (error.code === 'model_error' && (error.status === null || error.status >= 500)) {
      return { trigger: 'server', code: error.code, status: error.status }
    }
    return null
  }
  if (isAppError(error)) {
    const details = error.details
    const aborted =
      details !== null && typeof details === 'object' && (details as { aborted?: unknown }).aborted === true
    if (aborted) return null
    const status =
      details !== null && typeof details === 'object' && typeof (details as { status?: unknown }).status === 'number'
        ? ((details as { status: number }).status)
        : null
    if (error.code === 'rate_limit') return { trigger: 'rate_limit', code: error.code, status }
    if (error.code === 'timeout') return { trigger: 'timeout', code: error.code, status }
    if (error.code === 'model_error' && (status === null || status >= 500)) {
      return { trigger: 'server', code: error.code, status }
    }
  }
  return null
}

/** 备用家必须是「已启用 + 已测试 + 有 Key + 已知模型 + 有工具能力」。 */
function validateFallback(settings: Settings, entry: RoutingFallback | undefined): RoutingFallback | null {
  if (!entry) return null
  if (settings.providersEnabled[entry.preset] === false) return null
  const meta = findPreset(entry.preset)
  if (!meta) return null
  const snapshot = settings.providers[entry.preset]
  if (!snapshot?.capabilities || !snapshot.checkedAt) return null
  const model = entry.model ?? snapshot.model ?? defaultModelFor(entry.preset)
  const known = meta.models.some((candidate) => candidate.id === model) || snapshot.model === model
  if (!known) return null
  const capabilities = snapshot.capabilities ?? capabilitiesFor(entry.preset, model)
  // 六个 Agent 的回合都至少需要工具或 JSON 回退；没有工具能力的模型不能当备用。
  if (!capabilities || !capabilities.tools) return null
  return { preset: entry.preset, model }
}

export function baseAgentOfKey(agentKey: AgentInstanceKey | string): string {
  return agentKey.startsWith('character:') ? 'character' : agentKey
}

export interface RoutingRuntimeOptions {
  getSettings: () => Settings
  /** 该 provider 是否真的能发请求：有 Key，或 E2E 假模型模式。 */
  providerReady: (provider: string) => boolean
  capabilitiesLookup?: CapabilitiesLookup
  now?: () => number
  log?: (message: string, details?: Record<string, unknown>) => void
  /** 状态栏推送（主进程注入）；不注入时只写状态快照。 */
  onEvent?: (event: { projectId: string; agentKey: string; trace: RoutingTrace }) => void
}

export interface RouteInput {
  projectId: string
  agentKey: AgentInstanceKey
  primary: ResolvedBinding
}

export interface RouteDecision {
  /** 本次回合实际使用的绑定（job 快照仍是主绑定）。 */
  binding: ResolvedBinding
  /** 只有发生切换 / 判定耗尽时才有值。 */
  trace: RoutingTrace | null
}

export interface RoutingPort {
  route(input: RouteInput): RouteDecision
  recordSuccess(projectId: string, provider: string): void
  recordFailure(projectId: string, provider: string, error: unknown): void
  status(projectId: string): RoutingStatus
  /** 异构复检用：已校验的备用家（可能和主家同家，由调用方再判）。 */
  fallbackFor(agentKey: AgentInstanceKey | string): RoutingFallback | null
  /** 异构复检用：该家当前是否可用（路由关闭时视为可用）。 */
  usable(projectId: string, provider: string): boolean
}

function traceOf(input: {
  from: string
  to: string
  reason: RoutingTrace['reason']
  error: string | null
  now: () => number
}): RoutingTrace {
  return {
    from: input.from,
    to: input.to,
    reason: input.reason,
    error: input.error,
    at: new Date(input.now()).toISOString()
  }
}

export function createRoutingRuntime(options: RoutingRuntimeOptions): RoutingPort {
  const now = options.now ?? (() => Date.now())
  const health = new HealthRegistry({
    now,
    ...(options.log === undefined ? {} : { log: options.log })
  })
  const lastByProject = new Map<string, { agentKey: string; trace: RoutingTrace }>()

  const settingsNow = (): Settings => options.getSettings()

  function fallbackFor(agentKey: AgentInstanceKey | string): RoutingFallback | null {
    const settings = settingsNow()
    if (!settings.routing.enabled) return null
    const base = baseAgentOfKey(agentKey)
    if (!(AGENT_KEYS as readonly string[]).includes(base)) return null
    const entry = settings.routing.agents[base]
    const validated = validateFallback(settings, entry)
    if (!validated) return null
    if (!options.providerReady(validated.preset)) return null
    return validated
  }

  function fallbackBinding(validated: RoutingFallback, agentKey: AgentInstanceKey): ResolvedBinding {
    const settings = settingsNow()
    const capabilities =
      settings.providers[validated.preset]?.capabilities ??
      capabilitiesFor(validated.preset, validated.model ?? '') ??
      undefined
    return {
      agentKey,
      provider: validated.preset,
      model: validated.model ?? defaultModelFor(validated.preset),
      params: {},
      version: 0,
      source: 'preset',
      ...(capabilities === undefined ? {} : { capabilities })
    }
  }

  function remember(projectId: string, agentKey: string, trace: RoutingTrace): void {
    lastByProject.set(projectId, { agentKey, trace })
    options.onEvent?.({ projectId, agentKey, trace })
  }

  function route(input: RouteInput): RouteDecision {
    const settings = settingsNow()
    const routing: RoutingSettings = settings.routing
    if (!routing.enabled) return { binding: input.primary, trace: null }
    const fallback = fallbackFor(input.agentKey)
    if (!fallback || fallback.preset === input.primary.provider) {
      return { binding: input.primary, trace: null }
    }

    const primary = health.stateOf(input.projectId, input.primary.provider)
    const secondary = health.stateOf(input.projectId, fallback.preset)
    if (primary.usable) return { binding: input.primary, trace: null }

    if (!secondary.usable) {
      const trace = traceOf({
        from: input.primary.provider,
        to: fallback.preset,
        reason: 'routing_exhausted',
        error: primary.lastError ?? secondary.lastError,
        now
      })
      remember(input.projectId, input.agentKey, trace)
      options.log?.('routing_exhausted', {
        projectId: input.projectId,
        agentKey: input.agentKey,
        from: input.primary.provider,
        to: fallback.preset,
        primaryOpen: primary.open,
        secondaryOpen: secondary.open
      })
      throw new AppError('routing_exhausted', messageFor('routing_exhausted'), {
        from: input.primary.provider,
        to: fallback.preset,
        fromError: primary.lastError,
        toError: secondary.lastError
      })
    }

    const trace = traceOf({
      from: input.primary.provider,
      to: fallback.preset,
      reason: primary.open ? 'circuit_open' : 'primary_unhealthy',
      error: primary.lastError,
      now
    })
    remember(input.projectId, input.agentKey, trace)
    options.log?.('routing_fallback', {
      projectId: input.projectId,
      agentKey: input.agentKey,
      from: input.primary.provider,
      to: fallback.preset,
      reason: trace.reason,
      error: trace.error
    })
    return { binding: fallbackBinding(fallback, input.agentKey), trace }
  }

  function recordFailure(projectId: string, provider: string, error: unknown): void {
    const settings = settingsNow()
    if (!settings.routing.enabled) return
    const classified = routingTriggerOf(error)
    if (!classified) return
    if (!settings.routing.fallbackOn.includes(classified.trigger)) return
    health.recordFailure(projectId, provider, classified.code, settings.routing.cooldownMs)
  }

  function recordSuccess(projectId: string, provider: string): void {
    const settings = settingsNow()
    if (!settings.routing.enabled) return
    health.recordSuccess(projectId, provider)
  }

  function status(projectId: string): RoutingStatus {
    const settings = settingsNow()
    const last = lastByProject.get(projectId) ?? null
    return {
      enabled: settings.routing.enabled,
      last: last === null ? null : { agentKey: last.agentKey, trace: last.trace },
      health: health.view(
        projectId,
        PROVIDER_PRESETS.map((preset) => preset.preset)
      )
    }
  }

  function usable(projectId: string, provider: string): boolean {
    const settings = settingsNow()
    if (!settings.routing.enabled) return true
    return health.stateOf(projectId, provider).usable
  }

  return { route, recordSuccess, recordFailure, status, fallbackFor, usable }
}

/** 路由关闭时给调用方一个空实现，避免到处判空（测试与旧调用点用）。 */
export function noRouting(): RoutingPort {
  const empty = (): RoutingStatus => ({ enabled: false, last: null, health: [] })
  return {
    route: (input) => ({ binding: input.primary, trace: null }),
    recordSuccess: () => undefined,
    recordFailure: () => undefined,
    status: empty,
    fallbackFor: () => null,
    usable: () => true
  }
}
