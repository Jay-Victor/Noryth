import type { MemoryState } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 记忆台闸门行动条（UI-DESIGN §9.1 G7 / PHASE-09 H3）。
 *
 * 同一时刻只有一个主按钮：[应用 G7]。
 * 次级动作（全部接受 / 全部拒绝）不得使用主按钮样式。
 * 旁边永远显示阻塞原因或条目计数。
 */
export function GateBar({ state }: { state: MemoryState }): React.JSX.Element {
  const busy = useMemory((store) => store.busy)
  const g7 = state.g7
  const applied = state.jobStatus === 'applied'
  const disabled = state.readOnly || busy || state.running || applied

  return (
    <div className="memory-gate-bar" data-testid="memory-gate-bar">
      <div className="memory-gate-bar__info">
        <span data-testid="memory-gate-counts">
          接受 {g7.acceptedCount} · 未决 {g7.pendingCount} · 拒绝 {g7.rejectedCount}
        </span>
        {state.jobStatus ? (
          <span className="pane-header__meta" data-testid="memory-job-status">
            {state.jobStatus}
          </span>
        ) : null}
      </div>

      <button
        type="button"
        className="plan-mini-btn"
        data-testid="memory-accept-all"
        disabled={disabled || g7.pendingCount === 0}
        onClick={() => void useMemory.getState().decideAll('accept')}
      >
        全部接受
      </button>
      <button
        type="button"
        className="plan-mini-btn is-danger"
        data-testid="memory-reject-all"
        disabled={disabled || g7.pendingCount === 0}
        onClick={() => void useMemory.getState().decideAll('reject')}
      >
        全部拒绝
      </button>
      <button
        type="button"
        className="plan-btn is-primary"
        data-testid="memory-g7"
        disabled={disabled || !g7.allowed}
        title={applied ? '本章记忆已固化；重建是 M1' : (g7.reason ?? '应用已接受条目：写记忆、世界状态与向量')}
        onClick={() => void useMemory.getState().apply()}
      >
        应用 G7
      </button>
      <span className="memory-gate-bar__reason" data-testid="memory-gate-reason">
        {applied ? '本章记忆已固化（重建是 M1）' : (g7.reason ?? '')}
      </span>
    </div>
  )
}
