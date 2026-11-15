/**
 * 世界状态与上下文检查器的 UI 状态矩阵（AGENTS「完成标准 3」/ PHASE-13 §5.4）。
 *
 * 两张小表，纯函数：
 *   - 事实的「读者可见性」：已知 / 未揭示 / 不适用（秘密或不打算揭示）；
 *   - 检查器：加载中 / 这一拍还没生成 / 可展示。
 *
 * 组件只消费这里的文案，避免文案散落在 TSX 里两处漂移。
 */

export type ReaderState = 'known' | 'pending' | 'none'

export const READER_STATE_LABELS: Record<ReaderState, string> = {
  known: '已知',
  pending: '未揭示',
  none: '—'
}

export function readerStateOf(fact: { readerKnown: boolean; pendingReveal: boolean }): ReaderState {
  if (fact.readerKnown) return 'known'
  if (fact.pendingReveal) return 'pending'
  return 'none'
}

export type InspectorState = 'loading' | 'missing' | 'ready'

export const INSPECTOR_STATE_LABELS: Record<InspectorState, string> = {
  loading: '正在读这一拍的上下文…',
  missing: '这一拍还没有生成过，所以没有上下文快照。先点「生成」，再回来看这一轮为什么贵。',
  ready: '这一轮'
}

export function inspectorStateOf(input: { loading: boolean; found: boolean | null }): InspectorState {
  if (input.found === true) return 'ready'
  if (input.loading) return 'loading'
  return 'missing'
}

/** 预算条文案（超预算时说明暂停原因，不提供自动续跑）。 */
export function budgetNote(input: { exceeded: boolean; pauseText: string | null; pauseReason: string | null }): string | null {
  if (!input.exceeded && input.pauseReason === null) return null
  const reason = input.pauseText ?? input.pauseReason ?? '预算耗尽'
  return input.exceeded ? `已超本章预算；暂停原因：${reason}（不会自动续跑）` : `暂停原因：${reason}`
}
