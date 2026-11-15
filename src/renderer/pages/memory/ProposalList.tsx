import { useEffect, useState } from 'react'
import type { MemoryProposalState, MemoryState } from '../../../shared/schema/memory'
import { MEMORY_DOWNGRADE_LABELS, MEMORY_KIND_LABELS } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 提案视图（UI-DESIGN §7.4 提案）。
 *
 * 分组：角色（新增 / supersede / 关系）+ 世界事实。
 * 每条：kind、text、来源（章 / 拍 / 原文 quote）、importance、pin、
 * [接受] [编辑] [拒绝]。台词条目不提供「转为事实」——要改事实必须作者在
 * 世界状态里显式新增（PRD §5.4）。
 */

function downgradeLabel(reason: string): string {
  return MEMORY_DOWNGRADE_LABELS[reason] ?? reason
}

function ProposalRow({
  item,
  index,
  active
}: {
  item: MemoryProposalState
  index: number
  active: boolean
}): React.JSX.Element {
  const editing = useMemory((store) => (store.editing?.id === item.id ? store.editing : null))
  const busy = useMemory((store) => store.busy)
  const readOnly = useMemory((store) => store.state?.readOnly ?? false)
  const [draft, setDraft] = useState(item.text)

  useEffect(() => {
    if (editing) setDraft(editing.text)
  }, [editing])

  return (
    <article
      className={`memory-proposal${active ? ' is-active' : ''} is-${item.decision}`}
      data-testid={`memory-proposal-${index}`}
      data-kind={item.kind}
      data-decision={item.decision}
      onClick={() => useMemory.getState().focusProposal(item.id)}
    >
      <header className="memory-proposal__head">
        <span className="memory-proposal__kind">{MEMORY_KIND_LABELS[item.kind] ?? item.kind}</span>
        <span className="memory-proposal__who">{item.characterName ?? '世界状态'}</span>
        {item.truth ? (
          <span className="memory-proposal__truth" data-testid={`memory-truth-${index}`}>
            {item.truth === 'objective' ? '客观事实' : '声称'}
          </span>
        ) : null}
        {item.pinned ? <span className="memory-proposal__pin">pin</span> : null}
        <span className="memory-proposal__importance">重要度 {item.importance.toFixed(2)}</span>
        <span className="memory-proposal__spacer" />
        <span className="memory-proposal__decision" data-testid={`memory-decision-${index}`}>
          {item.decision === 'pending'
            ? '待决定'
            : item.decision === 'accept'
              ? '已接受'
              : item.decision === 'edit'
                ? '已编辑'
                : '已拒绝'}
        </span>
      </header>

      {editing ? (
        <div className="memory-proposal__editor">
          <textarea
            className="write-composer__input"
            data-testid="memory-edit-input"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="memory-proposal__editor-actions">
            <button
              type="button"
              className="plan-btn is-primary"
              data-testid="memory-edit-save"
              disabled={busy || draft.trim().length === 0}
              onClick={(event) => {
                event.stopPropagation()
                void useMemory.getState().saveEdit(draft)
              }}
            >
              保存编辑
            </button>
            <button
              type="button"
              className="plan-btn"
              data-testid="memory-edit-cancel"
              onClick={(event) => {
                event.stopPropagation()
                useMemory.getState().cancelEdit()
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="memory-proposal__text" data-testid={`memory-proposal-text-${index}`}>
          {item.text}
        </p>
      )}

      {item.editedText && item.editedText !== item.text ? (
        <p className="memory-proposal__edited" data-testid={`memory-edited-${index}`}>
          编辑后：{item.editedText}
        </p>
      ) : null}

      <blockquote className="memory-proposal__evidence" data-testid={`memory-evidence-${index}`}>
        <span className="memory-proposal__source mono">
          {item.evidence.beatId || item.sourceBeatId || '（无拍）'}
        </span>
        {item.evidence.quote}
      </blockquote>

      {item.downgrades.length > 0 ? (
        <p className="memory-proposal__downgraded" data-testid={`memory-downgraded-${index}`}>
          {item.downgrades.map(downgradeLabel).join('；')}
        </p>
      ) : null}

      <div className="memory-proposal__actions">
        <button
          type="button"
          className="plan-mini-btn"
          data-testid={`memory-accept-${index}`}
          disabled={readOnly || busy}
          onClick={(event) => {
            event.stopPropagation()
            void useMemory.getState().decide(item.id, 'accept')
          }}
        >
          接受
        </button>
        <button
          type="button"
          className="plan-mini-btn"
          data-testid={`memory-edit-${index}`}
          disabled={readOnly || busy}
          onClick={(event) => {
            event.stopPropagation()
            useMemory.getState().beginEdit(item.id, item.text)
          }}
        >
          编辑
        </button>
        <button
          type="button"
          className="plan-mini-btn is-danger"
          data-testid={`memory-reject-${index}`}
          disabled={readOnly || busy}
          onClick={(event) => {
            event.stopPropagation()
            void useMemory.getState().decide(item.id, 'reject')
          }}
        >
          拒绝
        </button>
      </div>
    </article>
  )
}

export function ProposalList({ state }: { state: MemoryState }): React.JSX.Element {
  const activeProposalId = useMemory((store) => store.activeProposalId)
  if (state.proposals.length === 0) {
    return (
      <div className="memory-proposals" data-testid="memory-proposals-empty">
        <div className="pane-empty">
          <h3>{state.running ? '正在抽取…' : '还没有固化提案'}</h3>
          <p>
            {state.jobStatus === 'queued'
              ? '定稿后已入队；点「生成提案」或等待自动抽取。'
              : '下一章定稿后，这里会出现固化提案。'}
          </p>
          {state.chapterId !== null ? (
            <button
              type="button"
              className="plan-btn"
              data-testid="memory-extract"
              disabled={state.readOnly || state.running || state.jobStatus === 'applied' || !state.model.ready}
              onClick={() => void useMemory.getState().extract()}
            >
              生成提案
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const groups = new Map<string, Array<{ item: MemoryProposalState; index: number }>>()
  state.proposals.forEach((item, index) => {
    const key = item.characterId ?? '__world__'
    const list = groups.get(key) ?? []
    list.push({ item, index })
    groups.set(key, list)
  })

  return (
    <div className="memory-proposals" data-testid="memory-proposals">
      {[...groups.entries()].map(([key, entries]) => {
        const title = key === '__world__' ? '世界事实' : (entries[0]?.item.characterName ?? key)
        return (
          <section key={key} className="memory-group">
            <h4 className="memory-group__title">
              {title}
              <span className="pane-header__meta">{entries.length}</span>
            </h4>
            {entries.map(({ item, index }) => (
              <ProposalRow
                key={item.id}
                item={item}
                index={index}
                active={activeProposalId === item.id}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}
