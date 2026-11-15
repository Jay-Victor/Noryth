import { useEffect, useState } from 'react'
import { ISSUE_TYPE_LABELS } from '../../../shared/schema/report'
import { useReview } from '../../stores/review'

/**
 * G6 定稿确认框（PHASE-08 §5.3 / UI-DESIGN §6.4）。
 *
 * 只有这里能把「有阻断 / 有未复检改动」越过：勾选「我已复核」并写明理由，
 * 写进 G6 的 gate_record。定稿没有快捷键，也不出现在创作台。
 */
export function FinalizeDialog(): React.JSX.Element | null {
  const dialog = useReview((store) => store.finalizeDialog)
  const busy = useReview((store) => store.busy)
  const [ackBlocking, setAckBlocking] = useState(false)
  const [ackUnreviewed, setAckUnreviewed] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!dialog) return
    setAckBlocking(dialog.preview.blocking.length === 0 && dialog.preview.unreviewedCount === 0)
    setAckUnreviewed(false)
    setReason('')
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') useReview.getState().closeFinalize()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialog])

  if (!dialog) return null
  const preview = dialog.preview
  const needsBlockingAck = preview.blocking.length > 0 || preview.rounds === 0
  const needsUnreviewedAck = preview.unreviewedCount > 0
  const canConfirm =
    (!needsBlockingAck || ackBlocking) && (!needsUnreviewedAck || ackUnreviewed) && !busy && !preview.alreadyFinalized

  return (
    <div className="plan-modal" role="dialog" aria-modal="true" data-testid="review-finalize-dialog">
      <div className="plan-modal__card review-finalize">
        <h3>定稿本章</h3>
        <p>
          定稿会冻结当前草稿快照（{preview.finalRevisionId ?? '新 final revision'}），正文从此不可修改；
          记忆抽取任务会入队（阶段 09 才执行）。
        </p>

        {preview.blocking.length > 0 ? (
          <div className="review-finalize__block" data-testid="review-finalize-blocking">
            <strong>还有 {preview.blocking.length} 条阻断</strong>
            <ul>
              {preview.blocking.slice(0, 3).map((issue) => (
                <li key={issue.issue_id}>
                  <span className="mono">{issue.issue_id}</span> {ISSUE_TYPE_LABELS[issue.type]} · {issue.beat_id}
                </li>
              ))}
            </ul>
            <label className="review-check">
              <input
                type="checkbox"
                data-testid="review-ack-blocking"
                checked={ackBlocking}
                onChange={(event) => setAckBlocking(event.target.checked)}
              />
              我已复核以上阻断，仍要定稿
            </label>
          </div>
        ) : preview.rounds === 0 ? (
          <div className="review-finalize__block" data-testid="review-finalize-skip">
            <strong>本章还没有审批报告</strong>
            <p>跳过审批是显式动作，会写进 G6 审计。</p>
            <label className="review-check">
              <input
                type="checkbox"
                data-testid="review-ack-blocking"
                checked={ackBlocking}
                onChange={(event) => setAckBlocking(event.target.checked)}
              />
              我确认跳过审批直接定稿
            </label>
          </div>
        ) : null}

        {preview.unreviewedCount > 0 ? (
          <div className="review-finalize__block" data-testid="review-finalize-unreviewed">
            <strong>有 {preview.unreviewedCount} 处改动未复检</strong>
            <ul>
              {preview.unreviewed.slice(0, 5).map((item) => (
                <li key={`${item.kind}-${item.id}`}>{item.label}</li>
              ))}
            </ul>
            <label className="review-check">
              <input
                type="checkbox"
                data-testid="review-ack-unreviewed"
                checked={ackUnreviewed}
                onChange={(event) => setAckUnreviewed(event.target.checked)}
              />
              我已复核这些改动
            </label>
          </div>
        ) : null}

        <label className="review-finalize__reason">
          理由（可选）
          <input
            type="text"
            data-testid="review-finalize-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：剩余建议留到下一章处理"
          />
        </label>

        <div className="plan-modal__actions">
          <button type="button" className="plan-mini-btn" onClick={() => useReview.getState().closeFinalize()}>
            取消
          </button>
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="review-finalize-confirm"
            disabled={!canConfirm}
            onClick={() => void useReview.getState().finalize(ackBlocking, ackUnreviewed, reason.trim() || undefined)}
          >
            确认定稿
          </button>
        </div>
      </div>
    </div>
  )
}
