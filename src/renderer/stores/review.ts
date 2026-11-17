import { create } from 'zustand'
import type {
  ReviewActionResult,
  ReviewCompareResult,
  ReviewEvent,
  ReviewFinalizePreview,
  ReviewState
} from '../../shared/schema/review'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

/**
 * 审批台状态（PHASE-08）。
 *
 * - 讨论与报告共用一条流式文本（reviewer 输出）；报告正文以主进程返回的
 *   ReviewState 为准，流式只用于「正在审」的即时感。
 * - G5/G6 令牌只在主进程签发；store 只持有 token，不构造 payload。
 * - 报告生成是长任务：进入页面时若本章已 draft_complete 且没有报告，自动跑一次 G4。
 */

export type ReviewTab = 'draft' | 'report' | 'diff' | 'versions'

interface FinalizeDialog {
  preview: ReviewFinalizePreview
}

interface ReviewStoreState {
  state: ReviewState | null
  loading: boolean
  busy: boolean
  streaming: string
  tab: ReviewTab
  error: string | null
  /** 当前高亮的 issue（N/P 切换）。 */
  activeIssueId: string | null
  /** 当前选中的 patch（A/X 接受/拒绝）。 */
  activePatchId: string | null
  /** 本地待提交的 patch 决定（patchId → accept）；点「执行修订」一次提交。 */
  decisions: Record<string, boolean>
  /** 命令面板「定稿本章」：等审批台状态加载完再开确认框。 */
  finalizeRequested: boolean
  finalizeDialog: FinalizeDialog | null
  /** 重新打开定稿（M1-21）的确认框。 */
  reopenOpen: boolean
  compare: ReviewCompareResult | null
  compareLeft: string | null
  compareRight: string | null
  load(chapterId?: string): Promise<void>
  setChapter(chapterId: string): Promise<void>
  setTab(tab: ReviewTab): void
  run(): Promise<void>
  send(text: string): Promise<void>
  authorize(): Promise<void>
  setDecision(patchId: string, accept: boolean): void
  clearDecisions(): void
  applyDecisions(): Promise<void>
  decide(patchId: string, accept: boolean): Promise<void>
  decideAll(accept: boolean): Promise<void>
  recheck(): Promise<void>
  compareRevisions(left: string, right: string): Promise<void>
  requestFinalize(): void
  openFinalize(): Promise<void>
  closeFinalize(): void
  finalize(ackBlocking: boolean, ackUnreviewed: boolean, reason?: string): Promise<void>
  /** 重新打开定稿：旧 final 保留；确认后才调用（不可撤销的是新 draft，不是旧 final）。 */
  openReopen(): void
  closeReopen(): void
  reopen(reason?: string): Promise<void>
  /** 分支：开新分支 / 切换到分支或主线。 */
  createBranch(name: string): Promise<void>
  switchBranch(branchId: string | null): Promise<void>
  focusIssue(issueId: string | null): void
  focusPatch(patchId: string | null): void
  applyEvent(event: ReviewEvent): void
  reset(): void
}

function toastError(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'error', title: message, ...(detail ? { detail } : {}), key: 'review' })
}

function toastOk(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'success', title: message, ...(detail ? { detail } : {}), key: 'review' })
}

type ActionEnvelope = { ok: true; data: ReviewActionResult } | { ok: false; error: { message: string; code: string } }

