import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_STATE_LABELS,
  READER_STATE_LABELS,
  budgetNote,
  inspectorStateOf,
  readerStateOf
} from '../../src/shared/domain/world-view'

/**
 * 状态矩阵 fixture（AGENTS「完成标准 3」/ PHASE-13 §5.4）：
 * 世界事实的读者可见性三态、检查器三态、预算提示的三种来源。
 * 每个状态都必须有可读文案，且文案不重复（避免 UI 出现两个同词状态）。
 */

describe('世界状态 UI 状态矩阵', () => {
  it('读者可见性三态覆盖完整、文案唯一', () => {
    expect(readerStateOf({ readerKnown: true, pendingReveal: false })).toBe('known')
    expect(readerStateOf({ readerKnown: false, pendingReveal: true })).toBe('pending')
    expect(readerStateOf({ readerKnown: false, pendingReveal: false })).toBe('none')
    const labels = Object.values(READER_STATE_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.every((label) => label.trim().length > 0)).toBe(true)
  })

  it('检查器三态：加载中 / 没生成过 / 可展示', () => {
    expect(inspectorStateOf({ loading: true, found: null })).toBe('loading')
    expect(inspectorStateOf({ loading: false, found: null })).toBe('missing')
    expect(inspectorStateOf({ loading: false, found: false })).toBe('missing')
    // found=true 优先：加载中拿到旧快照时仍然展示，不闪回骨架。
    expect(inspectorStateOf({ loading: true, found: true })).toBe('ready')
    const labels = Object.values(INSPECTOR_STATE_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('预算提示只在这三种情况出现', () => {
    expect(budgetNote({ exceeded: false, pauseText: null, pauseReason: null })).toBeNull()
    expect(budgetNote({ exceeded: true, pauseText: null, pauseReason: 'budget' })).toContain('已超本章预算')
    expect(budgetNote({ exceeded: true, pauseText: '本章预算用完', pauseReason: 'budget' })).toContain('本章预算用完')
    expect(budgetNote({ exceeded: false, pauseText: null, pauseReason: 'character_refusal' })).toBe(
      '暂停原因：character_refusal'
    )
  })
})
