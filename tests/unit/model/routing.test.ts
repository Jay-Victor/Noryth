import { describe, expect, it } from 'vitest'
import { SettingsSchema, type Settings } from '../../../src/shared/schema/project'
import { CapabilitiesSchema } from '../../../src/shared/schema/model'
import type { ResolvedBinding } from '../../../src/main/model/bindings'
import { ModelError } from '../../../src/main/model/adapter'
import { routingTriggerOf, createRoutingRuntime } from '../../../src/main/model/router'
import { HealthRegistry } from '../../../src/main/model/health'

/**
 * 路由与熔断（PHASE-21 §5.1 / §5.2 / §5.5）。
 *
 * 时钟全部注入，不 sleep；断言只覆盖「回合开始前」的决策与健康状态，
 * 不把故障切换藏进适配器重试。
 */

function capabilities(tools = true) {
  return CapabilitiesSchema.parse({
    stream: true,
    tools,
    jsonMode: true,
    contextWindow: 128_000,
    maxOutput: 16_384,
    pricing: { in: 1, out: 2 }
  })
}

function settingsWith(
  patch: {
    enabled?: boolean
    fallbackOn?: Array<'rate_limit' | 'server' | 'timeout'>
    cooldownMs?: number
    agents?: Record<string, { preset: 'openai' | 'deepseek' | 'tongyi'; model?: string }>
    tools?: boolean
    tested?: boolean
    disabled?: boolean
  } = {}
): Settings {
  return SettingsSchema.parse({
    routing: {
      enabled: patch.enabled ?? true,
      fallbackOn: patch.fallbackOn ?? ['rate_limit', 'server'],
      cooldownMs: patch.cooldownMs ?? 60_000,
      agents: patch.agents ?? { narrator: { preset: 'openai', model: 'gpt-4.1-mini' } }
    },
    providersEnabled: patch.disabled === true ? { openai: false } : {},
    providers: {
      openai: {
        baseUrl: null,
        model: 'gpt-4.1-mini',
        capabilities: patch.tested === false ? null : capabilities(patch.tools ?? true),
        checkedAt: patch.tested === false ? null : '2026-11-21T00:00:00.000Z'
      }
    }
  })
}

const primary: ResolvedBinding = {
  agentKey: 'narrator',
  provider: 'deepseek',
  model: 'deepseek-flash',
  params: {},
  version: 2,
  source: 'agent'
}

function runtime(settings: Settings, clock: { now: number }, providerReady = true) {
  return createRoutingRuntime({
    getSettings: () => settings,
    providerReady: () => providerReady,
    now: () => clock.now
  })
}

describe('routingTriggerOf', () => {
  it('只认 rate_limit / server / timeout；auth、内容过滤、协议错误不切换', () => {
    expect(routingTriggerOf(new ModelError('rate_limit', '429', { status: 429 }))?.trigger).toBe('rate_limit')
    expect(routingTriggerOf(new ModelError('model_error', '500', { status: 500 }))?.trigger).toBe('server')
    expect(routingTriggerOf(new ModelError('model_error', 'boom'))?.trigger).toBe('server')
    expect(routingTriggerOf(new ModelError('timeout', 'timeout', { status: 504 }))?.trigger).toBe('timeout')
    expect(routingTriggerOf(new ModelError('model_auth', '401', { status: 401 }))).toBeNull()
    expect(routingTriggerOf(new ModelError('content_filter', 'filter', { status: 400 }))).toBeNull()
    expect(routingTriggerOf(new ModelError('tool_protocol_error', 'protocol'))).toBeNull()
    expect(routingTriggerOf(new ModelError('model_error', '404', { status: 404 }))).toBeNull()
  })
})

