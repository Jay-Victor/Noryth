import { useEffect, useRef, useState } from 'react'
import type { MemoryChapterSummary, WorldProjectionState } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 世界时间线（PHASE-13 M1-3 / UI-DESIGN §7.4 世界状态）。
 *
 * 只做两件事：选章 + 拖叙事序；默认「当前章结束」（chapter.covered_until_seq）。
 * 时间线是**只读回放**：作者看全量（含秘密），切换「读者已知」只改过滤视图，
 * 不改变任何事实（限制只针对 Agent / 审批 / 检索上下文）。
 */
export function WorldTimeline({
  projection,
  chapters,
  defaultChapterId
}: {
  projection: WorldProjectionState
  chapters: MemoryChapterSummary[]
  defaultChapterId: string | null
}): React.JSX.Element {
  const [draftAsOf, setDraftAsOf] = useState(projection.asOf)
  const timer = useRef<number | null>(null)
  const readerOnly = useMemory((store) => store.readerOnly)
  const loading = useMemory((store) => store.projectionLoading)

  useEffect(() => {
    setDraftAsOf(projection.asOf)
  }, [projection.asOf, projection.chapterId])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const commit = (value: number): void => {
    setDraftAsOf(value)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void useMemory.getState().loadProjection({
        ...(projection.chapterId === null ? {} : { chapterId: projection.chapterId }),
        asOf: value
      })
    }, 150)
  }

  const chapterValue = projection.chapterId ?? ''

  return (
    <section className="world-timeline" data-testid="world-timeline">
      <div className="world-timeline__row">
        <label className="world-timeline__label" htmlFor="world-chapter-select">
          章
        </label>
        <select
          id="world-chapter-select"
          className="world-timeline__select"
          data-testid="world-chapter"
          value={chapterValue}
          onChange={(event) => {
            const value = event.target.value
            void useMemory.getState().loadProjection(value.length === 0 ? {} : { chapterId: value })
          }}
        >
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              第 {chapter.ord} 章 · {chapter.title}
            </option>
          ))}
          {defaultChapterId === null ? <option value="">项目水位</option> : null}
        </select>
        <span className="pane-header__meta" data-testid="world-coverage">
          {projection.chapterId === null
            ? `项目水位 ${projection.seqHead}`
            : `本章覆盖到 seq ${projection.coverage ?? 0}`}
        </span>
      </div>

      <div className="world-timeline__row">
        <label className="world-timeline__label" htmlFor="world-asof">
          as_of
        </label>
        <input
          id="world-asof"
          type="range"
          className="world-timeline__range"
          data-testid="world-asof"
          min={0}
          max={Math.max(projection.seqHead, 1)}
          step={1}
          value={draftAsOf}
          aria-valuetext={`叙事序 ${draftAsOf} / ${projection.seqHead}`}
          onChange={(event) => commit(Number(event.target.value))}
        />
        <span className="mono world-timeline__value" data-testid="world-asof-value">
          {draftAsOf} / {projection.seqHead}
        </span>
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="world-asof-current"
          disabled={loading}
          onClick={() => {
            if (projection.chapterId === null) {
              void useMemory.getState().loadProjection({ asOf: projection.seqHead })
              return
            }
            void useMemory.getState().loadProjection({ chapterId: projection.chapterId })
          }}
        >
          本章结束
        </button>
      </div>

      <div className="world-timeline__row">
        <label className="world-timeline__toggle" title="只看 reveal_seq 已揭示的公开事实">
          <input
            type="checkbox"
            data-testid="world-reader-only"
            checked={readerOnly}
            onChange={(event) => useMemory.getState().setReaderOnly(event.target.checked)}
          />
          读者已知
        </label>
        <span className="pane-header__meta world-timeline__counts" data-testid="world-counts">
          事实 {projection.counts.facts}（客观 {projection.counts.objective} / 声称{' '}
          {projection.counts.claim}）· 信念 {projection.counts.beliefs} · 关系{' '}
          {projection.counts.edges} · 更晚章节 {projection.counts.futureFacts} · 读者未知{' '}
          {projection.counts.notYetRevealed}
        </span>
      </div>

      <p className="write-note">
        「更晚章节」是 as_of 之后才产生的事实（还不存在）；「读者未知」是已存在但尚未揭示。
        两者不合并——审批看得到旧事实，旁白看不到。
      </p>
    </section>
  )
}
