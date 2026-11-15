import type { Issue } from '../../../shared/schema/report'
import {
  DIMENSION_KEYS,
  DIMENSION_LABELS,
  ISSUE_TYPE_LABELS,
  VERDICT_LABELS,
  type DimensionKey
} from '../../../shared/schema/report'
import type { ReviewReportState, ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'

/**
 * 报告视图（UI-DESIGN §6.4）：
 * - 顶部结论横幅：fail 显示阻断数；降级报告显示纯文本提示。
 * - 维度分 1–5，只用于趋势；tooltip 说明「不用于自动放行」。
 * - 阻断项：类型、beat、证据原文、为什么、建议；[定位] [加入修订]。
 * - 建议项默认折叠；每条都能定位到拍。
 */

function issueBeatLabel(state: ReviewState, issue: Issue): string {
  if (issue.beat_id.length === 0) return '全局'
  const beat = state.draft.find((item) => item.beatId === issue.beat_id)
  if (!beat) return issue.beat_id
  return `拍 ${String(beat.ord).padStart(2, '0')} · ${beat.speakerName}`
}

function IssueRow({
  state,
  issue,
  kind
}: {
  state: ReviewState
  issue: Issue
  kind: 'blocking' | 'suggestion'
}): React.JSX.Element {
  const active = useReview((store) => store.activeIssueId)
  const hasPatch = state.patches.some((patch) => patch.issueRef === issue.issue_id)
  return (
    <article
      className={`review-issue${active === issue.issue_id ? ' is-active' : ''} is-${kind}`}
      data-testid={`review-issue-${issue.issue_id}`}
      data-type={issue.type}
      onClick={() => useReview.getState().focusIssue(issue.issue_id)}
    >
      <header className="review-issue__head">
        <span className="review-issue__id mono">{issue.issue_id}</span>
        <span className="review-issue__type">{ISSUE_TYPE_LABELS[issue.type]}</span>
        <span className="review-issue__beat mono">{issueBeatLabel(state, issue)}</span>
        {issue.downgraded ? (
          <span className="review-issue__flag" title={`服务端降级：${issue.downgraded}`}>
            已降级
          </span>
        ) : null}
        <span className="review-issue__spacer" />
        <button
          type="button"
          className="plan-mini-btn"
          data-testid={`review-locate-${issue.issue_id}`}
          onClick={(event) => {
            event.stopPropagation()
            useReview.getState().focusIssue(issue.issue_id)
            useReview.getState().setTab('draft')
          }}
        >
          定位
        </button>
        {kind === 'blocking' ? (
          <button
            type="button"
            className="plan-mini-btn"
            data-testid={`review-add-patch-${issue.issue_id}`}
            disabled={!hasPatch}
            title={hasPatch ? '在差异里打开对应 patch' : '先授权修订（G5），审批才会产出 patch'}
            onClick={(event) => {
              event.stopPropagation()
              const patch = state.patches.find((item) => item.issueRef === issue.issue_id)
              if (patch) useReview.getState().focusPatch(patch.id)
            }}
          >
            {hasPatch ? '加入修订' : '无对应 patch'}
          </button>
        ) : null}
      </header>
      {issue.evidence.length > 0 ? (
        <blockquote className="review-issue__evidence" data-testid={`review-evidence-${issue.issue_id}`}>
          {issue.evidence}
        </blockquote>
      ) : null}
      <p className="review-issue__why">{issue.why}</p>
      {issue.suggestion.length > 0 ? <p className="review-issue__suggestion">建议：{issue.suggestion}</p> : null}
    </article>
  )
}

function DimensionGrid({ report }: { report: ReviewReportState }): React.JSX.Element {
  return (
    <div className="review-dimensions" data-testid="review-dimensions">
      {DIMENSION_KEYS.map((key: DimensionKey) => {
        const score = report.dimensions[key]
        return (
          <div key={key} className="review-dimension" title="1–5 分，只用于趋势，不用于自动放行">
            <span className="review-dimension__label">{DIMENSION_LABELS[key]}</span>
            <span className="review-dimension__score" data-testid={`review-dim-${key}`}>
              {score === null ? '—' : `${score}/5`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ReportView({ state }: { state: ReviewState }): React.JSX.Element {
  const busy = useReview((store) => store.busy)
  const report = state.report
  if (!report) {
    return (
      <div className="review-report" data-testid="review-report-empty">
        <div className="pane-empty">
          <h3>{state.running ? '正在生成报告…' : '还没有审批报告'}</h3>
          <p>
            {state.chapterStatus === 'draft_complete'
              ? '点「生成报告」跑 G4；报告只读初稿，不改稿。'
              : '章节点至少要 draft_complete 才能审。'}
          </p>
          <button
            type="button"
            className="plan-btn"
            data-testid="review-run"
            disabled={state.readOnly || state.running || busy}
            onClick={() => void useReview.getState().run()}
          >
            生成报告
          </button>
        </div>
      </div>
    )
  }

  const degraded = report.degraded !== null
  const degradedText =
    report.degraded === 'schema_fallback'
      ? { title: '报告已降级为纯文本', body: 'schema 解析失败；阻断项无法定位。建议重试结构化。', retry: true }
      : report.degraded === 'check_missing'
        ? {
            title: '确定性检查未跑完',
            body: '报告没有阻断，但 consistency.check 没有成功返回；由作者决定是否继续。',
            retry: true
          }
        : { title: '报告已降级', body: `原因：${report.degraded ?? ''}`, retry: false }
  return (
    <div className="review-report" data-testid="review-report">
      {degraded ? (
        <div className="review-banner is-warn" data-testid="review-degraded" data-degraded={report.degraded}>
          <strong>{degradedText.title}</strong>
          <span>{degradedText.body}</span>
          {degradedText.retry ? (
            <button
              type="button"
              className="plan-mini-btn"
              disabled={state.readOnly || state.running}
              onClick={() => void useReview.getState().run()}
            >
              重新生成
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={`review-banner is-${report.verdict}`} data-testid="review-verdict" data-verdict={report.verdict}>
        <strong>{VERDICT_LABELS[report.verdict]}</strong>
        <span>
          第 {report.round} 轮
          {report.scope.length > 0
            ? ` · 复检 ${report.scope.map((key) => DIMENSION_LABELS[key]).join(' + ')}`
            : ' · 全量'}
        </span>
        <span className="review-banner__counts">
          阻断 {report.blocking.length} · 建议 {report.suggestions.length}
        </span>
        {report.model ? <span className="review-banner__model mono">{report.model}</span> : null}
      </div>

      <DimensionGrid report={report} />

      <section className="review-section">
        <h4>阻断项 · {report.blocking.length}</h4>
        {report.blocking.length === 0 ? (
          <p className="review-note">没有阻断。定稿前仍建议看一遍建议项。</p>
        ) : (
          report.blocking.map((issue) => <IssueRow key={issue.issue_id} state={state} issue={issue} kind="blocking" />)
        )}
      </section>

      <section className="review-section">
        <details open={report.suggestions.length > 0}>
          <summary>
            建议项 · {report.suggestions.length}
            <span className="review-note">（默认折叠；可不修）</span>
          </summary>
          {report.suggestions.map((issue) => (
            <IssueRow key={issue.issue_id} state={state} issue={issue} kind="suggestion" />
          ))}
        </details>
      </section>

      {state.takeover ? (
        <div className="review-banner is-warn" data-testid="review-takeover">
          <strong>已转人工</strong>
          <span>已修订 3 轮仍未通过；全部报告与 patch 已保留，可直接定稿或人工处理。</span>
        </div>
      ) : null}
    </div>
  )
}
