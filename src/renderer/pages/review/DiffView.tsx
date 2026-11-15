import { useState } from 'react'
import type { ReviewPatchState, ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'
/**
 * 差异视图（PHASE-08 G2 / UI-DESIGN §6.4 / §9.3）：
 * - 三视图：并排 / 内联 / 仅问题；默认内联。
 * - 每个 hunk 一个 patch 卡：before / after、reason、issue_ref、[接受] [拒绝]。
 * - 拒绝保留原文；接受写草稿区并生成新 revision（主进程做，UI 只发决定）。
 * - 行号与 beat 双锚：卡片头显示 场景/拍 与 beat_id。
 */

type DiffMode = 'inline' | 'side' | 'issues'

const STATUS_LABELS: Record<ReviewPatchState['status'], string> = {
  proposed: '待决定',
  accepted: '已接受',
  rejected: '已拒绝',
  applied: '已应用',
  superseded: '旧提案'
}

function CollapsibleText({ text, tone }: { text: string; tone: 'before' | 'after' }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n')
  const clipped = lines.length > 6 && !open
  return (
    <div className={`review-hunk-text is-${tone}`}>
      <pre>{clipped ? lines.slice(0, 6).join('\n') : text}</pre>
      {lines.length > 6 ? (
        <button type="button" className="plan-mini-btn" onClick={() => setOpen(!open)}>
          {open ? '折叠' : `展开 ${lines.length} 行`}
        </button>
      ) : null}
    </div>
  )
}

function PatchCard({
  state,
  patch,
  mode
}: {
  state: ReviewState
  patch: ReviewPatchState
  mode: DiffMode
}): React.JSX.Element | null {
  const active = useReview((store) => store.activePatchId)
  const busy = useReview((store) => store.busy)
  const decision = useReview((store) => store.decisions[patch.id])
  if (mode === 'issues' && patch.status !== 'proposed') return null
  const disabled = state.readOnly || busy || patch.status !== 'proposed'
  return (
    <article
      className={`review-patch${active === patch.id ? ' is-active' : ''}${
        decision === true ? ' is-accept' : decision === false ? ' is-reject' : ''
      }`}
      data-testid={`review-patch-${patch.id}`}
      data-status={patch.status}
      data-decision={decision === undefined ? '' : String(decision)}
      onClick={() => useReview.getState().focusPatch(patch.id)}
    >
      <header className="review-patch__head">
        <span className="review-patch__anchor mono">
          场景 {patch.sceneOrd} · 拍 {String(patch.beatOrd).padStart(2, '0')} · {patch.speakerName}
        </span>
        <span className="review-patch__beat mono">{patch.beatId}</span>
        <span className={`review-patch__status is-${patch.status}`} data-testid={`review-patch-status-${patch.id}`}>
          {patch.status === 'proposed' && decision !== undefined
            ? decision
              ? '待执行 · 接受'
              : '待执行 · 拒绝'
            : STATUS_LABELS[patch.status]}
        </span>
      </header>
      <p className="review-patch__reason">
        <span className="review-patch__issue mono">{patch.issueRef}</span>
        {patch.reason}
      </p>

      <div className={`review-hunk is-${mode}`}>
        <CollapsibleText text={patch.before} tone="before" />
        <CollapsibleText text={patch.after} tone="after" />
      </div>

      <div className="review-patch__actions">
        <button
          type="button"
          className={`plan-btn${decision === true ? ' is-primary' : ''}`}
          data-testid={`review-patch-accept-${patch.id}`}
          disabled={disabled}
          title="A 接受选中 patch"
          onClick={(event) => {
            event.stopPropagation()
            useReview.getState().setDecision(patch.id, true)
          }}
        >
          接受
        </button>
        <button
          type="button"
          className={`plan-mini-btn${decision === false ? ' is-danger' : ''}`}
          data-testid={`review-patch-reject-${patch.id}`}
          disabled={disabled}
          title="X 拒绝选中 patch（保留原文与记录）"
          onClick={(event) => {
            event.stopPropagation()
            useReview.getState().setDecision(patch.id, false)
          }}
        >
          拒绝
        </button>
      </div>
    </article>
  )
}

export function DiffView({ state }: { state: ReviewState }): React.JSX.Element {
  const [mode, setMode] = useState<DiffMode>('inline')
  const decisions = useReview((store) => store.decisions)
  const busy = useReview((store) => store.busy)

  const pending = state.patches.filter((patch) => patch.status === 'proposed')
  const applied = state.patches.filter((patch) => patch.status === 'applied' || patch.status === 'accepted')
  const decided = pending.filter((patch) => typeof decisions[patch.id] === 'boolean')
  const acceptCount = pending.filter((patch) => decisions[patch.id] === true).length

  return (
    <div className="review-diff" data-testid="review-diff">
      <div className="review-diff__head">
        <div className="write-toggle">
          <button
            type="button"
            className={mode === 'inline' ? 'is-active' : ''}
            data-testid="review-diff-inline"
            onClick={() => setMode('inline')}
          >
            内联
          </button>
          <button
            type="button"
            className={mode === 'side' ? 'is-active' : ''}
            data-testid="review-diff-side"
            onClick={() => setMode('side')}
          >
            并排
          </button>
          <button
            type="button"
            className={mode === 'issues' ? 'is-active' : ''}
            data-testid="review-diff-issues"
            onClick={() => setMode('issues')}
          >
            仅问题
          </button>
        </div>
        <span className="pane-header__meta">
          待决定 {pending.length} · 已应用 {applied.length}
        </span>
        {pending.length > 0 ? (
          <div className="review-diff__bulk">
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="review-patch-accept-all"
              disabled={state.readOnly}
              onClick={() => {
                for (const patch of pending) useReview.getState().setDecision(patch.id, true)
              }}
            >
              全部接受
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="review-patch-reject-all"
              disabled={state.readOnly}
              onClick={() => {
                for (const patch of pending) useReview.getState().setDecision(patch.id, false)
              }}
            >
              全部拒绝
            </button>
            <button
              type="button"
              className="plan-btn is-primary"
              data-testid="review-patch-apply"
              disabled={state.readOnly || busy || decided.length !== pending.length}
              title={
                decided.length !== pending.length
                  ? `还有 ${pending.length - decided.length} 条未选择`
                  : `接受 ${acceptCount} 条，拒绝 ${pending.length - acceptCount} 条`
              }
              onClick={() => void useReview.getState().applyDecisions()}
            >
              执行修订（{decided.length}/{pending.length}）
            </button>
          </div>
        ) : null}
      </div>

      {state.patches.length === 0 ? (
        <div className="pane-empty">
          <h3>还没有 patch</h3>
          <p>先看「报告」，再点底部的「授权修订 G5」；讨论阶段不改稿。</p>
        </div>
      ) : (
        <div className="review-patch-list">
          {state.patches
            .slice()
            .reverse()
            .map((patch) => (
              <PatchCard key={patch.id} state={state} patch={patch} mode={mode} />
            ))}
        </div>
      )}
    </div>
  )
}
