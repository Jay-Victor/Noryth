import { useState } from 'react'
import type { Preset } from '../../../shared/schema/model'
import type { ProviderCard } from '../../../shared/schema/settings'
import { useSettings } from '../../stores/settings'

/**
 * 提供方卡（UI-DESIGN §8.4 / PHASE-10 I1 + I3）。
 *
 * Key 输入框只用于「填写新 Key」：保存后立刻清空，界面只显示末 4 位。
 * 测试连接用 safeStorage 里的 Key，失败给错误码 + 一句可操作建议。
 */

function formatPrice(value: number): string {
  return value > 0 ? `¥${value.toFixed(2)}/M` : '未知'
}

function statusOf(provider: ProviderCard): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (provider.connected) return { text: `已连接 · ${provider.checkedAt?.slice(0, 19).replace('T', ' ') ?? ''}`, tone: 'ok' }
  if (provider.key.configured) return { text: '未测试', tone: 'warn' }
  return { text: '未配置 Key', tone: 'muted' }
}

export function ProviderSettingsCard({ provider }: { provider: ProviderCard }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const testResult = useSettings((state) => state.testResults[provider.preset])
  const testing = useSettings((state) => state.testing[provider.preset] === true)
  const saving = useSettings((state) => state.saving)
  const setKey = useSettings((state) => state.setKey)
  const clearKey = useSettings((state) => state.clearKey)
  const test = useSettings((state) => state.test)
  const setEnabled = useSettings((state) => state.setProviderEnabled)
  const status = statusOf(provider)

  const save = async (): Promise<void> => {
    if (draft.trim().length < 8) return
    setPending(true)
    const ok = await setKey(provider.preset as Preset, draft.trim())
    setPending(false)
    if (ok) setDraft('')
  }

  return (
    <section className="side-card settings-provider" data-testid={`settings-provider-${provider.preset}`}>
      <header className="settings-provider__head">
        <div>
          <h2>{provider.label}</h2>
          <div className="settings-provider__status" data-tone={status.tone} data-testid={`provider-status-${provider.preset}`}>
            {status.text}
          </div>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={provider.enabled}
            data-testid={`toggle-enabled-${provider.preset}`}
            onChange={(event) => void setEnabled(provider.preset as Preset, event.target.checked)}
          />
          <span>启用</span>
        </label>
      </header>

      <div className="kv">
        <span>Base URL</span>
        <b>{provider.baseUrl}</b>
      </div>
      <div className="kv">
        <span>API Key</span>
        <b data-testid={`provider-key-${provider.preset}`}>
          {provider.key.configured ? `•••• •••• ${provider.key.last4 ?? ''}` : '未配置'}
        </b>
      </div>

      <div className="settings-keyrow">
        <input
          type="password"
          className="settings-input"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.key.configured ? '输入新 Key 以替换' : 'sk-…'}
          value={draft}
          data-testid={`input-key-${provider.preset}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
        />
        <button
          type="button"
          className="button"
          disabled={draft.trim().length < 8 || pending || saving}
          data-testid={`btn-save-key-${provider.preset}`}
          onClick={() => void save()}
        >
          保存 Key
        </button>
        {provider.key.configured ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={saving}
            onClick={() => void clearKey(provider.preset as Preset)}
          >
            清除
          </button>
        ) : null}
      </div>

      <div className="settings-testrow">
        <button
          type="button"
          className="button button--primary"
          disabled={testing || !provider.key.configured}
          title={provider.key.configured ? '用保存的 Key 测试连接' : '先保存 Key'}
          data-testid={`btn-test-${provider.preset}`}
          onClick={() => void test(provider.preset as Preset)}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {testResult ? (
          <span
            className="settings-testresult"
            data-ok={testResult.ok}
            data-testid={`test-result-${provider.preset}`}
          >
            {testResult.ok
              ? `${testResult.latencyMs}ms · ${testResult.model ?? '—'}`
              : `${testResult.error?.code ?? 'model_error'} · ${testResult.error?.message ?? ''}${
                  testResult.error?.advice ? `（${testResult.error.advice}）` : ''
                }`}
          </span>
        ) : provider.capabilities ? (
          <span className="settings-testresult" data-ok="true">
            上下文 {provider.capabilities.contextWindow.toLocaleString('zh-CN')} · 工具调用
            {provider.capabilities.tools ? '可用' : '不可用'}
          </span>
        ) : null}
      </div>

      <table className="settings-models">
        <thead>
          <tr>
            <th>模型</th>
            <th>上下文</th>
            <th>输入</th>
            <th>输出</th>
          </tr>
        </thead>
        <tbody>
          {provider.models.map((model) => (
            <tr key={model.id}>
              <td>{model.id}</td>
              <td>{model.capabilities.contextWindow.toLocaleString('zh-CN')}</td>
              <td>{formatPrice(model.capabilities.pricing.in)}</td>
              <td>{formatPrice(model.capabilities.pricing.out)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
