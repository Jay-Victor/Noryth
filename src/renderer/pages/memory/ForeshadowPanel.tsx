import { useState } from 'react'
import { foreshadowDistanceText } from '../../../shared/domain/blueprint-view'
import type { ForeshadowState, ForeshadowView } from '../../../shared/schema/foreshadow'
import { useMemory } from '../../stores/memory'

/**
 * 伏笔面板（PHASE-15 M1-10，挂记忆台「伏笔」tab）。
 *
 * 只做作者标注与节奏提示：埋设章、计划回收章、距离、超期。
 * 不产生任何阻断，也不自动判定「该收还是不该收」——那是作者的判断。
 */

export function ForeshadowPanel({ state }: { state: ForeshadowState }): React.JSX.Element {
  const store = useMemory()
  const [text, setText] = useState('')
  const [planted, setPlanted] = useState(state.chapterId ?? state.chapters[0]?.id ?? '')
  const [planned, setPlanned] = useState('')
  const [payoffDraft, setPayoffDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const chapters = state.chapters
  const open = state.items.filter((item) => item.status === 'open')
  const closed = state.items.filter((item) => item.status === 'closed')

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || planted.length === 0) return
    setBusy(true)
    try {
      const created = await store.createForeshadow({
        text: trimmed,
        plantedChapterId: planted,
        ...(planned.length === 0 ? {} : { plannedPayoffChapterId: planned })
      })
      if (created) {
        setText('')
        setPlanned('')
      }
    } finally {
      setBusy(false)
    }
  }

  const close = async (item: ForeshadowView): Promise<void> => {
    const target = payoffDraft[item.id] ?? state.chapterId ?? chapters[0]?.id ?? ''
    if (target.length === 0) return
    setBusy(true)
    try {
      await store.closeForeshadow(item.id, target)
    } finally {
      setBusy(false)
    }
  }

  const renderRow = (item: ForeshadowView): React.JSX.Element => (
    <div key={item.id} className={`foreshadow-row is-${item.status}`} data-testid={`foreshadow-row-${item.id}`}>
      <span className={`foreshadow-status is-${item.status}`}>{item.status === 'open' ? '未回收' : '已回收'}</span>
      <span className="foreshadow-text">{item.text}</span>
      <span className="pane-header__meta">
        埋设：{item.plantedOrd === null ? '—' : `第 ${item.plantedOrd} 章`}
        {item.plannedPayoffOrd === null ? '' : ` · 计划第 ${item.plannedPayoffOrd} 章回收`}
      </span>
      <span className={`foreshadow-distance${item.overdue ? ' is-overdue' : ''}`} data-testid={`foreshadow-distance-${item.id}`}>
        {foreshadowDistanceText(item)}
      </span>
      {item.status === 'open' ? (
        <span className="foreshadow-actions">
          <select
            data-testid={`foreshadow-payoff-${item.id}`}
            value={payoffDraft[item.id] ?? state.chapterId ?? chapters[0]?.id ?? ''}
            disabled={state.readOnly || busy}
            onChange={(event) => setPayoffDraft({ ...payoffDraft, [item.id]: event.target.value })}
          >
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                第 {chapter.ord} 章 {chapter.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="plan-mini-btn"
            data-testid={`foreshadow-close-${item.id}`}
            disabled={state.readOnly || busy}
            onClick={() => void close(item)}
          >
            标记回收
          </button>
        </span>
      ) : (
        <span className="foreshadow-actions">
          <button
            type="button"
            className="plan-mini-btn"
            data-testid={`foreshadow-reopen-${item.id}`}
            disabled={state.readOnly || busy}
            onClick={() => void store.reopenForeshadow(item.id)}
          >
            重新打开
          </button>
        </span>
      )}
      <button
        type="button"
        className="plan-mini-btn is-danger"
        data-testid={`foreshadow-remove-${item.id}`}
        disabled={state.readOnly || busy}
        onClick={() => void store.removeForeshadow(item.id)}
      >
        删除
      </button>
    </div>
  )

  return (
    <div className="memory-foreshadows" data-testid="foreshadow-panel">
      <header className="plan-coverage__head">
        <h3>伏笔</h3>
        <span className="pane-header__meta" data-testid="foreshadow-counts">
          未回收 {state.openCount} · 已回收 {state.closedCount}
        </span>
        <label className="plan-meta__label" htmlFor="foreshadow-chapter">
          距离基准
          <select
            id="foreshadow-chapter"
            data-testid="foreshadow-chapter"
            value={state.chapterId ?? ''}
            disabled={state.chapters.length === 0}
            onChange={(event) => void store.loadForeshadows(event.target.value)}
          >
            {state.chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                第 {chapter.ord} 章
              </option>
            ))}
          </select>
        </label>
        <span className="plan-node-meta">只报节奏，不报逻辑错误；不阻断任何闸门</span>
      </header>

      <div className="foreshadow-create" data-testid="foreshadow-create">
        <input
          className="plan-meta__text"
          data-testid="foreshadow-create-text"
          placeholder="例如：匣子底部的林家族徽"
          value={text}
          disabled={state.readOnly}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit()
          }}
        />
        <select
          data-testid="foreshadow-create-planted"
          value={planted}
          disabled={state.readOnly}
          onChange={(event) => setPlanted(event.target.value)}
        >
          {chapters.length === 0 ? <option value="">（没有章）</option> : null}
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              埋设：第 {chapter.ord} 章 {chapter.title}
            </option>
          ))}
        </select>
        <select
          data-testid="foreshadow-create-planned"
          value={planned}
          disabled={state.readOnly}
          onChange={(event) => setPlanned(event.target.value)}
        >
          <option value="">（不设计划回收章）</option>
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              计划第 {chapter.ord} 章回收
            </option>
          ))}
        </select>
        <button
          type="button"
          className="plan-btn"
          data-testid="foreshadow-create-submit"
          disabled={state.readOnly || busy || text.trim().length === 0}
          onClick={() => void submit()}
        >
          标注伏笔
        </button>
      </div>

      {state.items.length === 0 ? (
        <p className="plan-coverage__state" data-testid="foreshadow-empty">
          还没有伏笔。埋一条线索，之后靠「已 N 章未回收」提醒自己别忘。
        </p>
      ) : (
        <div className="foreshadow-list" data-testid="foreshadow-list">
          <div className="plan-subhead">未回收 · {open.length}</div>
          {open.length === 0 ? <p className="plan-note">没有未回收伏笔。</p> : open.map(renderRow)}
          {closed.length > 0 ? (
            <>
              <div className="plan-subhead">已回收 · {closed.length}</div>
              {closed.map(renderRow)}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
