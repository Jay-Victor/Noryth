import { useEffect, useMemo, useState } from 'react'
import type { Preset } from '../../../shared/schema/model'
import type { BindingChange, BindingRow } from '../../../shared/schema/settings'
import { useSettings } from '../../stores/settings'

/**
 * 逐 Agent 绑定（UI-DESIGN §8.4 / PHASE-10 I2）。
 *
 * 继承链在矩阵里已经解析好：每行显示「生效绑定 + 来源」。
 * 这个组件只在本地收集改动，点「保存绑定」一次提交成一批；
 * 保存后主进程写审计，可回滚上一套。改绑定只影响下一个 job。
 */

interface DraftEntry {
  provider: Preset
  model: string
}

const SOURCE_TEXT: Record<string, string> = {
  instance: '角色实例覆盖',
  agent: 'Agent 覆盖',
  project: '项目默认',
  preset: '预设默认'
}

function sameAsRow(row: BindingRow, entry: DraftEntry): boolean {
  return row.provider === entry.provider && row.model === entry.model
}

export function BindingTable(): React.JSX.Element {
  const bindings = useSettings((state) => state.bindings)
  const saving = useSettings((state) => state.saving)
  const saveBindings = useSettings((state) => state.saveBindings)
  const rollback = useSettings((state) => state.rollback)
  const [draft, setDraft] = useState<Record<string, DraftEntry>>({})
  const [showAudit, setShowAudit] = useState(false)
  const audit = useSettings((state) => state.audit)

  const rows = useMemo(() => bindings?.rows ?? [], [bindings])
  const modelOptions = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const provider of bindings?.providers ?? []) {
      map.set(provider.preset, [])
    }
    for (const row of [...rows, ...(bindings?.characters ?? []).map((entry) => entry.effective)]) {
      const list = map.get(row.provider) ?? []
      if (!list.includes(row.model)) list.push(row.model)
      map.set(row.provider, list)
    }
    return map
  }, [bindings, rows])

  useEffect(() => {
    // 重新载入绑定后丢弃过期草稿，避免把旧行写回去。
    setDraft({})
  }, [bindings?.projectId, bindings?.auditCount])

  if (!bindings) {
    return (
      <section className="side-card">
        <h2>Agent 绑定</h2>
        <p>打开一个项目后可以逐 Agent 绑定模型。</p>
      </section>
    )
  }

  const testedProviders = new Set(bindings.providers.filter((provider) => provider.connected).map((provider) => provider.preset))
  const changes: BindingChange[] = Object.entries(draft)
    .filter(([agentKey, entry]) => {
      const row = rows.find((candidate) => candidate.agentKey === agentKey)
      if (row) return !sameAsRow(row, entry)
      const character = bindings.characters.find((candidate) => candidate.characterId === agentKey.slice('character:'.length))
      return character ? !sameAsRow(character.effective, entry) : true
    })
    .map(([agentKey, entry]) => ({ agentKey, provider: entry.provider, model: entry.model }))
  const blocked = changes.some((change) => !testedProviders.has(change.provider))

  const update = (agentKey: string, entry: DraftEntry): void => {
    setDraft((current) => ({ ...current, [agentKey]: entry }))
  }

  const reset = (agentKey: string): void => {
    setDraft((current) => {
      const next = { ...current }
      delete next[agentKey]
      return next
    })
  }

  const effective = (row: BindingRow): DraftEntry => draft[row.agentKey] ?? { provider: row.provider, model: row.model }

  const renderRow = (row: BindingRow): React.JSX.Element => {
    const entry = effective(row)
    const models = modelOptions.get(entry.provider) ?? []
    return (
      <tr key={row.agentKey} data-testid={`binding-row-${row.agentKey}`}>
        <td>
          <div className="settings-binding__label">{row.label}</div>
          <div className="settings-binding__source">{SOURCE_TEXT[row.source] ?? row.source}</div>
        </td>
        <td>
          <select
            className="settings-select"
            value={entry.provider}
            data-testid={`binding-provider-${row.agentKey}`}
            onChange={(event) => {
              const provider = event.target.value as Preset
              const first = modelOptions.get(provider)?.[0] ?? ''
              update(row.agentKey, { provider, model: first })
            }}
          >
            {bindings.providers.map((provider) => (
              <option key={provider.preset} value={provider.preset}>
                {provider.label}
                {provider.connected ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </td>
        <td>
          <select
            className="settings-select"
            value={entry.model}
            data-testid={`binding-model-${row.agentKey}`}
            onChange={(event) => update(row.agentKey, { provider: entry.provider, model: event.target.value })}
          >
            {(models.length > 0 ? models : [entry.model]).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </td>
        <td className="settings-binding__meta">
          {row.recentlyUsedAt ? row.recentlyUsedAt.slice(0, 16).replace('T', ' ') : '—'}
        </td>
        <td className="settings-binding__meta">
          {draft[row.agentKey] ? (
            <button type="button" className="button button--ghost" onClick={() => reset(row.agentKey)}>
              撤销
            </button>
          ) : (
            `v${row.version}`
          )}
        </td>
      </tr>
    )
  }

  return (
    <section className="side-card">
      <header className="settings-section__head">
        <div>
          <h2>Agent 绑定</h2>
          <p className="settings-hint">
            继承顺序：角色实例 → 角色 → 项目默认；其他 Agent 直接继承项目默认。改绑定只影响下一拍，正在生成的任务不换模型。
          </p>
        </div>
        <div className="settings-section__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={!bindings.canRollback || saving}
            title={bindings.canRollback ? '回滚到上一套绑定' : '没有可回滚的绑定变更'}
            data-testid="btn-rollback-bindings"
            onClick={() => void rollback(bindings.projectId)}
          >
            回滚上一套
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={changes.length === 0 || blocked || saving}
            title={
              blocked
                ? '目标提供方还没有通过测试连接'
                : changes.length === 0
                  ? '还没有改动'
                  : '保存后写入审计，下一拍生效'
            }
            data-testid="btn-save-bindings"
            onClick={() => void saveBindings(bindings.projectId, changes)}
          >
            保存绑定{changes.length > 0 ? `（${changes.length}）` : ''}
          </button>
        </div>
      </header>

      <table className="settings-bindings">
        <thead>
          <tr>
            <th>Agent</th>
            <th>提供方</th>
            <th>模型</th>
            <th>最近使用</th>
            <th>版本</th>
          </tr>
        </thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>

      {bindings.characters.length > 0 ? (
        <details className="settings-characters" data-testid="binding-characters">
          <summary>角色实例（{bindings.characters.length}）</summary>
          <table className="settings-bindings">
            <thead>
              <tr>
                <th>角色</th>
                <th>提供方</th>
                <th>模型</th>
                <th>来源</th>
                <th>版本</th>
              </tr>
            </thead>
            <tbody>
              {bindings.characters.map((character) => {
                const key = `character:${character.characterId}`
                const row = character.override ?? character.effective
                return renderRow({ ...row, agentKey: key, label: character.name })
              })}
            </tbody>
          </table>
        </details>
      ) : null}

      <div className="settings-audit">
        <button type="button" className="button button--ghost" onClick={() => setShowAudit((value) => !value)}>
          {showAudit ? '收起审计' : `绑定审计（${bindings.auditCount}）`}
        </button>
        {showAudit ? (
          <ul className="settings-audit__list">
            {audit.length === 0 ? <li>还没有绑定变更。</li> : null}
            {audit
              .slice(-8)
              .reverse()
              .map((entry) => (
                <li key={entry.id}>
                  <b>{entry.agentKey}</b> {entry.oldProvider ? `${entry.oldProvider}/${entry.oldModel}` : '（未绑定）'} →{' '}
                  {entry.newProvider === '—' ? '（删除）' : `${entry.newProvider}/${entry.newModel}`}
                  <span>{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}
