import { useState } from 'react'
import { WRITE_STATUS_LABELS, type WriteBeatState } from '../../../shared/schema/write'

/**
 * 拍卡（UI-DESIGN §5.4 / §9.2）：
 * 头部 sticky：拍号、speaker、状态、字数、耗时；正文只显示 body；
 * 依据 chips；轨迹折叠；元信息（模型 / degraded / token 由 trace 提供）。
 * trace 只给作者看，不进入下一轮。
 */

const GROUNDING_LABELS: Record<string, string> = {
  memory: '记忆',
  belief: '信念',
  fact: '事实',
  canon: '设定',
  outline: '纲要',
  manuscript: '定稿'
}

export function BeatCard({
  beat,
  traceRef,
  onClose
}: {
  beat: WriteBeatState
  traceRef: string | null
  onClose: () => void
}): React.JSX.Element {
  const [openGroundedId, setOpenGroundedId] = useState<string | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)

  return (
    <div className="write-beat-card" data-testid={`write-beat-card-${beat.id}`}>
      <div className="write-beat-card__head">
        <span className="mono">{beat.id.replace(/^bt_/, 'bt_')}</span>
        <span>{beat.speakerName}</span>
        <span className={`write-status is-${beat.status}`} data-status={beat.status}>
          {WRITE_STATUS_LABELS[beat.status]}
        </span>
        <span className="write-beat-card__meta">
          {beat.wordCount} 字{beat.maxWords ? ` / 上限 ${beat.maxWords}` : ''}
        </span>
        <button type="button" className="plan-mini-btn" onClick={onClose}>
          收起
        </button>
      </div>

      <p className="write-beat-card__body">{beat.body}</p>

      <div className="write-beat-card__foot">
        <button
          type="button"
          className="write-chip is-muted"
          data-testid={`write-grounding-${beat.id}`}
          disabled={beat.grounding.length === 0}
          onClick={() => setOpenGroundedId(openGroundedId === null ? 'all' : null)}
        >
          依据 {beat.grounding.length}
        </button>
        <button
          type="button"
          className="write-chip is-muted"
          data-testid={`write-trace-${beat.id}`}
          disabled={traceRef === null}
          onClick={() => setTraceOpen((value) => !value)}
        >
          思考与工具调用 {traceRef ? '···' : '（无）'}
        </button>
        {beat.authorEdited ? <span className="write-badge is-edited">已手改</span> : null}
        {beat.status === 'stale' ? <span className="write-badge is-stale">上游已改</span> : null}
      </div>

      {openGroundedId !== null ? (
        <ul className="write-grounding-list" data-testid={`write-grounding-list-${beat.id}`}>
          {beat.grounding.length === 0 ? (
            <li className="write-note">本拍没有依据；可能是检索为空（degraded）。</li>
          ) : (
            beat.grounding.map((item) => (
              <li key={`${item.type}:${item.id}`} data-testid={`write-grounding-${item.type}-${item.id}`}>
                <span className={`write-chip is-${item.type}`}>{GROUNDING_LABELS[item.type] ?? item.type}</span>
                <span className="mono">{item.id}</span>
                <q>{item.quote}</q>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {traceOpen && traceRef ? (
        <p className="write-note mono" data-testid={`write-trace-path-${beat.id}`}>
          {traceRef}（轨迹只归档，不进入下一轮）
        </p>
      ) : null}
    </div>
  )
}
