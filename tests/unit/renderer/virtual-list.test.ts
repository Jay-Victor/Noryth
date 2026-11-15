import { describe, expect, it } from 'vitest'
import { visibleRange } from '../../../src/renderer/components/VirtualList'

/**
 * 虚拟列表窗口（PHASE-11 M1-9）。
 *
 * 1,000 行时 DOM 只应有「可视行 + 2×overscan」；滚动到中部/末尾也不能越界。
 */
describe('visibleRange', () => {
  it('1,000 行、480px 视口：只渲染可视区 + 两侧 overscan', () => {
    const window = visibleRange({ total: 1_000, scrollTop: 0, rowHeight: 32, viewportHeight: 480, overscan: 8 })
    expect(window.start).toBe(0)
    // 480/32 = 15 行 + 8（下方 overscan；上方被 0 截断）= 23
    expect(window.end).toBe(23)
    expect(window.end - window.start).toBeLessThan(40)
  })

  it('滚到中部：上下各 8 行 overscan，窗口大小稳定', () => {
    const scrollTop = 16_000 // 第 500 行
    const window = visibleRange({ total: 1_000, scrollTop, rowHeight: 32, viewportHeight: 480, overscan: 8 })
    expect(window.start).toBe(500 - 8)
    expect(window.end).toBe(500 + 15 + 8)
    expect(window.end - window.start).toBe(31)
  })

  it('滚到末尾：end 不越过总数，start 不为负', () => {
    const window = visibleRange({ total: 1_000, scrollTop: 32_000, rowHeight: 32, viewportHeight: 480, overscan: 8 })
    expect(window.end).toBe(1_000)
    expect(window.start).toBe(992)

    const top = visibleRange({ total: 1_000, scrollTop: -10, rowHeight: 32, viewportHeight: 480, overscan: 8 })
    expect(top.start).toBe(0)
  })

  it('空列表与零高度不产生渲染行', () => {
    expect(visibleRange({ total: 0, scrollTop: 0, rowHeight: 32, viewportHeight: 480, overscan: 8 })).toEqual({
      start: 0,
      end: 0
    })
    const noHeight = visibleRange({ total: 10, scrollTop: 0, rowHeight: 32, viewportHeight: 0, overscan: 8 })
    expect(noHeight.end - noHeight.start).toBe(1 + 8)
  })
})
