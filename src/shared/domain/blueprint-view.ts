import type { BlueprintChangeView, PlanCoverageState } from '../schema/blueprint'

/**
 * 覆盖检查 / 蓝图变更的 UI 状态词表（PHASE-15 §6 状态矩阵 fixture）。
 *
 * 单一来源：组件与单测都读这里，避免「界面写一套、测试写一套」。
 * 文案只回答「能不能继续」，不解释「为什么被拒」（DEV-PLAN §18.2）。
 */

export const COVERAGE_SEVERITY_LABELS = {
  error: '阻断',
  warn: '建议'
} as const

export const CHANGE_STATUS_LABELS = {
  proposed: '待确认',
  applied: '已应用',
  rejected: '已拒绝'
} as const

export type ChangeApplyState = 'unanalyzed' | 'ready' | 'applied' | 'rejected'

export const CHANGE_APPLY_HINTS: Record<ChangeApplyState, string> = {
  unanalyzed: '还没有影响分析：应用会被拒绝（不能假装没有影响）',
  ready: '影响分析已完成：确认后应用，正文不会自动改',
  applied: '已应用：受影响章节标为待重审',
  rejected: '已拒绝：大纲与角色卡都没有改动'
}

/** 变更卡片的状态：未分析 / 可应用 / 已应用 / 已拒绝。 */
export function changeApplyState(change: Pick<BlueprintChangeView, 'status' | 'impact'>): ChangeApplyState {
  if (change.status === 'applied') return 'applied'
  if (change.status === 'rejected') return 'rejected'
  return change.impact === null ? 'unanalyzed' : 'ready'
}

/** 覆盖检查一句话摘要：阻断项优先，其次是建议项，最后是「没有发现问题」。 */
export function coverageSummary(coverage: Pick<PlanCoverageState, 'errorCount' | 'warnCount' | 'gate'>): string {
  if (coverage.errorCount > 0) {
    return coverage.gate ? `${coverage.errorCount} 项阻断，G1 暂不可确认` : `${coverage.errorCount} 项阻断，但已关闭阻断`
  }
  if (coverage.warnCount > 0) return `${coverage.warnCount} 项建议，不阻断 G1`
  return '没有发现问题'
}

/** 伏笔距离文案（ForeshadowPanel 与 T22 的 note 同口径）。 */
export function foreshadowDistanceText(item: {
  status: 'open' | 'closed'
  distance: number
  overdue: boolean
  plantedOrd: number | null
  payoffOrd: number | null
}): string {
  if (item.status === 'closed') return `已在第 ${item.payoffOrd ?? '?'} 章回收`
  if (item.plantedOrd === null) return '没有埋设章'
  if (item.distance === 0) return '本章埋设'
  return item.overdue ? `已 ${item.distance} 章未回收（超计划）` : `已 ${item.distance} 章未回收`
}
