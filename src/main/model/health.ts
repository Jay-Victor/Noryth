import type { RoutingHealthView } from '../../shared/schema/routing'

/**
 * 供应商健康与熔断（PHASE-21 §5.2 / M2-4）。
 *
 * - 只统计可重试错误（由路由层按 `fallbackOn` 过滤后调用）；
 * - 一次可重试失败 → 冷却 `cooldownMs`，期间路由优先用备用；
 * - 同一家 5 分钟内累计 3 次失败 → 熔断打开 `cooldownMs`；冷却后允许一次探测
 *   （半开），成功清零、失败重新打开；
 * - 状态只在内存：重启清空，宁可多试一次，也不把一家永久拉黑。
 *
 * 测试注入时钟，不 sleep；`cooldownMs` 由设置决定，E2E 可用小值。
 */

export const FAILURE_WINDOW_MS = 5 * 60_000

export interface HealthState {
  failures: number
  lastFailureAt: number | null
  /** 单次失败后的避让截止时间（epoch ms）；0 = 无。 */
  coolingUntil: number
  /** 熔断打开截止时间（epoch ms）；0 = 未打开。 */
  openedUntil: number
  lastError: string | null
}

export interface HealthView {
  usable: boolean
  cooling: boolean
  open: boolean
  failures: number
  coolingUntil: number
  openedUntil: number
  lastError: string | null
}

export interface HealthRegistryOptions {
  now?: () => number
  log?: (message: string, details?: Record<string, unknown>) => void
}

function keyOf(projectId: string, preset: string): string {
  return `${projectId}:${preset}`
}

function emptyState(): HealthState {
  return { failures: 0, lastFailureAt: null, coolingUntil: 0, openedUntil: 0, lastError: null }
}

export class HealthRegistry {
  private readonly states = new Map<string, HealthState>()
  private readonly now: () => number
  private readonly log?: (message: string, details?: Record<string, unknown>) => void

  constructor(options: HealthRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.log = options.log
    // 进程启动清空是刻意行为（PHASE-21 §5.2）：记录一次，避免作者以为状态被持久化。
    this.log?.('health_reset', { reason: 'process_start' })
  }

  stateOf(projectId: string, preset: string): HealthView {
    const state = this.states.get(keyOf(projectId, preset)) ?? emptyState()
    const now = this.now()
    const cooling = now < state.coolingUntil
    const open = now < state.openedUntil
    return {
      usable: !cooling && !open,
      cooling,
      open,
      failures: state.failures,
      coolingUntil: state.coolingUntil,
      openedUntil: state.openedUntil,
      lastError: state.lastError
    }
  }

  /** 一次可重试失败：记数、避让；同家 5 分钟内第 3 次打开熔断。 */
  recordFailure(projectId: string, preset: string, errorCode: string, cooldownMs: number): HealthState {
    const key = keyOf(projectId, preset)
    const now = this.now()
    const state = this.states.get(key) ?? emptyState()
    if (state.lastFailureAt !== null && now - state.lastFailureAt > FAILURE_WINDOW_MS) {
      state.failures = 0
    }
    state.failures += 1
    state.lastFailureAt = now
    state.lastError = errorCode
    state.coolingUntil = now + cooldownMs
    if (state.failures >= 3) {
      state.openedUntil = now + cooldownMs
      this.log?.('health_open', { projectId, preset, failures: state.failures, cooldownMs })
    } else {
      this.log?.('health_cooling', { projectId, preset, failures: state.failures, cooldownMs })
    }
    this.states.set(key, state)
    return state
  }

  /** 成功一次清零；返回之前是否处于失败/熔断状态（供日志说「已恢复」）。 */
  recordSuccess(projectId: string, preset: string): boolean {
    const key = keyOf(projectId, preset)
    const state = this.states.get(key)
    if (!state) return false
    const wasUnhealthy = state.failures > 0 || state.coolingUntil > 0 || state.openedUntil > 0
    this.states.delete(key)
    if (wasUnhealthy) this.log?.('health_recovered', { projectId, preset })
    return wasUnhealthy
  }

  /** 只读快照：状态栏按预设顺序展示。 */
  view(projectId: string, presets: readonly string[]): RoutingHealthView[] {
    return presets.map((preset) => {
      const state = this.stateOf(projectId, preset)
      return {
        preset,
        failures: state.failures,
        coolingUntil: state.coolingUntil > 0 ? new Date(state.coolingUntil).toISOString() : null,
        openUntil: state.openedUntil > 0 ? new Date(state.openedUntil).toISOString() : null,
        lastError: state.lastError
      }
    })
  }

  reset(): void {
    this.states.clear()
    this.log?.('health_reset', { reason: 'manual' })
  }
}
