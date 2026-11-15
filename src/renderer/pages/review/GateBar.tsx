import type { ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'

/**
 * 审批台闸门行动条（UI-DESIGN §9.1 / PHASE-08 G3）。
 *
 * 同一时刻只有一个主按钮：
 *   无报告 → G4 生成报告；报告失败 → G5 授权修订；有待决 patch → 提示逐条决定；
 *   有未复检改动 → 复检。G6 在预览 header，只有那里有。
 */
export function GateBar({ state }: { state: ReviewState }): React.JSX.Element {
  const busy = useReview((store) => store.busy)
  const pending = state.patches.filter((patch) => patch.status === 'proposed')
  const disabled = state.readOnly || busy || state.running

  const g5 = state.g5
  const showReportButton = !state.hasReport
  const showRecheck = state.hasReport && state.g6.unreviewedCount > 0 && !state.takeover

  return (
    <div className="review-gate-bar" data-testid="review-gate-bar">
      <div className="review-gate-bar__info">
        <span data-testid="review-round">
          第 {state.rounds || 0}/{state.maxRounds} 轮
        </span>
        {state.report ? (
          <span data-testid="review-gate-counts">
            阻断 {state.report.blocking.length} · 建议 {state.report.suggestions.length}
          </span>
        ) : (
          <span>还没有报告</span>
        )}
        {pending.length > 0 ? (
          <span data-testid="review-pending-patches">{pending.length} 条 patch 待决定</span>
        ) : null}
        {state.takeover ? (
          <span className="review-gate-bar__takeover" data-testid="review-gate-takeover">
            转人工
          </span>
        ) : null}
      </div>

      {showReportButton ? (
        <button
          type="button"
          className="plan-btn is-primary"
          data-testid="review-g4"
          disabled={disabled || state.chapterStatus === 'drafting'}
          onClick={() => void useReview.getState().run()}
        >
          生成报告 G4
        </button>
      ) : showRecheck ? (
        <button
          type="button"
          className="plan-btn is-primary"
          data-testid="review-recheck"
          disabled={disabled || !g5.allowed && pending.length > 0}
          title={g5.reason ?? '只复检受影响维度'}
          onClick={() => void useReview.getState().recheck()}
        >
          复检受影响维度
        </button>
      ) : (
        <button
          type="button"
          className="plan-btn is-primary"
          data-testid="review-g5"
          disabled={disabled || !g5.allowed}
          title={g5.reason ?? '授权审批产出 patch'}
          onClick={() => void useReview.getState().authorize()}
        >
          授权修订 G5
        </button>
      )}

      <span className="review-gate-bar__reason" data-testid="review-gate-reason">
        {g5.reason ?? (pending.length > 0 ? '逐条接受/拒绝后生成新 revision' : '')}
      </span>
    </div>
  )
}
