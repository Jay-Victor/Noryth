/**
 * 列表分页（PHASE-23 M2-6 / UI-DESIGN §7.4）。
 *
 * 记忆台在 10 万字项目里可能有 3,000 条记忆；一次渲染全部行会让每次筛选
 * 都重建数千个 DOM 节点。这里只做纯函数分页：UI 每页渲染 50 行，
 * 计数仍按过滤后的全集显示。
 */

export const MEMORY_PAGE_SIZE = 50

export interface PageSlice<T> {
  items: T[]
  /** 0 基页码（已夹紧到合法范围）。 */
  page: number
  pages: number
  total: number
}

export function pageCount(total: number, size: number = MEMORY_PAGE_SIZE): number {
  if (size <= 0) return 0
  return Math.max(0, Math.ceil(total / size))
}

/**
 * 取第 `page` 页（0 基）。页码越界时夹紧到最后一页；
 * 空列表返回 `pages=0, page=0, items=[]`。
 */
export function pageSlice<T>(items: readonly T[], page: number, size: number = MEMORY_PAGE_SIZE): PageSlice<T> {
  const total = items.length
  const pages = pageCount(total, size)
  if (pages === 0) return { items: [], page: 0, pages: 0, total: 0 }
  const safePage = Math.min(pages - 1, Math.max(0, Math.trunc(page)))
  const start = safePage * size
  return { items: items.slice(start, start + size), page: safePage, pages, total }
}
