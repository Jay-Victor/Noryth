import { useEffect, useMemo, useState } from 'react'
import type { MemoryState } from '../../../shared/schema/memory'
import {
  MEMORY_ARCHIVE_BLOCK_LABELS,
  MEMORY_ARCHIVE_REASON_LABELS,
  MEMORY_KIND_LABELS
} from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 维护 → 归档（PHASE-22 M2-7 / UI-DESIGN §7.4）。
 *
 * 只展示主进程算好的候选（keeper、相似度、原因）；作者勾选后签发
 * author_confirm 再执行。归档是**软归档**：`status` 不变、行与向量都在、
 * 检索默认排除、可在这里恢复；不物理删除，也不触碰正文/revision。
 */

function similarityLabel(similarity: number): string {
  if (similarity >= 0.999999) return '文本相同'
  return `余弦 ${similarity.toFixed(3)}`
}

export function MemoryArchivePanel({ state }: { state: MemoryState }): React.JSX.Element {
  const archive = useMemory((store) => store.archive)
  const loading = useMemory((store) => store.archiveLoading)
  const busy = useMemory((store) => store.busy)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [restoreId, setRestoreId] = useState<string | null>(null)

  useEffect(() => {
    if (archive === null) void useMemory.getState().loadArchive()
  }, [archive])

  const archivedEntries = useMemo(
    () => state.entries.filter((entry) => entry.archivedAt !== null),
    [state.entries]
  )

  if (loading && archive === null) {
    return (
      <div className="pane-empty" data-testid="archive-loading">
        <h3>正在计算归档候选…</h3>
      </div>
    )
  }

  if (archive === null) {
    return (
      <div className="pane-empty" data-testid="archive-empty">
        <h3>归档候选不可用</h3>
        <p>只读或读取失败；请稍后重试。归档只碰经历类，不影响世界事实与关系。</p>
      </div>
    )
  }

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = archive.items.filter((item) => selected.has(item.id))

  return (
    <div className="memory-archive" data-testid="memory-archive">
      <div className="memory-archive__head">
        <span className="pane-header__meta" data-testid="archive-counts">
          活跃 {archive.counts.active} · 已归档 {archive.counts.archived} · 失效 {archive.counts.inactive} · 被取代{' '}
          {archive.counts.superseded}
        </span>
        <span className="pane-header__meta">
          规则：仅经历类，重要度 ≤ {archive.threshold.importanceMax.toFixed(2)}，同角色重复（相似度 ≥{' '}
          {archive.threshold.similarityMin.toFixed(2)} 或文本相同）
        </span>
      </div>

      <p className="write-note">
        归档是软归档：不删除、不改正文与 revision、不建 outbox；检索默认排除，可随时恢复。
        每批最多 {archive.batchLimit} 条。
      </p>

      {archive.items.length === 0 ? (
        <p className="write-note" data-testid="archive-candidates-empty">
          没有可归档的重复经历。事实、关系、认知与 pin 永不自动归档。
        </p>
      ) : (
        <>
          <div className="memory-archive__toolbar">
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="archive-select-all"
              onClick={() => setSelected(new Set(archive.items.slice(0, archive.batchLimit).map((item) => item.id)))}
            >
              全选
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="archive-select-clear"
              onClick={() => {
                setSelected(new Set())
                setConfirming(false)
              }}
            >
              清空
            </button>
            <span className="pane-header__meta" data-testid="archive-selected-count">
              已选 {chosen.length} 条
            </span>
            {confirming ? (
              <div className="memory-archive__confirm" data-testid="archive-confirm">
                <span>确认软归档 {chosen.length} 条？之后可在下方恢复。</span>
                <button
                  type="button"
                  className="plan-btn is-primary"
                  data-testid="archive-apply"
                  disabled={busy || chosen.length === 0}
                  onClick={() => {
                    void useMemory.getState().archiveSelected(chosen.map((item) => item.id))
                    setConfirming(false)
                    setSelected(new Set())
                  }}
                >
                  确认归档
                </button>
                <button
                  type="button"
                  className="plan-mini-btn"
                  data-testid="archive-cancel"
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="plan-btn"
                data-testid="archive-run"
                disabled={state.readOnly || busy || chosen.length === 0 || chosen.length > archive.batchLimit}
                onClick={() => setConfirming(true)}
              >
                归档所选
              </button>
            )}
          </div>

          <div className="memory-archive__list" data-testid="archive-candidates">
            {archive.items.map((item, index) => (
              <label
                key={item.id}
                className={`memory-archive__item${selected.has(item.id) ? ' is-selected' : ''}`}
                data-testid={`archive-candidate-${index}`}
                data-id={item.id}
              >
                <input
                  type="checkbox"
                  data-testid={`archive-candidate-check-${index}`}
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span className="memory-archive__who">{item.characterName}</span>
                <span className="memory-archive__text">{item.text}</span>
                <span className="pane-header__meta">
                  重要度 {item.importance.toFixed(2)} · seq {item.learnedSeq} · {similarityLabel(item.similarity)}
                </span>
                <span className="memory-archive__keeper" title={item.keeperText}>
                  保留：{item.keeperText}
                </span>
                <span className="memory-archive__reason">
                  {MEMORY_ARCHIVE_REASON_LABELS[item.reason] ?? item.reason}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      <div className="memory-archive__archived">
        <div className="write-subhead" data-testid="archive-archived-count">
          已归档 {archivedEntries.length} 条
        </div>
        {archivedEntries.length === 0 ? (
          <p className="write-note" data-testid="archive-archived-empty">
            还没有归档条目。
          </p>
        ) : (
          archivedEntries.map((entry, index) => (
            <div key={entry.id} className="memory-archive__item" data-testid={`archive-archived-${index}`} data-id={entry.id}>
              <span className="memory-archive__kind">{MEMORY_KIND_LABELS[entry.kind] ?? entry.kind}</span>
              <span className="memory-archive__who">{entry.characterName}</span>
              <span className="memory-archive__text">{entry.text}</span>
              <span className="pane-header__meta">
                {entry.archiveReason
                  ? (MEMORY_ARCHIVE_REASON_LABELS[entry.archiveReason] ?? entry.archiveReason)
                  : '已归档'}
                {entry.archivedAt ? ` · ${entry.archivedAt.slice(0, 10)}` : ''}
              </span>
              {restoreId === entry.id ? (
                <span className="memory-archive__confirm" data-testid={`archive-restore-confirm-${index}`}>
                  <span>恢复后重新参与检索（向量不重建）。确认？</span>
                  <button
                    type="button"
                    className="plan-btn"
                    data-testid={`archive-restore-run-${index}`}
                    disabled={busy}
                    onClick={() => {
                      void useMemory.getState().restoreArchived(entry.id)
                      setRestoreId(null)
                    }}
                  >
                    确认恢复
                  </button>
                  <button
                    type="button"
                    className="plan-mini-btn"
                    data-testid={`archive-restore-cancel-${index}`}
                    onClick={() => setRestoreId(null)}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="plan-mini-btn"
                  data-testid={`archive-restore-${index}`}
                  disabled={state.readOnly || busy}
                  onClick={() => setRestoreId(entry.id)}
                >
                  恢复
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {archive.items.length > 0 && chosen.length > archive.batchLimit ? (
        <p className="cost-error" data-testid="archive-batch-error">
          每批最多 {archive.batchLimit} 条：请取消一些勾选。
        </p>
      ) : null}

      <p className="write-note">
        skipped 的原因：{Object.values(MEMORY_ARCHIVE_BLOCK_LABELS).join('、')}。归档与恢复都会写 `memory_audit`。
      </p>
    </div>
  )
}
