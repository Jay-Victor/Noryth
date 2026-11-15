import { useEffect } from 'react'
import {
  INSPECTOR_STATE_LABELS,
  budgetNote,
  inspectorStateOf
} from '../../../shared/domain/world-view'
import type { WriteContextInspection, WriteState } from '../../../shared/schema/write'
import { useWrite } from '../../stores/write'

/**
 * 上下文检查器（PHASE-13 M1-17 / UI-DESIGN §2.6、§5.4）。
 *
 * 占用对话栅（≥1600 时也在这里，不覆盖正文）：只读展示这一拍**实际用过**的
 * 上下文块、token、裁剪原因、prefix hash 与预算条。
 *
 * 三条约束：
 * 1. 只读——不提供「改预算」按钮（预算在设置页）；
 * 2. 不给假精确值——显示「估算 + 上次实际 ratio」；
 * 3. 不回传被裁掉的正文，只给块 id / 类型 / token 数（诊断包与泄漏面都要小）。
 */

const LAYER_LABEL: Record<string, string> = {
  L0: 'L0 章级',
  L1: 'L1 场景级',
  L2: 'L2 发言者',
  L3: 'L3 旁观者'
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((value / total) * 100))
}

function BlockTable({ inspection }: { inspection: WriteContextInspection }): React.JSX.Element {
  if (inspection.blocks.length === 0) {
    return <p className="write-note">这一轮没有记录上下文块。</p>
  }
  return (
    <table className="context-table" data-testid="context-blocks">
      <thead>
        <tr>
          <th>层</th>
          <th>块</th>
          <th>角色</th>
          <th>tokens</th>
          <th>优先级</th>
        </tr>
      </thead>
      <tbody>
        {inspection.blocks.map((block, index) => (
          <tr
            key={block.id}
            data-testid={`context-block-${index}`}
            data-layer={block.layer}
            data-trimmed={block.trimmed ? '1' : '0'}
            className={block.trimmed ? 'is-stale' : ''}
          >
            <td>{LAYER_LABEL[block.layer] ?? block.layer}</td>
            <td className="mono context-table__id" title={block.id}>
              {block.id}
            </td>
            <td>
              {block.role}
              {block.refType ? ` · ${block.refType}` : ''}
              {block.trimmed ? ' · 已裁' : ''}
            </td>
            <td className="mono">{block.tokens}</td>
            <td className="mono">{block.priority}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ContextInspector({ state }: { state: WriteState }): React.JSX.Element {
  const inspection = useWrite((store) => store.inspection)
  const loading = useWrite((store) => store.inspectionLoading)
  const close = (): void => useWrite.getState().closeInspector()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const budgetUsed = percent(state.budget.spent, state.budget.limit)
  const contextUsed = inspection ? percent(inspection.totalTokens, state.budget.limit) : 0
  const inspectorState = inspectorStateOf({
    loading,
    found: inspection === null ? null : inspection.found
  })
  const note = budgetNote({
    exceeded: state.budget.exceeded,
    pauseText: state.pauseText,
    pauseReason: state.pauseReason
  })

  return (
    <div className="context-inspector" data-testid="context-inspector">
      <div className="context-inspector__head">
        <strong>上下文检查器</strong>
        <span className="pane-header__meta">
          {inspection?.found
            ? `${inspection.model ?? '—'} · ${inspection.turnId ?? ''}`
            : loading
              ? '读取中…'
              : '只读'}
        </span>
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="context-inspector-close"
          onClick={close}
        >
          Esc
        </button>
      </div>

      <div className="context-inspector__body">
        <section className="context-section">
          <h4 className="memory-group__title">
            本章预算
            <span className="pane-header__meta" data-testid="context-budget-text">
              {state.budget.spent} / {state.budget.limit} tokens
            </span>
          </h4>
          <div
            className={`context-bar${state.budget.exceeded ? ' is-over' : ''}`}
            data-testid="context-budget-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state.budget.limit}
            aria-valuenow={Math.min(state.budget.spent, state.budget.limit)}
          >
            <span className="context-bar__spent" style={{ width: `${budgetUsed}%` }} />
            {inspection ? (
              <span className="context-bar__context" style={{ width: `${contextUsed}%` }} />
            ) : null}
          </div>
          {note ? (
            <p
              className="write-note"
              data-testid={state.budget.exceeded ? 'context-budget-over' : 'context-pause'}
            >
              {note}
            </p>
          ) : null}
        </section>

        {inspectorState !== 'ready' || inspection === null ? (
          <p className="write-note" data-testid={inspectorState === 'missing' ? 'context-missing' : 'context-loading'}>
            {INSPECTOR_STATE_LABELS[inspectorState]}
          </p>
        ) : (
          <>
            <section className="context-section">
              <h4 className="memory-group__title">
                {INSPECTOR_STATE_LABELS.ready}
                <span className="pane-header__meta" data-testid="context-total">
                  估算 {inspection.estimate.totalTokens} tokens
                </span>
              </h4>
              <div className="context-facts">
                <span data-testid="context-asof">as_of {inspection.asOf ?? '—'}</span>
                <span data-testid="context-ratio">
                  上次实际 prompt {inspection.estimate.actualPromptTokens ?? '—'}
                  {inspection.estimate.ratio === null
                    ? ''
                    : ` · ratio ${inspection.estimate.ratio.toFixed(2)}`}
                </span>
                <span>
                  输出 {inspection.usage.tokensOut ?? '—'} · 费用 ¥
                  {inspection.usage.costCny.toFixed(4)}
                </span>
                <span>延迟 {inspection.usage.latencyMs ?? '—'}ms</span>
                <span>首字 {inspection.usage.firstTokenMs ?? '—'}ms</span>
                <span className="mono" title={inspection.prefixHash ?? ''} data-testid="context-prefix">
                  prefix {inspection.prefixHash ? inspection.prefixHash.slice(0, 12) : '—'}
                </span>
              </div>
              {inspection.degraded.length > 0 ? (
                <p className="write-note" data-testid="context-degraded">
                  降级：{inspection.degraded.join('、')}
                </p>
              ) : null}
              {inspection.trimmed.length > 0 ? (
                <p className="write-note" data-testid="context-trimmed">
                  裁剪 {inspection.trimmed.length} 块：{inspection.trimmed.join('、')}
                  （只显示块 ID，不展开正文）
                </p>
              ) : (
                <p className="write-note">没有触发裁剪。</p>
              )}
            </section>

            <section className="context-section">
              <h4 className="memory-group__title">
                块清单
                <span className="pane-header__meta">{inspection.blocks.length} 块</span>
              </h4>
              <BlockTable inspection={inspection} />
            </section>
          </>
        )}
      </div>
    </div>
  )
}
