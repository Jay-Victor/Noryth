import type { DegradeLevel, ToolPayload, ToolRef } from './types'
import { estimateTokens } from './tokens'

/**
 * 截断：按条目整条丢弃，不切 quote 中间（DEV-PLAN §6.7）。
 * 顺序：先丢 refs 尾部 → 再丢 data 里的数组条目 → 仍超预算则整体降级为 summary。
 */

export interface TruncatedPayload {
  payload: ToolPayload<unknown>
  truncated: boolean
  total?: number
  degraded: DegradeLevel
}

function tokensOf(value: unknown): number {
  return estimateTokens(JSON.stringify(value))
}

interface ArraySlot {
  path: (string | number)[]
  length: number
}

function largestArray(root: unknown): ArraySlot | null {
  let best: ArraySlot | null = null
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (Array.isArray(node)) {
      if (node.length > 0 && (!best || node.length > best.length)) best = { path: [...path], length: node.length }
      node.forEach((item, index) => walk(item, [...path, index]))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key])
    }
  }
  walk(root, [])
  return best
}

function getAt(root: unknown, path: (string | number)[]): unknown {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[key]
  }
  return node
}

export function truncatePayload(payload: ToolPayload<unknown>, maxResultTokens: number): TruncatedPayload {
  const clone: ToolPayload<unknown> = {
    data: payload.data,
    refs: payload.refs ? [...payload.refs] : [],
    degraded: payload.degraded ?? 'none',
    ...(payload.filteredCount === undefined ? {} : { filteredCount: payload.filteredCount }),
    ...(payload.total === undefined ? {} : { total: payload.total }),
    ...(payload.truncated === undefined ? {} : { truncated: payload.truncated })
  }

  let truncated = payload.truncated ?? false
  let total = payload.total

  const budgetOf = (): number => tokensOf({ data: clone.data, refs: clone.refs })
  if (budgetOf() <= maxResultTokens) {
    return { payload: clone, truncated, ...(total === undefined ? {} : { total }), degraded: clone.degraded ?? 'none' }
  }

  // 1) 丢 refs 尾部
  if (clone.refs && clone.refs.length > 0) {
    const original = clone.refs.length
    while (clone.refs.length > 0 && budgetOf() > maxResultTokens) {
      clone.refs.pop()
    }
    truncated = true
    total = original
  }

  // 2) 丢 data 里最长的数组尾部（整条丢弃）
  while (budgetOf() > maxResultTokens) {
    const slot = largestArray(clone.data)
    if (!slot) break
    const container = getAt(clone.data, slot.path) as unknown[]
    if (!Array.isArray(container) || container.length === 0) break
    if (total === undefined) total = container.length
    container.pop()
    truncated = true
  }

  // 3) 仍然超预算：整体降级，不切 quote
  if (budgetOf() > maxResultTokens) {
    clone.data = { truncated: true }
    clone.refs = []
    truncated = true
    total = total ?? 1
    clone.degraded = 'summary'
  }

  return { payload: clone, truncated, ...(total === undefined ? {} : { total }), degraded: clone.degraded ?? 'none' }
}

/** 只计算引用条数，供 truncated 的 total 使用。 */
export function refCount(refs: readonly ToolRef[] | undefined): number {
  return refs?.length ?? 0
}
