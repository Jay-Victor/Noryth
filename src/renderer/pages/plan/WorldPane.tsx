import { useState } from 'react'
import type { PlanFactView } from '../../../shared/schema/plan'
import { FieldEditor } from './FieldEditor'

export interface WorldPaneProps {
  facts: PlanFactView[]
  locked: boolean
  onSave: (input: {
    factId: string
    subject: string
    predicate: string
    object: string
    visibility: 'public' | 'secret'
  }) => Promise<void>
  onAdd: (input: {
    subject: string
    predicate: string
    object: string
    visibility: 'public' | 'secret'
  }) => Promise<boolean>
  onRemove: (factId: string) => Promise<void>
}

/** 世界观初值（PHASE-06 E4）：G1 时写入 world_fact；secret 只给作者与审批。 */
export function WorldPane({ facts, locked, onSave, onAdd, onRemove }: WorldPaneProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(facts[0]?.id ?? null)
  const selected = facts.find((fact) => fact.id === selectedId) ?? facts[0] ?? null

  return (
    <div className="plan-world" data-testid="world-pane">
      <aside className="plan-world__list">
        <div className="plan-tree-head">
          <span>世界初值 · {facts.length}</span>
          {!locked ? (
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="world-add"
              onClick={() => {
                void onAdd({ subject: '新条目', predicate: '设定', object: '待填', visibility: 'public' })
                setSelectedId(null)
              }}
            >
              ＋条目
            </button>
          ) : null}
        </div>
        {facts.length === 0 ? (
          <p className="plan-tree-empty">还没有世界初值。G1 时会写进世界状态。</p>
        ) : (
          facts.map((fact) => (
            <button
              key={fact.id}
              type="button"
              className={`plan-world-row${fact.id === selected?.id ? ' is-active' : ''}`}
              data-testid={`world-fact-${fact.id}`}
              onClick={() => setSelectedId(fact.id)}
            >
              <span className="plan-world-subject">{fact.subject}</span>
              <span className="plan-world-predicate">{fact.predicate}</span>
              <span className={`plan-visibility is-${fact.visibility}`}>{fact.visibility === 'secret' ? '密' : '公开'}</span>
            </button>
          ))
        )}
      </aside>

      <div className="plan-world__detail">
        {selected ? (
          <>
            <header className="plan-node-head">
              <span className="plan-kind-badge is-fact">初值</span>
              <span className="plan-node-meta">{selected.status === 'applied' ? '已写入世界状态' : '草案'}</span>
              {!locked && selected.status === 'draft' ? (
                <button
                  type="button"
                  className="plan-mini-btn is-danger"
                  data-testid="world-remove"
                  onClick={() => {
                    void onRemove(selected.id)
                    setSelectedId(null)
                  }}
                >
                  删除
                </button>
              ) : null}
            </header>
            <FieldEditor
              label="主体"
              value={selected.subject}
              disabled={locked || selected.status === 'applied'}
              testId="world-subject"
              onSave={(value) =>
                onSave({
                  factId: selected.id,
                  subject: value,
                  predicate: selected.predicate,
                  object: selected.object,
                  visibility: selected.visibility
                })
              }
            />
            <FieldEditor
              label="谓词"
              value={selected.predicate}
              disabled={locked || selected.status === 'applied'}
              testId="world-predicate"
              onSave={(value) =>
                onSave({
                  factId: selected.id,
                  subject: selected.subject,
                  predicate: value,
                  object: selected.object,
                  visibility: selected.visibility
                })
              }
            />
            <FieldEditor
              label="值"
              multiline
              rows={2}
              value={selected.object}
              disabled={locked || selected.status === 'applied'}
              testId="world-object"
              onSave={(value) =>
                onSave({
                  factId: selected.id,
                  subject: selected.subject,
                  predicate: selected.predicate,
                  object: value,
                  visibility: selected.visibility
                })
              }
            />
            <label className="plan-field">
              <span className="plan-field__label">
                可见性
                {selected.visibility === 'secret' ? <span className="plan-field__hint">仅作者与审批可见</span> : null}
              </span>
              <select
                value={selected.visibility}
                disabled={locked || selected.status === 'applied'}
                data-testid="world-visibility"
                onChange={(event) =>
                  void onSave({
                    factId: selected.id,
                    subject: selected.subject,
                    predicate: selected.predicate,
                    object: selected.object,
                    visibility: event.target.value === 'secret' ? 'secret' : 'public'
                  })
                }
              >
                <option value="public">public · 公开</option>
                <option value="secret">secret · 仅作者与审批</option>
              </select>
            </label>
          </>
        ) : (
          <div className="pane-empty">
            <h3>还没有条目</h3>
            <p>世界初值会在 G1 时写入世界状态；secret 条目不会进入角色或旁白上下文。</p>
          </div>
        )}
      </div>
    </div>
  )
}
