import { useState } from 'react'
import type { ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'

/**
 * 分支树（PHASE-16 §5.2 / M1-21）。
 *
 * M1 只做「命名 / 对比 / 切换」：分支承载 draft，final 永远在主线上；
 * 切到定稿不是分支切换，走「重新打开」。不做合并（M2）。
 */
export function BranchTree({ state }: { state: ReviewState }): React.JSX.Element {
  const busy = useReview((store) => store.busy)
  const [name, setName] = useState('')
  const disabled = state.readOnly || busy || state.running
  const canBranch = disabled || state.chapterStatus === 'finalized'

  return (
    <div className="review-branch-tree" data-testid="review-branch-tree">
      <div className="review-versions__head">
        <span>分支（{state.branches.length}）</span>
        <span className="review-note">
          {state.chapterStatus === 'finalized' ? '已定稿：先「重新打开」才能开分支' : '切换只改当前版本，不删任何分支'}
        </span>
      </div>

      <div
        className={`review-branch-row${state.mainlineCurrent ? ' is-current' : ''}`}
        data-testid="review-branch-mainline"
        data-current={state.mainlineCurrent}
      >
        <span className="review-branch-row__name">主线</span>
        <span className="review-branch-row__head mono">{state.mainlineHeadId ?? '—'}</span>
        {state.mainlineCurrent ? (
          <span className="review-branch-badge">当前</span>
        ) : (
          <button
            type="button"
            className="plan-mini-btn"
            data-testid="review-branch-switch-mainline"
            disabled={canBranch || state.mainlineHeadId === null}
            onClick={() => void useReview.getState().switchBranch(null)}
          >
            切回主线
          </button>
        )}
      </div>

      {state.branches.map((branch) => (
        <div
          key={branch.id}
          className={`review-branch-row${branch.isCurrent ? ' is-current' : ''}`}
          data-testid={`review-branch-row-${branch.id}`}
          data-current={branch.isCurrent}
        >
          <span className="review-branch-row__name">{branch.name}</span>
          <span className="review-branch-row__head mono">{branch.headRevisionId}</span>
          <span className="review-branch-row__base mono">← {branch.baseRevisionId}</span>
          {branch.isCurrent ? (
            <span className="review-branch-badge">当前</span>
          ) : (
            <button
              type="button"
              className="plan-mini-btn"
              data-testid={`review-branch-switch-${branch.id}`}
              disabled={canBranch || branch.status !== 'open'}
              title={branch.status === 'open' ? '切换到这个分支的 head' : '分支已归档'}
              onClick={() => void useReview.getState().switchBranch(branch.id)}
            >
              切换
            </button>
          )}
        </div>
      ))}

      <div className="review-branch-create">
        <input
          type="text"
          data-testid="review-branch-name"
          value={name}
          maxLength={40}
          placeholder="新分支名（从当前版本复制）"
          disabled={canBranch}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="review-branch-create-run"
          disabled={canBranch || name.trim().length === 0}
          onClick={() => {
            const trimmed = name.trim()
            if (trimmed.length === 0) return
            setName('')
            void useReview.getState().createBranch(trimmed)
          }}
        >
          开新分支
        </button>
      </div>
    </div>
  )
}
