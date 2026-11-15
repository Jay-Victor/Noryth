import { useEffect, useMemo, useState } from 'react'
import { GRID, type LayoutMode } from '../../../shared/layout/grid'
import { DIMENSION_LABELS, VERDICT_LABELS } from '../../../shared/schema/report'
import { REVIEW_STATUS_LABELS } from '../../../shared/schema/review'
import { Icon } from '../../components/Icon'
import { getBridge } from '../../lib/bridge'
import { useApp } from '../../stores/app'
import { useReview, type ReviewTab } from '../../stores/review'
import { DiffView } from './DiffView'
import { DraftView } from './DraftView'
import { FinalizeDialog } from './FinalizeDialog'
import { GateBar } from './GateBar'
import { ReportView } from './ReportView'
import { VersionList } from './VersionList'

/**
 * 审批台（UI-DESIGN §6 / PHASE-08）。
 *
 * 四分区：章与轮次 / 报告摘要 + 讨论 / 初稿·报告·差异·版本 / 只读文件树。
 * 讨论阶段不改稿；修订只走差异里的 patch；G6 定稿按钮只在预览 header，无快捷键。
 */

const TABS: Array<{ key: ReviewTab; label: string }> = [
  { key: 'draft', label: '初稿' },
  { key: 'report', label: '报告' },
  { key: 'diff', label: '差异' },
  { key: 'versions', label: '版本' }
]

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function ReviewPage({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const current = useApp((state) => state.current)
  const projectId = current?.project.id ?? null
  const state = useReview((store) => store.state)
  const tab = useReview((store) => store.tab)
  const busy = useReview((store) => store.busy)
  const loading = useReview((store) => store.loading)
  const streaming = useReview((store) => store.streaming)
  const [message, setMessage] = useState('')

  useEffect(() => {
    useReview.getState().reset()
    if (projectId) void useReview.getState().load()
  }, [projectId])

  // 命令面板「定稿本章」：切到审批台并打开同一个确认框。
  useEffect(() => {
    const handler = (): void => {
      useReview.getState().requestFinalize()
    }
    window.addEventListener('noryth:finalize-chapter', handler)
    return () => window.removeEventListener('noryth:finalize-chapter', handler)
  }, [])

  const report = state?.report ?? null
  const issues = useMemo(
    () => (report ? [...report.blocking, ...report.suggestions] : []),
    [report]
  )
  const activePatchId = useReview((store) => store.activePatchId)
  const pendingPatches = state?.patches.filter((patch) => patch.status === 'proposed') ?? []

  // 键盘：Ctrl+Enter 发送；N/P 切 issue；A/X 接受/拒绝选中 patch；D 打开差异。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!state) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        const text = message.trim()
        if (text.length === 0 || busy) return
        setMessage('')
        void useReview.getState().send(text)
        return
      }
      if (isEditable(event.target) || event.isComposing || event.keyCode === 229) return
      const key = event.key.toLowerCase()
      const review = useReview.getState()
      const index = issues.findIndex((issue) => issue.issue_id === review.activeIssueId)
      if (key === 'n') {
        const next = issues[Math.min(issues.length - 1, index + 1)]
        if (next) review.focusIssue(next.issue_id)
        return
      }
      if (key === 'p') {
        const previous = issues[Math.max(0, index - 1)]
        if (previous) review.focusIssue(previous.issue_id)
        return
      }
      if (key === 'd') {
        review.setTab('diff')
        return
      }
      const target = activePatchId ?? pendingPatches[0]?.id ?? null
      if (key === 'a' && target) {
        event.preventDefault()
        review.setDecision(target, true)
        return
      }
      if (key === 'x' && target) {
        event.preventDefault()
        review.setDecision(target, false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state, message, busy, issues, activePatchId, pendingPatches])

  if (!projectId) {
    return (
      <>
        <section className="pane pane--sessions" data-testid="pane-sessions">
          <div className="pane-header">章节</div>
        </section>
        <section className="pane pane--chat" data-testid="pane-chat">
          <div className="pane-header">对话</div>
          <div className="pane-body">
            <div className="pane-empty">
              <h3>先打开一个项目</h3>
              <p>审批台只在项目内可用。</p>
            </div>
          </div>
        </section>
        <section className="pane pane--preview" data-testid="pane-preview">
          <div className="pane-header">报告</div>
        </section>
        <section className="pane pane--tree" data-testid="pane-tree">
          <div className="pane-header">文件树</div>
        </section>
      </>
    )
  }

  if (!state) {
    return (
      <section className="pane pane--chat" data-testid="pane-chat">
        <div className="pane-header">报告</div>
        <div className="pane-body">
          <div className="pane-empty">
            <h3>{loading ? '正在打开审批台…' : '还没有章节'}</h3>
            <p>先在规划台完成 G1、在创作台完成初稿。</p>
          </div>
        </div>
      </section>
    )
  }

  const treeMode = GRID[mode].treeMode
  const g6Disabled =
    state.readOnly || busy || state.running || !state.g6.ready || state.g6.alreadyFinalized
  const g6Title = state.g6.alreadyFinalized
    ? '本章已定稿'
    : state.g6.blockers.length > 0
      ? state.g6.blockers[0]
      : '定稿后正文冻结'

  return (
    <>
      <section className="pane pane--sessions" data-testid="pane-sessions" aria-label="章节与轮次">
        <div className="pane-header">
          <span>章节</span>
          <span className="pane-header__meta">{state.chapters.length}</span>
        </div>
        <div className="pane-body review-chapters">
          {state.chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              className={`write-chapter-row${chapter.id === state.chapterId ? ' is-active' : ''}`}
              data-testid={`review-chapter-${chapter.id}`}
              onClick={() => void useReview.getState().setChapter(chapter.id)}
            >
              <span className="write-chapter-title">{chapter.title}</span>
              <span className="write-chapter-status" data-status={chapter.status}>
                {REVIEW_STATUS_LABELS[chapter.status] ?? chapter.status}
              </span>
              <span className="review-chapter-rounds">{chapter.rounds > 0 ? `R${chapter.rounds}` : '—'}</span>
            </button>
          ))}

          <div className="write-scene-progress">
            <div className="write-subhead">轮次</div>
            {state.reports.length === 0 ? (
              <p className="write-note">还没有报告。</p>
            ) : (
              state.reports
                .slice()
                .reverse()
                .map((item) => (
                  <div key={item.id} className="review-round-row" data-testid={`review-round-${item.round}`}>
                    <span className="review-round-row__tag">R{item.round}</span>
                    <span className={`review-verdict-dot is-${item.verdict}`} />
                    <span>{VERDICT_LABELS[item.verdict]}</span>
                    <span className="pane-header__meta">
                      {item.blockingCount} 阻断 · {item.suggestionCount} 建议
                    </span>
                  </div>
                ))
            )}
          </div>

          <div className="write-scene-progress">
            <div className="write-subhead">修订</div>
            <div className="review-mini-stats">
              <span>patch {state.patches.length}</span>
              <span>版本 {state.versions.length}</span>
              <span>{state.takeover ? '转人工' : `${state.rounds}/${state.maxRounds} 轮`}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="pane pane--chat" data-testid="pane-chat" aria-label="报告摘要与讨论">
        <div className="pane-header">
          <span>审批对话</span>
          <span className="pane-header__meta">{state.model.label}</span>
        </div>
        <div className="pane-body review-chat">
          <div className={`review-summary is-${report?.verdict ?? 'none'}`} data-testid="review-summary-card">
            {report ? (
              <>
                <div className="review-summary__head">
                  <strong>{VERDICT_LABELS[report.verdict]}</strong>
                  <span className="pane-header__meta">第 {report.round} 轮</span>
                </div>
                <p>
                  阻断 {report.blocking.length} · 建议 {report.suggestions.length}
                  {report.scope.length > 0
                    ? ` · 复检 ${report.scope.map((key) => DIMENSION_LABELS[key]).join(' + ')}`
                    : ''}
                </p>
                <button type="button" className="plan-mini-btn" onClick={() => useReview.getState().setTab('report')}>
                  打开报告
                </button>
              </>
            ) : (
              <p>{state.running ? '正在生成报告…' : '还没有报告；点下方「生成报告 G4」。'}</p>
            )}
          </div>

          <div className="write-chat-stream" data-testid="review-chat-stream">
            {state.messages.length === 0 && streaming.length === 0 ? (
              <div className="chat-bubble is-agent">
                报告先出结论，再逐条讨论。讨论不改稿：要改必须点「授权修订 G5」。
                <div className="chat-bubble__meta">仅讨论 · 不改定稿</div>
              </div>
            ) : (
              state.messages.map((item) => (
                <div
                  key={item.id}
                  className={`chat-bubble ${
                    item.role === 'author' ? 'is-author' : item.role === 'system' ? 'is-system' : 'is-agent'
                  }`}
                  data-testid={`review-message-${item.role}`}
                >
                  {item.body || '…'}
                  {item.kind === 'report' ? <div className="chat-bubble__meta">报告已更新</div> : null}
                  {item.kind === 'patch' ? <div className="chat-bubble__meta">patch 提案</div> : null}
                </div>
              ))
            )}
            {streaming.length > 0 ? (
              <div className="chat-bubble is-agent" data-testid="review-streaming">
                {streaming}
                <span className="write-caret" aria-hidden="true" />
              </div>
            ) : null}
          </div>

          <div className="write-composer">
            <textarea
              className="write-composer__input"
              data-testid="review-composer"
              placeholder="追问证据、讨论改法（Ctrl+Enter 发送；讨论不改稿）"
              value={message}
              rows={3}
              onChange={(event) => setMessage(event.target.value)}
            />
            <button
              type="button"
              className="plan-btn"
              data-testid="review-send"
              disabled={busy || message.trim().length === 0}
              onClick={() => {
                const text = message.trim()
                if (text.length === 0) return
                setMessage('')
                void useReview.getState().send(text)
              }}
            >
              发送
            </button>
          </div>

          <GateBar state={state} />
        </div>
      </section>

      <section className="pane pane--preview" data-testid="pane-preview" aria-label="报告与正文">
        <div className="pane-header review-preview-head">
          <div className="write-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={`write-tab${tab === item.key ? ' is-active' : ''}`}
                data-testid={`review-tab-${item.key}`}
                onClick={() => useReview.getState().setTab(item.key)}
              >
                {item.label}
                {item.key === 'report' && report && report.blocking.length > 0 ? (
                  <span className="write-tab__badge" data-testid="review-report-badge">
                    {report.blocking.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <span className="pane-header__meta">
            {state.chapterStatus === 'finalized' ? '已定稿 · 只读' : state.readOnly ? '只读' : ''}
          </span>
          {/* 导出只读：不改 revision；只读锁下仍可用（PRD §5.5）。 */}
          <button
            type="button"
            className="plan-btn"
            data-testid="review-export"
            disabled={!state.chapterId}
            title="导出本章 Markdown 到项目 exports/"
            onClick={() => {
              void (async () => {
                const bridge = getBridge()
                if (!bridge) return
                const result = await bridge.manuscript.export({
                  chapterId: state.chapterId,
                  format: 'md',
                  includeNotes: false
                })
                if (!result.ok) {
                  useApp.getState().toast({ tone: 'error', title: result.error.message, detail: result.error.code })
                  return
                }
                useApp.getState().toast({
                  tone: 'success',
                  title: `已导出 ${result.data.words} 字`,
                  detail: result.data.path,
                  key: 'export-chapter'
                })
              })()
            }}
          >
            导出 Markdown
          </button>
          {/* G6 只在审批台预览 header；无快捷键，创作台不出现。 */}
          <button
            type="button"
            className={`plan-btn review-finalize-btn${state.g6.alreadyFinalized ? ' is-done' : ''}`}
            data-testid="review-finalize"
            disabled={g6Disabled}
            title={g6Title}
            onClick={() => void useReview.getState().openFinalize()}
          >
            {state.g6.alreadyFinalized ? '已定稿' : '定稿 G6'}
          </button>
        </div>

        {tab === 'draft' ? <DraftView state={state} /> : null}
        {tab === 'report' ? <ReportView state={state} /> : null}
        {tab === 'diff' ? <DiffView state={state} /> : null}
        {tab === 'versions' ? <VersionList state={state} /> : null}
      </section>

      <section className="pane pane--tree" data-testid="pane-tree" aria-label="只读文件树">
        {treeMode === 'pane' ? (
          <>
            <div className="pane-header">
              <span>纲要 / 数据库</span>
              <span className="pane-header__meta">只读</span>
            </div>
            <div className="pane-body write-tree">
              <div className="plan-subhead">章节</div>
              <div className="plan-tree-file">
                <Icon name="review" size={12} />
                <span className="mono">ch-{String(state.chapterOrd).padStart(3, '0')}.md</span>
                <span className="plan-tree-status is-locked">{state.revisionId ? '草稿' : '空'}</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="write" size={12} />
                <span>定稿快照</span>
                <span className="plan-tree-status">{state.finalRevisionId ? 'final' : '—'}</span>
              </div>
              <div className="plan-subhead">数据库视图</div>
              <div className="plan-tree-file">
                <Icon name="memory" size={12} />
                <span>审批报告</span>
                <span className="pane-header__meta">{state.reports.length} 份</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="plan" size={12} />
                <span>patch</span>
                <span className="pane-header__meta">
                  {state.patches.filter((patch) => patch.status === 'applied').length} 已应用
                </span>
              </div>
              <div className="plan-tree-file">
                <Icon name="write" size={12} />
                <span>revision</span>
                <span className="pane-header__meta">{state.versions.length} 个</span>
              </div>
              <div className="plan-subhead">规则</div>
              <p className="write-note">审批中所有文件只读；定稿不可在此回退。</p>
            </div>
          </>
        ) : (
          <div className="rail">
            <span className="rail-item is-active" title="报告">
              <Icon name="review" size={13} />
            </span>
            <span className="rail-item" title={`patch ${state.patches.length}`}>
              <Icon name="plan" size={13} />
            </span>
            <span className="rail-item" title={`版本 ${state.versions.length}`}>
              <Icon name="write" size={13} />
            </span>
          </div>
        )}
      </section>

      <FinalizeDialog />
    </>
  )
}
