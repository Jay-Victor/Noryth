import { describe, expect, it } from 'vitest'
import { MEMORY_PAGE_SIZE, pageCount, pageSlice } from '../../../src/shared/domain/pagination'

/**
 * 记忆台分页（PHASE-23 M2-6）。
 *
 * 3,000 条记忆时只渲染当前页 50 行；页码越界夹紧到最后一页，
 * 计数与页数仍按过滤后的全集。
 */
describe('pageSlice', () => {
  const items = Array.from({ length: 3_000 }, (_, index) => index)

  it('默认页大小 50，第 1 页只含前 50 行', () => {
    const view = pageSlice(items, 0)
    expect(MEMORY_PAGE_SIZE).toBe(50)
    expect(view.items).toHaveLength(50)
    expect(view.items[0]).toBe(0)
    expect(view.items.at(-1)).toBe(49)
    expect(view.pages).toBe(60)
    expect(view.total).toBe(3_000)
  })

  it('最后一页可以不足 50 行，页码不越界', () => {
    const view = pageSlice(items, 59)
    expect(view.page).toBe(59)
    expect(view.items).toHaveLength(50)
    expect(view.items.at(-1)).toBe(2_999)
  })

  it('页码越界夹紧：超出取最后一页，负数取第一页', () => {
    expect(pageSlice(items, 999).page).toBe(59)
    expect(pageSlice(items, 999).items.at(-1)).toBe(2_999)
    expect(pageSlice(items, -3).page).toBe(0)
    expect(pageSlice(items, -3).items[0]).toBe(0)
  })

  it('空列表与不足一页', () => {
    const empty = pageSlice([], 0)
    expect(empty).toEqual({ items: [], page: 0, pages: 0, total: 0 })
    const single = pageSlice(['a', 'b'], 5)
    expect(single.items).toEqual(['a', 'b'])
    expect(single.pages).toBe(1)
    expect(single.page).toBe(0)
  })

  it('pageCount 与页大小无关地取整', () => {
    expect(pageCount(0)).toBe(0)
    expect(pageCount(50)).toBe(1)
    expect(pageCount(51)).toBe(2)
    expect(pageCount(120, 20)).toBe(6)
    expect(pageCount(10, 0)).toBe(0)
  })
})
