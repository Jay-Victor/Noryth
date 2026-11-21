import { useEffect, useState } from 'react'
import { formatBudgetCost, formatBudgetTokens } from '../../shared/domain/budget'
import type { WriteBudgetState } from '../../shared/schema/write'
import { CostReportDialog } from './CostReportDialog'
import { getBridge } from '../lib/bridge'
import { useApp } from '../stores/app'
import { useWrite } from '../stores/write'

interface BudgetPeek {
  projectId: string
  chapterId: string
  chapterTitle: string
  budget: WriteBudgetState
}

export function StatusBar(): React.JSX.Element {
  const appInfo = useApp((state) => state.appInfo)
  const current = useApp((state) => state.current)
  const costOpen = useApp((state) => state.costOpen)
  const setCostOpen = useApp((state) => state.setCostOpen)
  const writeState = useWrite((state) => state.state)
  const projectId = current?.project.id ?? null
  // 非创作台页面也要显示章预算（UI-DESIGN §2.5）：轻量读一次 write.state，失败静默。
  const [peek, setPeek] = useState<BudgetPeek | null>(null)

  useEffect(() => {
    if (projectId === null) {
      setPeek(null)
      return
    }
    const bridge = getBridge()
    if (!bridge) return
    let cancelled = false
    void (async () => {
      const result = await bridge.write.state()
      if (cancelled || !result.ok) return
      setPeek({
        projectId,
        chapterId: result.data.chapterId,
        chapterTitle: result.data.chapterTitle,
        budget: result.data.budget
      })
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const left = current
    ? `已保存 · schema v${current.project.schemaVersion}`
    : '本地优先 · 项目是文件夹'
  const center = !current
    ? '未打开项目'
    : current.readOnly
      ? '只读 · 写入已在主进程拒绝'
      : current.project.setupState === 'complete'
        ? '蓝图已确认'
        : current.project.setupState === 'failed'
          ? '蓝图已确认 · 建库未完成'
          : '蓝图未确认'
  const right = appInfo
    ? `Noryth ${appInfo.version} · Electron ${appInfo.electron} · 离线可用`
    : 'Noryth'

  // 章预算段（UI-DESIGN §2.5 / PHASE-20 M2-3）：只显示当前项目当前章的数字。
  const live =
    current !== null && writeState !== null && writeState.projectId === current.project.id
      ? {
          chapterId: writeState.chapterId,
          chapterTitle: writeState.chapterTitle,
          budget: writeState.budget
        }
      : peek !== null && peek.projectId === projectId
        ? { chapterId: peek.chapterId, chapterTitle: peek.chapterTitle, budget: peek.budget }
        : null
  const budget = live?.budget ?? null

  return (
    <>
      <footer className="statusbar">
        <span>{left}</span>
        <span className="statusbar__center" data-testid="status-center">
          {center}
        </span>
        <span className="statusbar__right">
          {budget !== null ? (
            <button
              type="button"
              className={`statusbar__budget${budget.exceeded ? ' is-exceeded' : ''}`}
              data-testid="status-budget"
              data-exceeded={budget.exceeded}
              title="打开成本与耗时报表 / 修改本章预算"
              onClick={() => setCostOpen(true)}
            >
              章预算 {formatBudgetCost(budget)} · {formatBudgetTokens(budget.tokensUsed)}/
              {formatBudgetTokens(budget.tokensLimit)} tokens
            </button>
          ) : null}
          {right}
        </span>
      </footer>
      <CostReportDialog
        open={costOpen}
        chapterId={live?.chapterId ?? null}
        chapterTitle={live?.chapterTitle ?? null}
        onClose={() => setCostOpen(false)}
      />
    </>
  )
}
