import type { Issue } from '../../../shared/schema/report'
import { ISSUE_TYPE_LABELS } from '../../../shared/schema/report'
import type { ReviewBeatState, ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'

/**
 * 初稿视图（UI-DESIGN §6.4）：
 * - 只读正文；gutter 显示 issue 标记：阻断实心、建议空心。
 * - 不在初稿里直接改字：修订只走「差异」tab 的 patch。
 * - 点标记 → 联动报告里对应的 issue（store.activeIssueId）。
 */

function issuesOf(state: ReviewState): { blocking: Issue[]; suggestions: Issue[] } {
  return {
    blocking: state.report?.blocking ?? [],
    suggestions: state.report?.suggestions ?? []
  }
}

function BeatBlock({
  beat,
  issues
}: {
  beat: ReviewBeatState
  issues: { blocking: Issue[]; suggestions: Issue[] }
}): React.JSX.Element {
  const active = useReview((store) => store.activeIssueId)
  const blocking = issues.blocking.filter((issue) => issue.beat_id === beat.beatId)
  const suggestions = issues.suggestions.filter((issue) => issue.beat_id === beat.beatId)
  const activeHere = [...blocking, ...suggestions].some((issue) => issue.issue_id === active)
  return (
    <div
      className={`review-para${activeHere ? ' is-active' : ''}`}
      data-testid={`review-para-${beat.beatId}`}
      data-blocking={blocking.length}
      data-suggestions={suggestions.length}
    >
      <div className="review-para__gutter">
        <span className="mono">{String(beat.ord).padStart(2, '0')}</span>
        <div className="review-marks">
          {blocking.map((issue) => (
            <button
              key={issue.issue_id}
              type="button"
              className="review-mark is-blocking"
              data-testid={`review-mark-${issue.issue_id}`}
              title={`${ISSUE_TYPE_LABELS[issue.type]}：${issue.why}`}
              onClick={() => useReview.getState().focusIssue(issue.issue_id)}
            />
          ))}
          {suggestions.map((issue) => (
            <button
              key={issue.issue_id}
              type="button"
              className="review-mark is-suggestion"
              data-testid={`review-mark-${issue.issue_id}`}
              title={`${ISSUE_TYPE_LABELS[issue.type]}：${issue.why}`}
              onClick={() => useReview.getState().focusIssue(issue.issue_id)}
            />
          ))}
        </div>
      </div>
      <div className="review-para__body">
        <div className="review-para__speaker">{beat.speakerName}</div>
        <p className="review-para__text">{beat.body || '（空拍）'}</p>
      </div>
    </div>
  )
}

export function DraftView({ state }: { state: ReviewState }): React.JSX.Element {
  const issues = issuesOf(state)
  if (state.draft.length === 0) {
    return (
      <div className="review-draft" data-testid="review-draft">
        <div className="pane-empty">
          <h3>空初稿</h3>
          <p>本章还没有草稿；先到创作台生成。</p>
        </div>
      </div>
    )
  }
  return (
    <div className="review-draft" data-testid="review-draft">
      <div className="review-draft__meta">
        <span className="mono">{state.revisionId ?? '—'}</span>
        <span>{state.draft.length} 拍</span>
        <span className="review-note">只读 · 修订只走「差异」里的 patch</span>
      </div>
      {state.draft.map((beat) => (
        <BeatBlock key={beat.beatId} beat={beat} issues={issues} />
      ))}
    </div>
  )
}
