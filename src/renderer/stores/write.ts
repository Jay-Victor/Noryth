import { create } from 'zustand'
import type { WriteActionResult, WriteEvent, WriteState } from '../../shared/schema/write'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

/**
 * 创作台状态（PHASE-07 F5）。
 *
 * - 流式增量先进 32ms 缓冲，再一次性写入；只更新事件里的 beatId。
 * - 已确认拍不接收 delta，也不会被重排（照 UI-DESIGN §5.4：冻结已确认 key）。
 * - 正文、状态、revision 一律以主进程返回的 WriteState 为准；流式文本只是预览。
 */

interface WriteStoreState {
  state: WriteState | null
  loading: boolean
  busy: boolean
  streaming: Record<string, string>
  thoughts: Record<string, string>
  editingBeatId: string | null
  editDraft: string
  /** 编辑已确认拍后的三选一（默认开新分支）。 */
  stalePrompt: { beatId: string; count: number } | null
  tab: 'prose' | 'storyboard'
  /** 执行流 / 编排对话 */
  chatTab: 'chat' | 'stream'
  error: string | null
  load(chapterId?: string): Promise<void>
  setTab(tab: 'prose' | 'storyboard'): void
  setChatTab(tab: 'chat' | 'stream'): void
  setChapter(chapterId: string): Promise<void>
  generate(beatId: string): Promise<void>
  regenerate(beatId: string): Promise<void>
  confirm(beatId: string): Promise<void>
  startEdit(beatId: string, body: string): void
  setEditDraft(body: string): void
  saveEdit(): Promise<void>
  cancelEdit(): void
  resolveStale(choice: 'replace' | 'rerun' | 'branch'): Promise<void>
  saveStoryboard(scenes: WriteState['storyboard']['scenes']): Promise<void>
  confirmG2(): Promise<void>
  startAuto(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  cancel(): Promise<void>
  send(text: string): Promise<void>
  applyEvent(event: WriteEvent): void
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
    useWrite.setState((current) => ({ streaming: { ...current.streaming, ...updates } }))
  }, 32)
}

function clearPending(): void {
  pending = new Map()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function toastError(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'error', title: message, ...(detail ? { detail } : {}), key: 'write' })
}

function toastOk(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'success', title: message, ...(detail ? { detail } : {}), key: 'write' })
}

