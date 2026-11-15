import { describe, expect, it } from 'vitest'
import {
  CHANGE_APPLY_HINTS,
  CHANGE_STATUS_LABELS,
  COVERAGE_SEVERITY_LABELS,
  changeApplyState,
  coverageSummary,
  foreshadowDistanceText
} from '../../src/shared/domain/blueprint-view'

/**
 * 状态矩阵 fixture（AGENTS「完成标准 3」/ PHASE-15 §6）：
 * 覆盖检查四态摘要、变更四态（未分析/可应用/已应用/已拒绝）、伏笔距离四态。
 * 每个状态都必须有可读文案，且文案唯一（避免 UI 出现两个同词状态）。
 */

const impact = {
  analyzed: true as const,
  analyzed_at: '2026-11-15T00:00:00.000Z',
  chapters: [],
  memory_entries: [],
  relationships: [],
  counts: { chapters: 0, memory_entries: 0, relationships: 0 }
}

describe('覆盖检查 / 变更 UI 状态矩阵', () => {
  it('覆盖检查摘要四态：阻断（开/关）与建议与通过', () => {
    expect(coverageSummary({ errorCount: 2, warnCount: 0, gate: true })).toBe('2 项阻断，G1 暂不可确认')
    expect(coverageSummary({ errorCount: 1, warnCount: 0, gate: false })).toBe('1 项阻断，但已关闭阻断')
    expect(coverageSummary({ errorCount: 0, warnCount: 3, gate: true })).toBe('3 项建议，不阻断 G1')
    expect(coverageSummary({ errorCount: 0, warnCount: 0, gate: true })).toBe('没有发现问题')

    const labels = Object.values(COVERAGE_SEVERITY_LABELS)
    expect(labels).toEqual(['阻断', '建议'])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('变更四态：未分析 / 可应用 / 已应用 / 已拒绝', () => {
    expect(changeApplyState({ status: 'proposed', impact: null })).toBe('unanalyzed')
    expect(changeApplyState({ status: 'proposed', impact })).toBe('ready')
    expect(changeApplyState({ status: 'applied', impact })).toBe('applied')
    expect(changeApplyState({ status: 'rejected', impact: null })).toBe('rejected')

    const labels = Object.values(CHANGE_STATUS_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
    const hints = Object.values(CHANGE_APPLY_HINTS)
    expect(hints.every((hint) => hint.trim().length > 0)).toBe(true)
    expect(new Set(hints).size).toBe(hints.length)
    expect(CHANGE_APPLY_HINTS.unanalyzed).toContain('影响分析')
  })

  it('伏笔距离四态：本章埋设 / 已 N 章 / 超计划 / 已回收', () => {
    expect(
      foreshadowDistanceText({ status: 'open', distance: 0, overdue: false, plantedOrd: 1, payoffOrd: null })
    ).toBe('本章埋设')
    expect(
      foreshadowDistanceText({ status: 'open', distance: 3, overdue: false, plantedOrd: 1, payoffOrd: null })
    ).toBe('已 3 章未回收')
    expect(
      foreshadowDistanceText({ status: 'open', distance: 7, overdue: true, plantedOrd: 1, payoffOrd: 5 })
    ).toBe('已 7 章未回收（超计划）')
    expect(
      foreshadowDistanceText({ status: 'closed', distance: 0, overdue: false, plantedOrd: 1, payoffOrd: 2 })
    ).toBe('已在第 2 章回收')
    expect(
      foreshadowDistanceText({ status: 'open', distance: 0, overdue: false, plantedOrd: null, payoffOrd: null })
    ).toBe('没有埋设章')
  })
})
