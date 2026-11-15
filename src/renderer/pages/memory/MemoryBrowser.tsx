import { useMemo, useState } from 'react'
import type { MemoryEntryState, MemoryState } from '../../../shared/schema/memory'
import { MEMORY_KIND_LABELS, MEMORY_STATUS_LABELS } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 角色记忆浏览（UI-DESIGN §7.4 角色记忆）。
 *
 * 过滤：角色 / 类型 / 章节 / 状态 / pin。
 * 详情：原文、来源（章 + 拍 + revision）、learned_seq、有效期、审计提示。
 * [标记错误] → 软失效（写 inactive + 审计），不物理删除。
 * [按章重建] 是 M1，本阶段禁用并在标题里说明。
 */

function detailOf(entry: MemoryEntryState): string {
  const validity =
    entry.validToSeq === null ? `自 ${entry.validFromSeq ?? entry.learnedSeq} 起有效` : `有效至 ${entry.validToSeq}`
  return `${entry.sourceChapterTitle} · 拍 ${entry.sourceBeatId ?? '—'} · ${validity} · ${entry.embeddingModel}`
}

export function MemoryBrowser({ state }: { state: MemoryState }): React.JSX.Element {
  const filters = useMemory((store) => store.filters)
  const setFilters = useMemory((store) => store.setFilters)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [recallQuery, setRecallQuery] = useState('账本 祠堂')
  const [recallCharacter, setRecallCharacter] = useState('')
  const recall = useMemory((store) => store.recall)
  const busy = useMemory((store) => store.busy)

  const characters = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of state.entries) map.set(entry.characterId, entry.characterName)
    return [...map.entries()]
  }, [state.entries])

  const entries = useMemo(
    () =>
      state.entries.filter((entry) => {
        if (filters.characterId !== null && entry.characterId !== filters.characterId) return false
        if (filters.kind !== 'all' && entry.kind !== filters.kind) return false
        if (filters.status !== 'all' && entry.status !== filters.status) return false
        if (filters.pinnedOnly && !entry.pinned) return false
        return true
      }),
    [state.entries, filters]
  )

  const filtered = entries
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null

  if (state.entries.length === 0) {
    return (
      <div className="memory-browser" data-testid="memory-browser-empty">
        <div className="pane-empty">
          <h3>还没有固化记忆</h3>
          <p>定稿后在「提案」里逐条接受，再点「应用 G7」；这里会按角色显示。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-browser" data-testid="memory-browser">
      <div className="memory-filters">
        <label>
          角色
          <select
            data-testid="memory-filter-character"
            value={filters.characterId ?? ''}
            onChange={(event) =>
              setFilters({ characterId: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">全部</option>
            {characters.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          类型
          <select
            data-testid="memory-filter-kind"
            value={filters.kind}
            onChange={(event) => setFilters({ kind: event.target.value as typeof filters.kind })}
          >
            <option value="all">全部</option>
            <option value="experience">经历</option>
            <option value="fact">事实</option>
            <option value="relationship">关系</option>
            <option value="cognition">认知</option>
          </select>
        </label>
        <label>
          状态
          <select
            data-testid="memory-filter-status"
            value={filters.status}
            onChange={(event) => setFilters({ status: event.target.value as typeof filters.status })}
          >
            <option value="all">全部</option>
            <option value="active">生效</option>
            <option value="inactive">已失效</option>
            <option value="superseded">被取代</option>
          </select>
        </label>
        <label className="memory-filters__check">
          <input
            type="checkbox"
            data-testid="memory-filter-pinned"
            checked={filters.pinnedOnly}
            onChange={(event) => setFilters({ pinnedOnly: event.target.checked })}
          />
          只看 pin
        </label>
        <span className="pane-header__meta" data-testid="memory-entry-count">
          {filtered.length} / {state.entries.length}
        </span>
      </div>

      <div className="memory-browser__body">
        <div className="memory-entry-list" data-testid="memory-entries">
          {filtered.length === 0 ? (
            <p className="write-note">过滤后没有条目。</p>
          ) : (
            filtered.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                className={`memory-entry${selected?.id === entry.id ? ' is-active' : ''}`}
                data-testid={`memory-entry-${index}`}
                data-status={entry.status}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="memory-entry__kind">{MEMORY_KIND_LABELS[entry.kind] ?? entry.kind}</span>
                <span className="memory-entry__who">{entry.characterName}</span>
                <span className="memory-entry__text">{entry.text}</span>
                {entry.pinned ? <span className="memory-entry__pin">pin</span> : null}
                <span className="memory-entry__status" data-status={entry.status}>
                  {MEMORY_STATUS_LABELS[entry.status] ?? entry.status}
                </span>
              </button>
            ))
          )}
        </div>

        {selected ? (
          <aside className="memory-detail" data-testid="memory-detail">
            <h4>记忆详情</h4>
            <p className="memory-detail__text" data-testid="memory-detail-text">
              {selected.text}
            </p>
            <dl className="memory-detail__meta">
              <dt>角色</dt>
              <dd>{selected.characterName}</dd>
              <dt>类型</dt>
              <dd>{MEMORY_KIND_LABELS[selected.kind] ?? selected.kind}</dd>
              <dt>来源</dt>
              <dd data-testid="memory-detail-source">{detailOf(selected)}</dd>
              <dt>revision</dt>
              <dd className="mono">{selected.sourceRevisionId}</dd>
              <dt>learned_seq</dt>
              <dd>{selected.learnedSeq}</dd>
              <dt>重要度</dt>
              <dd>{selected.importance.toFixed(2)}</dd>
              <dt>状态</dt>
              <dd>{MEMORY_STATUS_LABELS[selected.status] ?? selected.status}</dd>
            </dl>

            <div className="memory-detail__actions">
              <input
                className="memory-detail__reason"
                data-testid="memory-invalidate-reason"
                placeholder="标记错误的原因（写进审计）"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <button
                type="button"
                className="plan-btn"
                data-testid="memory-invalidate"
                disabled={state.readOnly || busy || reason.trim().length < 2 || selected.status === 'inactive'}
                onClick={() => {
                  void useMemory.getState().invalidate(selected.id, reason.trim())
                  setReason('')
                }}
              >
                标记错误
              </button>
              <button
                type="button"
                className="plan-btn"
                data-testid="memory-rebuild"
                disabled
                title="按章重建是 M1；本阶段只提供来源追溯与软失效"
              >
                按章重建（M1）
              </button>
            </div>
          </aside>
        ) : null}
      </div>

      <section className="memory-recall" data-testid="memory-recall">
        <h4 className="memory-group__title">召回探针</h4>
        <p className="write-note">
          用真实检索管线按角色取记忆：向量 + 关键词 + pinned。跨角色永不命中。
        </p>
        <div className="memory-recall__bar">
          <select
            data-testid="memory-recall-character"
            value={recallCharacter}
            onChange={(event) => setRecallCharacter(event.target.value)}
          >
            <option value="">选角色</option>
            {characters.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <input
            className="memory-recall__query"
            data-testid="memory-recall-query"
            value={recallQuery}
            onChange={(event) => setRecallQuery(event.target.value)}
            placeholder="查询词"
          />
          <button
            type="button"
            className="plan-btn"
            data-testid="memory-recall-run"
            disabled={recallCharacter === '' || recallQuery.trim().length === 0}
            onClick={() => void useMemory.getState().runRecall(recallCharacter, recallQuery.trim())}
          >
            检索
          </button>
        </div>
        {recall ? (
          <div className="memory-recall__result" data-testid="memory-recall-result">
            <div className="pane-header__meta">
              {recall.items.length + recall.pinned.length} 条 · as_of {recall.asOf} · {recall.model} ·{' '}
              {recall.empty ? '空结果' : recall.degraded}
            </div>
            {[...recall.items, ...recall.pinned].map((item, index) => (
              <div key={`${item.memoryId}-${index}`} className="memory-recall__item" data-testid={`memory-recall-item-${index}`}>
                <span className="mono">{item.channel}</span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
