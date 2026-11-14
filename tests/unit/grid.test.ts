import { describe, expect, it } from 'vitest'
import {
  BREAKPOINTS,
  GRID,
  PROSE,
  chatWidth,
  columnWidth,
  fixedWidth,
  gridTemplateColumns,
  modeForWidth,
  previewWidth
} from '../../src/shared/layout/grid'

describe('grid tokens', () => {
  it('断点在 1600 / 1360 / 1280', () => {
    expect(BREAKPOINTS).toEqual({ W1: 1600, W2: 1360, W3: 1280 })
    expect(modeForWidth(1599)).toBe('W2')
    expect(modeForWidth(1600)).toBe('W1')
    expect(modeForWidth(1359)).toBe('W3')
    expect(modeForWidth(1360)).toBe('W2')
    expect(modeForWidth(1280)).toBe('W3')
    expect(modeForWidth(2560)).toBe('W1')
  })

  it('1280 / 1440 / 1600 的栅格宽度与 check_ui_spec.py 一致', () => {
    const cases = [
      { width: 1280, mode: 'W3' as const, sessions: 64, tree: 44, chat: 505.9, preview: 607.1, column: 543 },
      { width: 1440, mode: 'W2' as const, sessions: 248, tree: 44, chat: 495.0, preview: 594.0, column: 530 },
      { width: 1600, mode: 'W1' as const, sessions: 248, tree: 224, chat: 485.9, preview: 583.1, column: 519 }
    ]
    for (const item of cases) {
      expect(modeForWidth(item.width)).toBe(item.mode)
      expect(GRID[item.mode].sessions).toBe(item.sessions)
      expect(GRID[item.mode].tree).toBe(item.tree)
      expect(chatWidth(item.width, item.mode)).toBeCloseTo(item.chat, 1)
      expect(previewWidth(item.width, item.mode)).toBeCloseTo(item.preview, 1)
      expect(Math.round(columnWidth(previewWidth(item.width, item.mode)))).toBe(item.column)
    }
  })

  it('固定栅 = 导航 + 会话 + 树 + 3 条分隔线', () => {
    expect(fixedWidth('W1')).toBe(56 + 248 + 224 + 3)
    expect(fixedWidth('W2')).toBe(56 + 248 + 44 + 3)
    expect(fixedWidth('W3')).toBe(56 + 64 + 44 + 3)
  })

  it('正文列上限 630，32–42 字', () => {
    expect(columnWidth(583.1)).toBe(519.1)
    expect(columnWidth(5000)).toBe(PROSE.maxColumn)
    const chars = columnWidth(5000) / PROSE.fontSize
    expect(chars).toBeGreaterThanOrEqual(PROSE.minChars)
    expect(chars).toBeLessThanOrEqual(PROSE.maxChars)
    expect(gridTemplateColumns('W2')).toBe('56px 248px minmax(0, 1fr) minmax(0, 1.2fr) 44px')
  })
})
