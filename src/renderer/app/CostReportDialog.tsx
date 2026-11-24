import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CostReport } from '../../shared/schema/cost'
import { MAX_CHAPTER_BUDGET_CNY, formatBudgetTokens, formatCny } from '../../shared/domain/budget'
import { getBridge } from '../lib/bridge'
import { useOverlayDismiss } from '../hooks'
import { useApp } from '../stores/app'
import { useWrite } from '../stores/write'
import { VirtualList } from '../components/VirtualList'

/**
 * 成本/耗时报表 + 章预算编辑（PHASE-20 §5.5 / M2-3 / M2-5）。
 *
 * 数据只来自 `report.cost`（只读 IPC），不在 UI 里二次计算；状态栏的预算段
 * 与暂停横幅都指向同一个对话框。字数口径与「每万字」由主进程给出，
 * 无计价时显示「费用为下限」而不是 0。
 *
 * 100 行以上用 VirtualList（与章节列表同一组件），不引入图表库。
 */

export interface CostReportDialogProps {
  open: boolean
  /** 当前创作台章；null 时只能看全书，预算编辑隐藏。 */
  chapterId: string | null
  chapterTitle?: string | null
  onClose: () => void
}

type Scope = 'book' | 'chapter'
type Tab = 'chapter' | 'agent'

const CNY = formatCny
const PER10K = (value: number | null): string => (value === null ? '—' : formatCny(value))
const LATENCY = (value: number | null): string => (value === null ? '—' : `${value}ms`)

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

