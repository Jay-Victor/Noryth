import { useEffect, useMemo, useState } from 'react'
import type { Preset } from '../../../shared/schema/model'
import { AGENT_KEYS, AGENT_LABELS } from '../../../shared/schema/settings'
import {
  ROUTING_TRIGGERS,
  type RoutingFallback,
  type RoutingSettings,
  type RoutingTrigger
} from '../../../shared/schema/routing'
import { useSettings } from '../../stores/settings'

/**
 * 多供应商路由（PHASE-21 §5.1 / M2-4 / UI-DESIGN §8.2）。
 *
 * 默认关闭；备用家是显式配置，不自动降级、不按价格选家。
 * 每个 Agent 的备用家只在「主家最近失败 / 熔断打开」时生效；同一拍不中途换模型。
 * 这里只编辑设置；实际切换与留痕在主进程的路由器。
 */

const TRIGGER_LABELS: Record<RoutingTrigger, string> = {
  rate_limit: '限流（429）',
  server: '服务端错误（5xx）',
  timeout: '超时'
}

function fallbackOf(settings: RoutingSettings, agentKey: string): RoutingFallback | null {
  return settings.agents[agentKey] ?? null
}

export function RoutingCard(): React.JSX.Element {
  const view = useSettings((state) => state.view)
  const bindings = useSettings((state) => state.bindings)
  const setRouting = useSettings((state) => state.setRouting)
  const saving = useSettings((state) => state.saving)
  const [cooldownSeconds, setCooldownSeconds] = useState('60')

  const routing = view?.routing ?? null
  const cooldownMs = routing?.cooldownMs ?? 60_000
  useEffect(() => {
    setCooldownSeconds(String(Math.round(cooldownMs / 1000)))
  }, [cooldownMs])

  const providers = useMemo(() => {
    const available = (view?.providers ?? []).filter((provider) => provider.enabled)
    // 已配置但未测试的备用家也要能显示，避免下拉把当前值吞掉。
    const configured = new Set(Object.values(routing?.agents ?? {}).map((entry) => entry.preset))
    return available.filter((provider) => provider.connected || configured.has(provider.preset))
  }, [view?.providers, routing?.agents])

  if (!view || !routing) {
    return (
      <section className="side-card">
        <h2>故障切换</h2>
        <p>读取中…</p>
      </section>
    )
  }

  const patch = (next: Partial<RoutingSettings>): void => {
    void setRouting(next)
  }

  const toggleTrigger = (trigger: RoutingTrigger, enabled: boolean): void => {
    const set = new Set(routing.fallbackOn)
    if (enabled) set.add(trigger)
    else set.delete(trigger)
    patch({ fallbackOn: ROUTING_TRIGGERS.filter((item) => set.has(item)) })
  }

  const setAgent = (agentKey: string, provider: Preset | ''): void => {
    const next: Record<string, RoutingFallback> = { ...routing.agents }
    if (provider === '') {
      delete next[agentKey]
    } else {
      const card = providers.find((candidate) => candidate.preset === provider)
      const model = card?.models[0]?.id
      next[agentKey] = { preset: provider, ...(model === undefined ? {} : { model }) }
    }
    patch({ agents: next })
  }

  const setAgentModel = (agentKey: string, model: string): void => {
    const entry = fallbackOf(routing, agentKey)
    if (!entry) return
    patch({ agents: { ...routing.agents, [agentKey]: { ...entry, model } } })
  }

  /** 一键模板：所有 Agent 用第一家「已测试且不是项目默认」的提供方。 */
  const applyTemplate = (): void => {
    const primary = bindings?.defaultPreset ?? null
    const target = providers.find((provider) => provider.connected && provider.preset !== primary)
    if (!target) return
    const model = target.models[0]?.id
    if (model === undefined) return
    const agents: Record<string, RoutingFallback> = {}
    for (const agentKey of AGENT_KEYS) agents[agentKey] = { preset: target.preset as Preset, model }
    patch({ enabled: true, agents, fallbackOn: ['rate_limit', 'server'] })
  }

  const modelOf = (agentKey: string): string => fallbackOf(routing, agentKey)?.model ?? ''

  return (
    <section className="side-card" data-testid="routing-card">
      <header className="settings-section__head">
        <div>
          <h2>故障切换</h2>
          <p className="settings-hint">
            主家限流、5xx 或超时后，下一拍改用备用家；同一拍中途不换模型。auth / 内容过滤 / 协议错误不切换。
            健康状态只在本次运行有效，重启后重新探测。
          </p>
        </div>
        <div className="settings-section__actions">
          <button
            type="button"
            className="button button--ghost"
            data-testid="routing-template"
            disabled={saving}
            title="所有 Agent 使用第一家已测试且不同于项目默认的提供方"
            onClick={applyTemplate}
          >
            主家故障时用备用
          </button>
        </div>
      </header>

      <label className="settings-toggle settings-toggle--stacked">
        <input
          type="checkbox"
          data-testid="routing-enabled"
          checked={routing.enabled}
          disabled={saving}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        <span>
          启用故障切换
          <small>默认关闭；关掉后所有请求按逐 Agent 绑定走，不读健康状态。</small>
        </span>
      </label>

      <div className="settings-routing__row" data-testid="routing-triggers">
        <span>触发条件</span>
        <div className="settings-routing__chips">
          {ROUTING_TRIGGERS.map((trigger) => (
            <label key={trigger} className="settings-check">
              <input
                type="checkbox"
                data-testid={`routing-trigger-${trigger}`}
                checked={routing.fallbackOn.includes(trigger)}
                disabled={saving}
                onChange={(event) => toggleTrigger(trigger, event.target.checked)}
              />
              <span>{TRIGGER_LABELS[trigger]}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-routing__row">
        <span>冷却</span>
        <div className="settings-routing__inline">
          <input
            type="number"
            min={1}
            max={600}
            step={1}
            className="settings-input settings-input--short"
            data-testid="routing-cooldown"
            value={cooldownSeconds}
            disabled={saving}
            onChange={(event) => setCooldownSeconds(event.target.value)}
            onBlur={() => {
              const seconds = Number(cooldownSeconds)
              if (!Number.isFinite(seconds)) {
                setCooldownSeconds(String(Math.round(routing.cooldownMs / 1000)))
                return
              }
              const clamped = Math.min(600, Math.max(1, Math.round(seconds)))
              setCooldownSeconds(String(clamped))
              patch({ cooldownMs: clamped * 1000 })
            }}
          />
          <span className="settings-hint">秒；一次失败后避让，同家 5 分钟内 3 次失败打开熔断</span>
        </div>
      </div>

      {routing.fallbackOn.length === 0 ? (
        <p className="settings-warning" data-testid="routing-no-trigger">
          没有勾选触发条件：即使打开开关，也不会发生自动切换。
        </p>
      ) : null}

      <table className="settings-bindings settings-routing__table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>备用家</th>
            <th>模型</th>
          </tr>
        </thead>
        <tbody>
          {AGENT_KEYS.map((agentKey) => {
            const entry = fallbackOf(routing, agentKey)
            const card = providers.find((provider) => provider.preset === entry?.preset)
            return (
              <tr key={agentKey} data-testid={`routing-row-${agentKey}`}>
                <td>{AGENT_LABELS[agentKey]}</td>
                <td>
                  <select
                    className="settings-select"
                    data-testid={`routing-agent-${agentKey}-provider`}
                    value={entry?.preset ?? ''}
                    disabled={saving}
                    onChange={(event) => setAgent(agentKey, event.target.value as Preset | '')}
                  >
                    <option value="">（不配置）</option>
                    {providers.map((provider) => (
                      <option key={provider.preset} value={provider.preset}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="settings-select"
                    data-testid={`routing-agent-${agentKey}-model`}
                    value={modelOf(agentKey)}
                    disabled={saving || entry === null}
                    onChange={(event) => setAgentModel(agentKey, event.target.value)}
                  >
                    {(card?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                    {card === undefined && entry !== null ? (
                      <option value={entry.model ?? ''}>{entry.model ?? '（默认模型）'}</option>
                    ) : null}
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="settings-hint" data-testid="routing-save-note">
        备用家必须已启用、已通过连接测试、有 Key，且模型支持工具调用；同一家不能同时当主备。
        切换写 `turn_metric.context_json.routing` 与状态栏徽标，不改绑定审计。
      </p>
    </section>
  )
}