export const useReview = create<ReviewStoreState>((set, get) => {
  const apply = (next: ReviewState): void => set({ state: next, error: null })

  const runAction = async (fn: () => Promise<ActionEnvelope>): Promise<void> => {
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
    streaming: '',
    tab: 'report',
    error: null,
    activeIssueId: null,
    activePatchId: null,
    decisions: {},
    finalizeRequested: false,
    finalizeDialog: null,
    reopenOpen: false,
    compare: null,
    compareLeft: null,
    compareRight: null,

    async load(chapterId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ loading: true })
      const result = await bridge.review.state(chapterId)
      set({ loading: false })
      if (!result.ok) {
        set({ error: result.error.message })
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data)
      const state = result.data
      if (get().finalizeRequested) {
        set({ finalizeRequested: false })
        await get().openFinalize()
        return
      }
      // 进入审批台时报告已生成（UI-DESIGN §6.1）：draft_complete 且无报告 → 自动 G4。
      if (
        state.hasReport === false &&
        state.chapterStatus === 'draft_complete' &&
        !state.readOnly &&
        state.model.ready &&
        !state.running
      ) {
        await get().run()
      }
    },

    async setChapter(chapterId) {
      set({
        compare: null,
        compareLeft: null,
        compareRight: null,
        activeIssueId: null,
        activePatchId: null,
        decisions: {}
      })
      await get().load(chapterId)
    },

    setTab(tab) {
      set({ tab })
    },

    async run() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      set({ busy: true, streaming: '' })
      const result = await bridge.review.run(state.chapterId)
      set({ busy: false, streaming: '' })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(state.chapterId)
        return
      }
      apply(result.data.state)
      if (result.data.detail) toastOk(result.data.detail)
    },

    async send(text) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || text.trim().length === 0) return
      set({ busy: true, streaming: '' })
      const result = await bridge.review.send({ chapterId: state.chapterId, text: text.trim() })
      set({ busy: false, streaming: '' })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
    },

    async authorize() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      await runAction(() => bridge.review.authorizeRevision(state.chapterId))
      set({ tab: 'diff' })
    },

    async decide(patchId, accept) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      await runAction(() =>
        bridge.review.decide({
          chapterId: state.chapterId,
          expectedRevision: state.revisionId,
          decisions: [{ patchId, accept }]
        })
      )
      set({ activePatchId: null })
    },

    setDecision(patchId, accept) {
      set({ decisions: { ...get().decisions, [patchId]: accept }, activePatchId: patchId })
    },

    clearDecisions() {
      set({ decisions: {} })
    },

    async applyDecisions() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const pending = state.patches.filter((patch) => patch.status === 'proposed')
      const decisions = pending.map((patch) => {
        const value = get().decisions[patch.id]
        return { patchId: patch.id, accept: value }
      })
      if (decisions.some((decision) => typeof decision.accept !== 'boolean')) {
        toastError('先逐条选择接受或拒绝，再执行修订')
        return
      }
      await runAction(() =>
        bridge.review.decide({
          chapterId: state.chapterId,
          expectedRevision: state.revisionId,
          decisions: decisions as Array<{ patchId: string; accept: boolean }>
        })
      )
      set({ decisions: {}, activePatchId: null })
    },

    async decideAll(accept) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const pending = state.patches.filter((patch) => patch.status === 'proposed')
      if (pending.length === 0) return
      await runAction(() =>
        bridge.review.decide({
          chapterId: state.chapterId,
          expectedRevision: state.revisionId,
          decisions: pending.map((patch) => ({ patchId: patch.id, accept }))
        })
      )
      set({ decisions: {}, activePatchId: null })
    },

    async recheck() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      await runAction(() => bridge.review.recheck(state.chapterId))
      set({ tab: 'report' })
    },

    async compareRevisions(left, right) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const result = await bridge.review.compare({
        chapterId: state.chapterId,
        leftRevisionId: left,
        rightRevisionId: right
      })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      set({ compare: result.data, compareLeft: left, compareRight: right, tab: 'versions' })
    },

    requestFinalize() {
      if (get().state) {
        void get().openFinalize()
        return
      }
      set({ finalizeRequested: true })
    },

    async openFinalize() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      set({ busy: true })
      const result = await bridge.review.finalizePreview(state.chapterId)
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      set({ finalizeDialog: { preview: result.data } })
    },

    closeFinalize() {
      set({ finalizeDialog: null })
    },

    async finalize(ackBlocking, ackUnreviewed, reason) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      set({ busy: true })
      // 只有真正点「确认定稿」才签发 G6 令牌：关掉确认框不留下未消费的令牌。
      const issued = await bridge.review.issueFinalizeToken(state.chapterId)
      if (!issued.ok) {
        set({ busy: false })
        toastError(issued.error.message, issued.error.code)
        return
      }
      const result = await bridge.review.finalize({
        chapterId: state.chapterId,
        token: issued.data.token,
        ackBlocking,
        ackUnreviewed,
        ...(reason === undefined ? {} : { reason })
      })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      set({ finalizeDialog: null, tab: 'versions' })
      apply(result.data.state)
      toastOk(result.data.detail ?? '已定稿')
    },

    focusIssue(issueId) {
      set({ activeIssueId: issueId, ...(issueId ? { tab: 'report' as const } : {}) })
    },

    openReopen() {
      set({ reopenOpen: true })
    },

    closeReopen() {
      set({ reopenOpen: false })
    },

    async reopen(reason) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      await runAction(() =>
        bridge.review.reopen({
          chapterId: state.chapterId,
          ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() })
        })
      )
      set({ reopenOpen: false, tab: 'versions', compare: null })
    },

    async createBranch(name) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || name.trim().length === 0) return
      await runAction(() => bridge.review.createBranch({ chapterId: state.chapterId, name: name.trim() }))
      set({ tab: 'versions', compare: null })
    },

    async switchBranch(branchId) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      await runAction(() => bridge.review.switchBranch({ chapterId: state.chapterId, branchId }))
      set({ tab: 'versions', compare: null })
    },
    focusPatch(patchId) {
      set({ activePatchId: patchId, ...(patchId ? { tab: 'diff' as const } : {}) })
    },

    applyEvent(event) {
      const state = get().state
      if (!state || event.projectId !== state.projectId || event.chapterId !== state.chapterId) return
      if (event.phase === 'delta') {
        set({ streaming: event.full ?? '' })
        return
      }
      if (event.phase === 'done' || event.phase === 'failed') {
        set({ streaming: '' })
      }
    },

    reset() {
      set({
        state: null,
        streaming: '',
        tab: 'report',
        error: null,
        activeIssueId: null,
        activePatchId: null,
        decisions: {},
        finalizeRequested: false,
        finalizeDialog: null,
        reopenOpen: false,
        compare: null,
        compareLeft: null,
        compareRight: null
      })
    }
  }
})