export const useWrite = create<WriteStoreState>((set, get) => {
  const apply = (next: WriteState): void => set({ state: next, error: null })

  const run = async (fn: () => Promise<{ ok: true; data: WriteActionResult } | { ok: false; error: { message: string; code: string } }>): Promise<void> => {
    set({ busy: true })
    const result = await fn()
    set({ busy: false })
    if (!result.ok) {
      toastError(result.error.message, result.error.code)
      set({ error: result.error.message })
      return
    }
    apply(result.data.state)
    if (result.data.detail) toastOk(result.data.detail)
  }

  return {
    state: null,
    loading: false,
    busy: false,
    streaming: {},
    thoughts: {},
    editingBeatId: null,
    editDraft: '',
    stalePrompt: null,
    tab: 'prose',
    chatTab: 'chat',
    error: null,

    async load(chapterId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ loading: true })
      clearPending()
      const result = await bridge.write.state(chapterId)
      set({ loading: false })
      if (!result.ok) {
        set({ error: result.error.message })
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data)
    },

    async setChapter(chapterId) {
      clearPending()
      await get().load(chapterId)
    },

    setTab(tab) {
      set({ tab })
    },

    setChatTab(chatTab) {
      set({ chatTab })
    },

    async generate(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      set({
        busy: true,
        streaming: { ...get().streaming, [beatId]: '' },
        thoughts: { ...get().thoughts, [beatId]: '' }
      })
      const result = await bridge.write.generate(beatId)
      set({ busy: false, streaming: omit(get().streaming, beatId), thoughts: omit(get().thoughts, beatId) })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(get().state?.chapterId)
        return
      }
      apply(result.data.state)
      if (result.data.detail) toastOk(result.data.detail)
    },

    async regenerate(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      set({
        busy: true,
        streaming: { ...get().streaming, [beatId]: get().state?.scenes.flatMap((s) => s.beats).find((b) => b.id === beatId)?.body ?? '' },
        thoughts: { ...get().thoughts, [beatId]: '' }
      })
      const result = await bridge.write.regenerate(beatId)
      set({ busy: false, streaming: omit(get().streaming, beatId), thoughts: omit(get().thoughts, beatId) })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(get().state?.chapterId)
        return
      }
      apply(result.data.state)
      if (result.data.detail) toastOk(result.data.detail)
    },

    async confirm(beatId) {
      const bridge = getBridge()
      if (!bridge) return
      // 乐观更新：150ms 内让下一拍占位可见（不等 IPC 往返）。
      set((current) => {
        if (!current.state) return {}
        return {
          state: {
            ...current.state,
            scenes: current.state.scenes.map((scene) => ({
              ...scene,
              beats: scene.beats.map((beat) =>
                beat.id === beatId ? { ...beat, status: 'confirmed' as const, needsAttention: false } : beat
              ),
              confirmed: scene.beats.some((beat) => beat.id === beatId) ? scene.confirmed + 1 : scene.confirmed
            })),
            progress: { ...current.state.progress, confirmed: current.state.progress.confirmed + 1 }
          }
        }
      })
      await run(() => bridge.write.confirm(beatId))
    },

    startEdit(beatId, body) {
      set({ editingBeatId: beatId, editDraft: body })
    },

    setEditDraft(body) {
      set({ editDraft: body })
    },

    cancelEdit() {
      set({ editingBeatId: null, editDraft: '' })
    },

    async saveEdit() {
      const bridge = getBridge()
      const { editingBeatId, editDraft, state } = get()
      if (!bridge || !editingBeatId || !state) return
      const beat = state.scenes.flatMap((scene) => scene.beats).find((item) => item.id === editingBeatId)
      set({ busy: true })
      const result = await bridge.write.edit({
        beatId: editingBeatId,
        body: editDraft,
        expectedRevision: state.revisionId
      })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      set({ editingBeatId: null, editDraft: '' })
      apply(result.data.state)
      if (beat && (beat.status === 'confirmed' || beat.status === 'author_edited')) {
        set({ stalePrompt: { beatId: beat.id, count: 1 } })
      }
      if (result.data.detail) toastOk(result.data.detail)
    },

    async resolveStale(choice) {
      const bridge = getBridge()
      const { stalePrompt, state } = get()
      if (!bridge || !state) return
      set({ stalePrompt: null })
      const beatId = stalePrompt?.beatId ?? state.currentBeatId
      if (!beatId) return
      await run(() => bridge.write.resolveStale({ chapterId: state.chapterId, beatId, choice }))
    },

    async saveStoryboard(scenes) {
      const bridge = getBridge()
      const { state } = get()
      if (!bridge || !state) return
      const result = await bridge.write.saveStoryboard({ chapterId: state.chapterId, scenes })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
      const hard = result.data.conflicts.filter((conflict) => conflict.severity === 'hard').length
      toastOk(hard === 0 ? '分镜已保存（无硬冲突）' : `分镜已保存，仍有 ${hard} 条硬冲突`, hard === 0 ? undefined : result.data.conflicts[0]?.message)
    },

    async confirmG2() {
      const state = get().state
      if (!state) return
      const bridge = getBridge()
      if (!bridge) return
      await run(() => bridge.write.confirmG2(state.chapterId))
    },

    async startAuto() {
      const state = get().state
      if (!state) return
      const bridge = getBridge()
      if (!bridge) return
      clearPending()
      // 自动模式是长任务：先置运行态，再等结果（事件负责流式）。
      set({ busy: true })
      const result = await bridge.write.autoStart(state.chapterId)
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(state.chapterId)
        return
      }
      apply(result.data.state)
      if (result.data.detail) toastOk(result.data.detail)
    },

    async pause() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const result = await bridge.write.pause(state.chapterId)
      if (result.ok) apply(result.data.state)
    },

    async resume() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      set({ busy: true })
      const result = await bridge.write.resume(state.chapterId)
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(state.chapterId)
        return
      }
      apply(result.data.state)
    },

    async cancel() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const result = await bridge.write.cancel(state.chapterId)
      if (result.ok) apply(result.data.state)
    },

    async send(text) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || text.trim().length === 0) return
      set({ busy: true })
      const result = await bridge.write.send({ chapterId: state.chapterId, text: text.trim() })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
      if (result.data.storyboardUpdated) set({ tab: 'storyboard' })
    },

    applyEvent(event) {
      const state = get().state
      if (!state || event.chapterId !== state.chapterId) return
      if (event.phase === 'delta') {
        if (event.beatId) {
          pending.set(event.beatId, event.full ?? '')
          scheduleFlush()
          return
        }
        // 编排对话的流式：直接写进最后一条 assistant 气泡。
        if (event.full !== undefined) {
          useWrite.setState((current) => {
            if (!current.state) return {}
            const messages = [...current.state.messages]
            const last = messages[messages.length - 1]
            if (last && last.role === 'orchestrator' && last.body === '') {
              messages[messages.length - 1] = { ...last, body: event.full ?? '' }
            } else {
              messages.push({
                id: `stream_${event.turnId}`,
                role: 'orchestrator',
                kind: 'text',
                body: event.full ?? '',
                createdAt: new Date().toISOString()
              })
            }
            return { state: { ...current.state, messages } }
          })
        }
        return
      }
      if (event.phase === 'thought') {
        if (!event.beatId) return
        set({ thoughts: { ...get().thoughts, [event.beatId]: event.full ?? '' } })
        return
      }
      if (event.phase === 'committed' || event.phase === 'failed' || event.phase === 'paused') {
        // 终态由主进程状态兜底；这里只清掉流式缓冲，避免残影。
        clearPending()
        const beatId = event.beatId
        if (beatId) set({ streaming: omit(get().streaming, beatId) })
      }
    },

    reset() {
      clearPending()
      set({
        state: null,
        streaming: {},
        thoughts: {},
        editingBeatId: null,
        editDraft: '',
        stalePrompt: null,
        tab: 'prose',
        chatTab: 'chat',
        error: null
      })
    }
  }
})