describe('routing runtime', () => {
  it('关闭时不切换、不留痕', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(settingsWith({ enabled: false }), clock)
    expect(route.route({ projectId: 'p1', agentKey: 'narrator', primary })).toEqual({
      binding: primary,
      trace: null
    })
  })

  it('一次 429 后：下一回合用备用，并留下 from/to/reason', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(settingsWith(), clock)
    route.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
    const decision = route.route({ projectId: 'p1', agentKey: 'narrator', primary })
    expect(decision.binding.provider).toBe('openai')
    expect(decision.binding.model).toBe('gpt-4.1-mini')
    expect(decision.trace).toMatchObject({
      from: 'deepseek',
      to: 'openai',
      reason: 'primary_unhealthy',
      error: 'rate_limit'
    })
    expect(route.status('p1').last?.trace.to).toBe('openai')
  })

  it('auth / 内容过滤 / 未勾选的触发条件不记健康', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(settingsWith({ fallbackOn: ['server'] }), clock)
    route.recordFailure('p1', 'deepseek', new ModelError('model_auth', '401', { status: 401 }))
    route.recordFailure('p1', 'deepseek', new ModelError('content_filter', 'filter', { status: 400 }))
    route.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
    expect(route.route({ projectId: 'p1', agentKey: 'narrator', primary }).binding.provider).toBe('deepseek')
    expect(route.status('p1').health.find((row) => row.preset === 'deepseek')?.failures).toBe(0)
  })

  it('同家 5 分钟内 3 次失败打开熔断；冷却后半开一次成功复位', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(settingsWith({ cooldownMs: 60_000 }), clock)
    const error = new ModelError('model_error', '500', { status: 500 })
    route.recordFailure('p1', 'deepseek', error)
    clock.now += 61_000
    route.recordFailure('p1', 'deepseek', error)
    clock.now += 61_000
    route.recordFailure('p1', 'deepseek', error)

    const opened = route.route({ projectId: 'p1', agentKey: 'narrator', primary })
    expect(opened.binding.provider).toBe('openai')
    expect(opened.trace?.reason).toBe('circuit_open')

    clock.now += 61_000
    const halfOpen = route.route({ projectId: 'p1', agentKey: 'narrator', primary })
    expect(halfOpen.binding.provider).toBe('deepseek')
    route.recordSuccess('p1', 'deepseek')
    const state = route.status('p1').health.find((row) => row.preset === 'deepseek')!
    expect(state.failures).toBe(0)
    expect(state.openUntil).toBeNull()
  })

  it('两家都失败：主备都不可用时抛 routing_exhausted，冷却后恢复主家', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(settingsWith({ cooldownMs: 60_000 }), clock)
    const error = new ModelError('model_error', '500', { status: 500 })
    route.recordFailure('p1', 'deepseek', error)
    route.recordFailure('p1', 'openai', error)
    expect(() => route.route({ projectId: 'p1', agentKey: 'narrator', primary })).toThrowError(
      /主备供应商都不可用/
    )
    clock.now += 61_000
    expect(route.route({ projectId: 'p1', agentKey: 'narrator', primary }).binding.provider).toBe('deepseek')
  })

  it('备用家必须已启用 / 已测试 / 有工具能力 / 有 Key；同家不算备用', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    for (const settings of [
      settingsWith({ tested: false }),
      settingsWith({ tools: false }),
      settingsWith({ disabled: true })
    ]) {
      const route = runtime(settings, clock)
      route.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
      expect(route.route({ projectId: 'p1', agentKey: 'narrator', primary }).binding.provider).toBe('deepseek')
      expect(route.fallbackFor('narrator')).toBeNull()
    }
    const noKey = runtime(settingsWith(), clock, false)
    noKey.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
    expect(noKey.route({ projectId: 'p1', agentKey: 'narrator', primary }).binding.provider).toBe('deepseek')

    const same = settingsWith({ agents: { narrator: { preset: 'deepseek', model: 'deepseek-flash' } } })
    const route = runtime(same, clock)
    route.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
    expect(route.route({ projectId: 'p1', agentKey: 'narrator', primary }).binding.provider).toBe('deepseek')
  })

  it('角色实例归一到 character 行', () => {
    const clock = { now: Date.UTC(2026, 10, 21, 0, 0, 0) }
    const route = runtime(
      settingsWith({ agents: { character: { preset: 'openai', model: 'gpt-4.1-mini' } } }),
      clock
    )
    route.recordFailure('p1', 'deepseek', new ModelError('rate_limit', '429', { status: 429 }))
    const decision = route.route({
      projectId: 'p1',
      agentKey: 'character:chr_lin',
      primary: { ...primary, agentKey: 'character:chr_lin' }
    })
    expect(decision.binding.provider).toBe('openai')
    expect(decision.binding.agentKey).toBe('character:chr_lin')
  })
})

describe('HealthRegistry', () => {
  it('重启清空：新实例没有旧失败', () => {
    const clock = { now: 1_000 }
    const first = new HealthRegistry({ now: () => clock.now })
    first.recordFailure('p1', 'deepseek', 'rate_limit', 60_000)
    expect(first.stateOf('p1', 'deepseek').usable).toBe(false)
    const second = new HealthRegistry({ now: () => clock.now })
    expect(second.stateOf('p1', 'deepseek').usable).toBe(true)
    expect(second.stateOf('p1', 'deepseek').failures).toBe(0)
  })
})
