import { create } from 'zustand'
import type { SliceBeatEvent, SliceState } from '../../shared/schema/slice'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

/**
 * 切片页的流式状态（PHASE-05 §5.3）。
 *
 * - delta 先进入 32ms 缓冲，再一次性写入 store；不逐字 setState。
 * - 只更新事件里的 beatId；已确认拍不接收事件，也不会被重排。
 * - start → delta* → validated → committed / failed；其余字段以主进程返回的
 *   SliceState 为准（正文、依据、revision 都由 DB 读回）。
 */

interface SliceStoreState {
  state: SliceState | null
  streaming: Record<string, string>
  busyBeatId: string | null
  error: string | null
  load(): Promise<void>
  seed(): Promise<void>
  generate(beatId: string): Promise<void>
  regenerate(beatId: string): Promise<void>
  confirm(beatId: string): Promise<void>
  edit(beatId: string, body: string): Promise<void>
  applyEvent(event: SliceBeatEvent): void
  reset(): void
}

let pending = new Map<string, string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (pending.size === 0) return
    const updates = Object.fromEntries(pending)
    useSlice.setState((current) => ({ streaming: { ...current.streaming, ...updates } }))
  }, 32)
}

function clearPending(): void {
  pending = new Map()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function toastError(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'error', title: message, ...(detail ? { detail } : {}), key: 'slice' })
}

export const useSlice = create<SliceStoreState>((set, get) => {
  const applyResultState = (next: SliceState): void => {
    set({ state: next, error: null })
  }

  return {
    state: null,
    streaming: {},
    busyBeatId: null,
    error: null,

    async load() {
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      const result = await bridge.slice.state()
      if (!result.ok) {
        set({ error: result.error.message })
        toastError(result.error.message, result.error.code)
        return
      }
      applyResultState(result.data)
    },

    async seed() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.slice.seed()
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      await get().load()
    },

    async generate(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      pending.set(beatId, '')
      set({ busyBeatId: beatId, error: null, streaming: { ...get().streaming, [beatId]: '' } })
      const result = await bridge.slice.generate(beatId)
      set({ busyBeatId: null })
      if (!result.ok) {
        clearPending()
        set({ streaming: omit(get().streaming, beatId), error: result.error.message })
        toastError(result.error.message, result.error.code)
        await get().load()
        return
      }
      clearPending()
      set({ streaming: omit(get().streaming, beatId) })
      applyResultState(result.data.state)
      if (result.data.status === 'rejected') {
        set({ error: result.data.rejection?.message ?? '本拍未通过校验' })
      }
    },

    async regenerate(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      set({ busyBeatId: beatId, error: null, streaming: { ...get().streaming, [beatId]: '' } })
      const result = await bridge.slice.regenerate(beatId)
      set({ busyBeatId: null })
      if (!result.ok) {
        clearPending()
        set({ streaming: omit(get().streaming, beatId), error: result.error.message })
        toastError(result.error.message, result.error.code)
        await get().load()
        return
      }
      clearPending()
      set({ streaming: omit(get().streaming, beatId) })
      applyResultState(result.data.state)
    },

    async confirm(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      // 乐观更新：确认后下一拍占位立刻可见，不等 IPC 往返（<150ms 要求）。
      const current = get().state
      if (current) {
        set({
          state: {
            ...current,
            beats: current.beats.map((beat) =>
              beat.id === beatId ? { ...beat, status: 'confirmed' } : beat
            )
          }
        })
      }
      const result = await bridge.slice.confirm(beatId)
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load()
        return
      }
      applyResultState(result.data)
    },

    async edit(beatId, body) {
      const bridge = getBridge()
      if (!bridge) return
      const revision = get().state?.revisionId ?? null
      const result = await bridge.slice.edit({ beatId, body, expectedRevision: revision })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load()
        return
      }
      applyResultState(result.data)
    },

    applyEvent(event) {
      if (event.phase === 'start') {
        pending.set(event.beatId, '')
        const current = get().state
        set({
          busyBeatId: event.beatId,
          error: null,
          streaming: { ...get().streaming, [event.beatId]: '' },
          ...(current
            ? {
                state: {
                  ...current,
                  beats: current.beats.map((beat) =>
                    beat.id === event.beatId ? { ...beat, status: 'generating' } : beat
                  )
                }
              }
            : {})
        })
        return
      }
      if (event.phase === 'delta') {
        pending.set(event.beatId, (pending.get(event.beatId) ?? '') + (event.delta ?? ''))
        scheduleFlush()
        return
      }
      if (event.phase === 'committed' || event.phase === 'failed') {
        pending.delete(event.beatId)
        set({
          busyBeatId: null,
          streaming: omit(get().streaming, event.beatId),
          ...(event.phase === 'failed' ? { error: event.code ?? '本拍失败' } : {})
        })
      }
    },

    reset() {
      clearPending()
      set({ state: null, streaming: {}, busyBeatId: null, error: null })
    }
  }
})

function omit(record: Record<string, string>, key: string): Record<string, string> {
  const next = { ...record }
  delete next[key]
  return next
}
