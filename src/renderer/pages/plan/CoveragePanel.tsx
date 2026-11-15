import { useMemo } from 'react'
import {
  CHANGE_APPLY_HINTS,
  CHANGE_STATUS_LABELS,
  COVERAGE_SEVERITY_LABELS,
  changeApplyState,
  coverageSummary
} from '../../../shared/domain/blueprint-view'
import {
  COVERAGE_GAP_LABELS,
  type BlueprintChangeView,
  type PlanCoverageState
} from '../../../shared/schema/blueprint'
import type { PlanOutlineNode, PlanProposalView } from '../../../shared/schema/plan'

/**
 * 覆盖检查 + 蓝图变更（PHASE-15 M1-11 / M1-8，UI-DESIGN §4.4「覆盖检查」）。
 *
 * 覆盖检查：4 类确定性规则，error 才禁 G1，warn 只计数；每条可「定位」到节点。
 * 变更流程：G1 后提案必须「影响分析 → 确认应用」；未分析不允许应用。
 * 这里只读 + 触发动作，写入都在主进程（plan/change.ts）。
 */

export interface CoveragePanelProps {
  coverage: PlanCoverageState
  nodes: PlanOutlineNode[]
  changes: BlueprintChangeView[]
  proposals: PlanProposalView[]
  locked: boolean
  readOnly: boolean
  onFocus(nodeId: string): void
  onToggleGate(enabled: boolean): void
  onAnalyzeProposal(proposalId: string): void
  onApplyChange(changeId: string): void
  onRejectChange(changeId: string): void
}

