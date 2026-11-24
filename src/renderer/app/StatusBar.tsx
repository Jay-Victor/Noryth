import { useEffect, useState } from 'react'
import { formatBudgetCost, formatBudgetTokens } from '../../shared/domain/budget'
import type { WriteBudgetState } from '../../shared/schema/write'
import type { RoutingStatus } from '../../shared/schema/routing'
import { PRESET_LABELS } from '../../shared/schema/settings'
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

const ROUTING_REASON_TEXT: Record<string, string> = {
  primary_unhealthy: '主家故障',
  circuit_open: '主家熔断',
  hetero_second_unhealthy: '异构第二家不可用',
  routing_exhausted: '主备都不可用'
}

function presetLabel(preset: string): string {
  return (PRESET_LABELS as Record<string, string>)[preset] ?? preset
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
  const [routing, setRouting] = useState<RoutingStatus | null>(null)

  useEffect(() => {
    const bridge = getBridge()
    if (bridge === null || projectId === null) {
      setRouting(null)
      return
    }
    let cancelled = false
    void (async () => {
      const result = await bridge.routing.status()
      if (!cancelled && result.ok) setRouting(result.data)
    })()
    // 切换事件到达时立刻更新徽标；不弹模态、不打断写作。
    const off = bridge.events.onRoutingEvent((event) => {
      if (event.projectId !== projectId) return
      setRouting((current) => ({
        enabled: current?.enabled ?? true,
        last: { agentKey: event.agentKey, trace: event.trace },
        health: current?.health ?? []
      }))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId])

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
          {routing?.enabled && routing.last !== null ? (
            <span
              className="statusbar__routing"
              data-testid="status-routing"
              data-reason={routing.last.trace.reason}
              title={`${presetLabel(routing.last.trace.from)} → ${presetLabel(routing.last.trace.to)} · ${
                ROUTING_REASON_TEXT[routing.last.trace.reason] ?? routing.last.trace.reason
              }${routing.last.trace.error === null ? '' : ` · ${routing.last.trace.error}`} · ${routing.last.trace.at.replace('T', ' ').slice(0, 19)}`}
            >
              {routing.last.trace.reason === 'routing_exhausted'
                ? '备用不可用'
                : `备用 ${presetLabel(routing.last.trace.to)}`}
              （{ROUTING_REASON_TEXT[routing.last.trace.reason] ?? routing.last.trace.reason}）
            </span>
          ) : null}
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
