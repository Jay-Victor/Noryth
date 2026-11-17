import { useEffect, useState } from 'react'
import { useReview } from '../../stores/review'

/**
 * 重新打开定稿确认框（PHASE-16 §5.1 / UI-DESIGN §6.4）。
 *
 * 「重新打开」不是回退：旧 final 永久保留（可对比 / 可回退），新建一份 draft 可编辑；
 * write_epoch + 1 让旧窗口里在跑的任务全部失效。再次定稿会生成新的 final。
 */
export function ReopenDialog(): React.JSX.Element | null {
  const open = useReview((store) => store.reopenOpen)
  const busy = useReview((store) => store.busy)
  const state = useReview((store) => store.state)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') useReview.getState().closeReopen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  return (
    <div className="plan-modal" role="dialog" aria-modal="true" data-testid="review-reopen-dialog">
      <div className="plan-modal__card review-finalize">
        <h3>重新打开定稿</h3>
        <p>
          会从当前定稿复制一份新草稿（可编辑、可再定稿）。旧定稿 {state?.finalRevisionId ?? '—'} 永久保留，
          可在「版本」里对比或回退；写纪元会 +1，旧窗口里在跑的任务会被拒绝。
        </p>
        <p className="review-note">
          再次定稿会生成新的 final，并自动入队记忆重建（旧记忆软失效，不删除）。
        </p>

        <label className="review-finalize__reason">
          理由（可选）
          <input
            type="text"
            data-testid="review-reopen-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：第 3 拍需要重写"
          />
        </label>

        <div className="plan-modal__actions">
          <button type="button" className="plan-mini-btn" onClick={() => useReview.getState().closeReopen()}>
            取消
          </button>
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="review-reopen-confirm"
            disabled={busy}
            onClick={() => void useReview.getState().reopen(reason.trim() || undefined)}
          >
            重新打开
          </button>
        </div>
      </div>
    </div>
  )
}