export function CoveragePanel({
  coverage,
  nodes,
  changes,
  proposals,
  locked,
  readOnly,
  onFocus,
  onToggleGate,
  onAnalyzeProposal,
  onApplyChange,
  onRejectChange
}: CoveragePanelProps): React.JSX.Element {
  const errors = useMemo(() => coverage.gaps.filter((gap) => gap.severity === 'error'), [coverage.gaps])
  const warns = useMemo(() => coverage.gaps.filter((gap) => gap.severity === 'warn'), [coverage.gaps])
  const pendingProposals = proposals.filter(
    (proposal) => proposal.status === 'draft' && proposal.kind !== 'roster'
  )

  const titleOf = (nodeId: string): string =>
    nodeId === 'project' ? '项目' : (nodes.find((node) => node.id === nodeId)?.title ?? nodeId)

  return (
    <div className="plan-coverage" data-testid="coverage-pane">
      <header className="plan-coverage__head">
        <h3>覆盖检查</h3>
        <span className="pane-header__meta" data-testid="coverage-counts">
          {coverageSummary(coverage)}
        </span>
        {!coverage.locked ? (
          <label className="plan-meta__label" htmlFor="coverage-gate">
            <input
              id="coverage-gate"
              type="checkbox"
              data-testid="coverage-gate"
              checked={coverage.gate}
              disabled={readOnly}
              onChange={(event) => onToggleGate(event.target.checked)}
            />
            阻断 G1
          </label>
        ) : (
          <span className="plan-node-meta">G1 已锁定：只做展示，不再阻断</span>
        )}
      </header>

      {coverage.gate ? null : (
        <p className="plan-notice" data-testid="coverage-gate-off">
          覆盖检查已关闭阻断：问题仍会列出，但不再禁用「确认蓝图」。
        </p>
      )}

      {coverage.gaps.length === 0 ? (
        <p className="plan-coverage__state" data-testid="coverage-empty">
          没有发现问题。标注越完整，检查越准：覆盖检查只读结构化标注，不解析自然语言。
        </p>
      ) : (
        <ul className="plan-coverage__list" data-testid="coverage-gaps">
          {[...errors, ...warns].map((gap) => (
            <li
              key={`${gap.code}-${gap.node_id}-${gap.message}`}
              className={`plan-coverage__item is-${gap.severity}`}
              data-testid={`coverage-gap-${gap.code}`}
            >
              <span className={`plan-severity is-${gap.severity}`}>{COVERAGE_SEVERITY_LABELS[gap.severity]}</span>
              <span className="plan-coverage__kind">{COVERAGE_GAP_LABELS[gap.code]}</span>
              <span className="plan-coverage__msg">{gap.message}</span>
              {gap.node_id !== 'project' ? (
                <button
                  type="button"
                  className="plan-mini-btn"
                  data-testid={`coverage-locate-${gap.code}`}
                  onClick={() => onFocus(gap.node_id)}
                >
                  定位 · {titleOf(gap.node_id)}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="plan-changes" data-testid="plan-changes">
        <div className="plan-subhead">蓝图变更 · {changes.length}</div>
        {!locked ? (
          <p className="plan-note">G1 前改蓝图直接编辑草案；G1 后才能进入变更流程。</p>
        ) : (
          <>
            {pendingProposals.length > 0 ? (
              <div className="plan-changes__proposals">
                <div className="plan-node-meta">待分析的提案</div>
                {pendingProposals.map((proposal) => (
                  <div key={proposal.id} className="plan-changes__row">
                    <span className="mono">{proposal.kind === 'blueprint_patch' ? '蓝图' : '角色卡'}</span>
                    <span className="plan-node-meta">
                      新增 {proposal.summary.added ?? 0} / 改 {proposal.summary.updated ?? 0} / 删{' '}
                      {proposal.summary.removed ?? 0}
                      {proposal.summary.character_name ? ` · ${proposal.summary.character_name}` : ''}
                    </span>
                    <button
                      type="button"
                      className="plan-btn"
                      data-testid={`impact-analyze-${proposal.id}`}
                      disabled={readOnly}
                      onClick={() => onAnalyzeProposal(proposal.id)}
                    >
                      影响分析
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {changes.length === 0 ? (
              <p className="plan-note">还没有变更记录。改蓝图会先分析影响，再等你确认。</p>
            ) : (
              changes.map((change) => (
                <div key={change.id} className="plan-changes__card" data-testid={`change-card-${change.id}`}>
                  <div className="plan-changes__row">
                    <span className={`plan-change-status is-${change.status}`}>{CHANGE_STATUS_LABELS[change.status]}</span>
                    <span className="plan-node-meta">
                      结构 {change.summary.added}/{change.summary.updated}/{change.summary.removed}
                      {change.summary.characterCards > 0 ? ` · 角色卡 ${change.summary.characterCards}` : ''}
                    </span>
                    <span className="pane-header__meta">{change.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  {change.impact ? (
                    <div className="plan-changes__impact" data-testid={`change-impact-${change.id}`}>
                      <span>
                        受影响：{change.impact.counts.chapters} 章 · {change.impact.counts.memory_entries} 条记忆 ·{' '}
                        {change.impact.counts.relationships} 条关系边
                      </span>
                      {change.impact.chapters.length > 0 ? (
                        <ul className="plan-changes__chapters">
                          {change.impact.chapters.map((chapter) => (
                            <li key={chapter.id}>
                              第 {chapter.ord} 章 {chapter.title}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <p className="plan-note" data-testid={`change-unanalyzed-${change.id}`}>
                      {CHANGE_APPLY_HINTS[changeApplyState(change)]}
                    </p>
                  )}
                  {change.status === 'proposed' ? (
                    <div className="plan-changes__actions">
                      <button
                        type="button"
                        className="plan-btn is-primary"
                        data-testid={`change-apply-${change.id}`}
                        disabled={readOnly || change.impact === null}
                        title={change.impact === null ? '先跑影响分析' : undefined}
                        onClick={() => onApplyChange(change.id)}
                      >
                        确认应用
                      </button>
                      <button
                        type="button"
                        className="plan-btn"
                        data-testid={`change-reject-${change.id}`}
                        disabled={readOnly}
                        onClick={() => onRejectChange(change.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </>
        )}
      </section>
    </div>
  )
}