export function CostReportDialog({
  open,
  chapterId,
  chapterTitle,
  onClose
}: CostReportDialogProps): React.JSX.Element | null {
  const overlayRef = useOverlayDismiss(open, onClose)
  const toast = useApp((store) => store.toast)
  const [scope, setScope] = useState<Scope>('book')
  const [tab, setTab] = useState<Tab>('chapter')
  const [report, setReport] = useState<CostReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [budgetText, setBudgetText] = useState('')
  const [tokensText, setTokensText] = useState('')
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(
    async (nextScope: Scope): Promise<void> => {
      const bridge = getBridge()
      if (!bridge) return
      setLoading(true)
      setError(null)
      const input = nextScope === 'chapter' && chapterId !== null ? { chapterId } : {}
      const result = await bridge.report.cost(input)
      setLoading(false)
      if (!result.ok) {
        setError(result.error.message)
        setReport(null)
        return
      }
      setReport(result.data)
    },
    [chapterId]
  )

  useEffect(() => {
    if (!open) return
    setScope('book')
    setTab('chapter')
    setBudgetError(null)
    void load('book')
  }, [open, chapterId, load])

  // 预算编辑读当前章的 limit；不额外开新口径（chapterBudget 是唯一真源）。
  useEffect(() => {
    if (!open || chapterId === null) return
    const bridge = getBridge()
    if (!bridge) return
    void (async () => {
      const result = await bridge.write.state(chapterId)
      if (!result.ok) return
      setBudgetText(result.data.budget.costLimit.toFixed(2))
      setTokensText(String(result.data.budget.tokensLimit))
    })()
  }, [open, chapterId])

  const switchScope = (next: Scope): void => {
    setScope(next)
    void load(next)
  }

  const budgetsValid = useMemo(() => {
    if (chapterId === null) return false
    const cny = Number(budgetText)
    const tokens = Number(tokensText)
    return budgetText.trim().length > 0 && tokensText.trim().length > 0 && Number.isFinite(cny) && cny >= 0 && cny <= MAX_CHAPTER_BUDGET_CNY && Number.isFinite(tokens) && tokens >= 0
  }, [budgetText, tokensText, chapterId])

  if (!open) return null

  const saveBudget = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge || chapterId === null) return
    const cny = Number(budgetText)
    const tokens = Number(tokensText)
    if (!budgetsValid) {
      setBudgetError(`预算必须是非负数（费用上限 ¥${MAX_CHAPTER_BUDGET_CNY}）`)
      return
    }
    setBudgetError(null)
    setSaving(true)
    const result = await bridge.write.setBudget({
      chapterId,
      budgetCny: cny,
      budgetTokens: Math.round(tokens)
    })
    setSaving(false)
    if (!result.ok) {
      setBudgetError(result.error.message)
      return
    }
    // 状态栏 / 创作台读同一份 WriteState：保存后立刻刷新。
    await useWrite.getState().load(chapterId)
    toast({ tone: 'success', title: '章预算已更新', key: 'cost-budget' })
    await load(scope)
  }

  const resetBudget = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge || chapterId === null) return
    setSaving(true)
    const result = await bridge.write.setBudget({ chapterId, budgetCny: null })
    setSaving(false)
    if (!result.ok) {
      setBudgetError(result.error.message)
      return
    }
    await useWrite.getState().load(chapterId)
    toast({ tone: 'success', title: '已恢复默认预算', key: 'cost-budget' })
    await load(scope)
  }

  const empty = report !== null && report.total.pricedCalls + report.total.unpricedCalls === 0
  const unpriced = (report?.total.unpricedCalls ?? 0) > 0

  return (
    <div className="plan-modal" ref={overlayRef} data-testid="cost-dialog">
      <div className="plan-modal__card cost-card" role="dialog" aria-modal="true" aria-labelledby="cost-title">
        <h3 id="cost-title">成本与耗时</h3>
        <p>
          口径：turn_metric 的 token 与预设计价；字数取 revision 清单。费用是本地估算，以供应商账单为准。
        </p>

        <div className="cost-toolbar">
          <div className="write-toggle" role="radiogroup" aria-label="报表范围">
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'book'}
              className={scope === 'book' ? 'is-active' : ''}
              data-testid="cost-scope-book"
              onClick={() => switchScope('book')}
            >
              全书
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'chapter'}
              className={scope === 'chapter' ? 'is-active' : ''}
              data-testid="cost-scope-chapter"
              disabled={chapterId === null}
              title={chapterId === null ? '先在创作台选择一章' : (chapterTitle ?? undefined)}
              onClick={() => switchScope('chapter')}
            >
              本章
            </button>
          </div>
          <div className="write-toggle" role="tablist" aria-label="报表视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'chapter'}
              className={tab === 'chapter' ? 'is-active' : ''}
              data-testid="cost-tab-chapter"
              onClick={() => setTab('chapter')}
            >
              按章
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'agent'}
              className={tab === 'agent' ? 'is-active' : ''}
              data-testid="cost-tab-agent"
              onClick={() => setTab('agent')}
            >
              按 Agent
            </button>
          </div>
        </div>

        {error !== null ? (
          <p className="cost-error" data-testid="cost-error">
            {error}
          </p>
        ) : null}

        {report !== null ? (
          <>
            <div className="cost-summary" data-testid="cost-summary">
              <span>
                合计 <strong data-testid="cost-total-cost">{CNY(report.total.costCny)}</strong>
              </span>
              <span>
                字数 <strong data-testid="cost-total-words">{report.total.words}</strong>
              </span>
              <span>
                每万字 <strong data-testid="cost-total-per10k">{PER10K(report.total.costPer10k)}</strong>
              </span>
              <span>
                token{' '}
                <strong data-testid="cost-total-tokens">
                  {formatBudgetTokens(report.total.tokensIn + report.total.tokensOut)}
                </strong>
              </span>
              <span>
                确认耗时 P50 <strong data-testid="cost-confirm-p50">{LATENCY(report.confirm.p50)}</strong> · P95{' '}
                <strong data-testid="cost-confirm-p95">{LATENCY(report.confirm.p95)}</strong>
              </span>
              <span data-testid="cost-cache">
                缓存命中{' '}
                <strong>
                  {report.cache.cacheCalls === 0
                    ? '未报告'
                    : `${formatBudgetTokens(report.cache.cachedTokens)} · ${percent(report.cache.hitRate ?? 0)}`}
                </strong>
              </span>
            </div>

            {unpriced ? (
              <p className="cost-note" data-testid="cost-unpriced-note">
                有 {report.total.unpricedCalls} 次调用没有计价：显示的费用是下限，不是 0；占比
                {report.shareBasis === 'tokens' ? '按 token（标「按 token」）' : '按费用'}。
              </p>
            ) : null}
            {report.shareBasis === 'tokens' && !unpriced ? (
              <p className="cost-note">没有可用的计价：占比按 token 展示。</p>
            ) : null}

            {empty ? (
              <p className="pane-empty" data-testid="cost-empty">
                还没有模型调用：生成一拍、跑一次审批或记忆抽取后再看。
              </p>
            ) : tab === 'chapter' ? (
              <ChapterTable report={report} />
            ) : (
              <AgentTable report={report} />
            )}

            <p className="cost-note">
              项目级：{report.projectLevel.calls} 次规划调用 {CNY(report.projectLevel.costCny)}（不摊到章）。每拍确认耗时只统计作者确认，自动确认不计入；
              缺失 {report.confirm.missingBeats} 拍不补 0。P95 在样本少于 5 时只显示 P50（线性插值）。
              缓存命中只统计供应商报告了的调用（{report.cache.cacheCalls}/{report.cache.calls} 次）；未报告不显示 0%。
            </p>
          </>
        ) : loading ? (
          <p className="cost-note">正在汇总…</p>
        ) : null}

        {chapterId !== null ? (
          <div className="cost-budget" data-testid="cost-budget-editor">
            <span className="cost-budget__title">本章预算</span>
            <label className="export-field">
              <span>费用上限（¥）</span>
              <input
                type="number"
                min={0}
                max={MAX_CHAPTER_BUDGET_CNY}
                step={0.01}
                data-testid="cost-budget-input"
                value={budgetText}
                onChange={(event) => setBudgetText(event.target.value)}
              />
            </label>
            <label className="export-field">
              <span>token 上限</span>
              <input
                type="number"
                min={0}
                step={1000}
                data-testid="cost-budget-tokens"
                value={tokensText}
                onChange={(event) => setTokensText(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="plan-btn is-primary"
              data-testid="cost-budget-save"
              disabled={saving || !budgetsValid}
              onClick={() => void saveBudget()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="cost-budget-reset"
              disabled={saving}
              onClick={() => void resetBudget()}
            >
              恢复默认
            </button>
            {budgetError !== null ? (
              <span className="cost-error" data-testid="cost-budget-error">
                {budgetError}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="plan-modal__actions">
          <button type="button" className="plan-mini-btn" onClick={onClose} data-testid="cost-close">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

const CHAPTER_COLUMNS = 'minmax(0,1.6fr) 72px 80px 88px 84px 60px 64px 64px'
const AGENT_COLUMNS = 'minmax(0,1.2fr) 80px 64px 84px 60px 64px 64px'

function ChapterTable({ report }: { report: CostReport }): React.JSX.Element {
  const rows = report.byChapter
  return (
    <div className="cost-table-wrap" data-testid="cost-table-chapter">
      <div className="cost-row cost-row--head" style={{ gridTemplateColumns: CHAPTER_COLUMNS }} role="row">
        <span>章</span>
        <span>字数</span>
        <span>费用</span>
        <span>每万字</span>
        <span>token</span>
        <span>调用</span>
        <span>P50</span>
        <span>P95</span>
      </div>
      {rows.length > 100 ? (
        <VirtualList
          items={rows}
          activeIndex={-1}
          onActivate={() => undefined}
          ariaLabel="按章成本"
          testId="cost-chapter-rows"
          className="cost-vlist"
          renderRow={(row) => (
            <div className="cost-row" style={{ gridTemplateColumns: CHAPTER_COLUMNS }} role="row" data-testid={`cost-row-${row.chapterId}`}>
              <span className="cost-row__title">
                {row.ord > 0 ? `第 ${row.ord} 章 · ` : ''}
                {row.title}
              </span>
              <span>{row.words}</span>
              <span>{CNY(row.costCny)}</span>
              <span>{PER10K(row.costPer10k)}</span>
              <span>{formatBudgetTokens(row.tokensIn + row.tokensOut)}</span>
              <span>{row.calls}</span>
              <span>{LATENCY(row.latencyP50)}</span>
              <span>{LATENCY(row.latencyP95)}</span>
            </div>
          )}
        />
      ) : (
        rows.map((row) => (
          <div className="cost-row" style={{ gridTemplateColumns: CHAPTER_COLUMNS }} role="row" key={row.chapterId} data-testid={`cost-row-${row.chapterId}`}>
            <span className="cost-row__title">
              {row.ord > 0 ? `第 ${row.ord} 章 · ` : ''}
              {row.title}
            </span>
            <span>{row.words}</span>
            <span>{CNY(row.costCny)}</span>
            <span>{PER10K(row.costPer10k)}</span>
            <span>{formatBudgetTokens(row.tokensIn + row.tokensOut)}</span>
            <span>{row.calls}</span>
            <span>{LATENCY(row.latencyP50)}</span>
            <span>{LATENCY(row.latencyP95)}</span>
          </div>
        ))
      )}
    </div>
  )
}

function AgentTable({ report }: { report: CostReport }): React.JSX.Element {
  return (
    <div className="cost-table-wrap" data-testid="cost-table-agent">
      <div className="cost-row cost-row--head" style={{ gridTemplateColumns: AGENT_COLUMNS }} role="row">
        <span>Agent</span>
        <span>费用</span>
        <span>占比</span>
        <span>token</span>
        <span>调用</span>
        <span>P50</span>
        <span>P95</span>
      </div>
      {report.byAgent.map((row) => (
        <div className="cost-row" style={{ gridTemplateColumns: AGENT_COLUMNS }} role="row" key={row.agentKey} data-testid={`cost-agent-${row.agentKey}`}>
          <span className="cost-row__title">
            {row.label} <span className="mono">{row.agentKey}</span>
          </span>
          <span>{CNY(row.costCny)}</span>
          <span>{percent(row.share)}</span>
          <span>{formatBudgetTokens(row.tokensIn + row.tokensOut)}</span>
          <span>{row.calls}</span>
          <span>{LATENCY(row.latencyP50)}</span>
          <span>{LATENCY(row.latencyP95)}</span>
        </div>
      ))}
    </div>
  )
}
