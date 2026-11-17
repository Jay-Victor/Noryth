import { create } from 'zustand'
import type {
  ForeshadowCreateInput,
  ForeshadowState,
  ForeshadowUpdateInput
} from '../../shared/schema/foreshadow'
import type {
  MemoryEvent,
  MemoryRecallResult,
  MemoryState,
  RelationGraph,
  RelationGraphInput,
  ToolCallListState,
  WorldFactAddInput,
  WorldProjectionState
} from '../../shared/schema/memory'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

/**
 * 记忆台状态（PHASE-09 H2/H4）。
 *
 * - 抽取是长任务：进入页面时如果本章有 queued 的抽取任务，自动跑一次。
 * - 逐条决定只写 decision；[应用 G7] 是唯一写记忆/世界状态的按钮。
 * - G7 令牌只在主进程签发；store 只持有 token，不构造 payload。
 * - 讨论只解释来源，不改库。
 */

export type MemoryTab = 'proposals' | 'entries' | 'world' | 'relations' | 'foreshadows' | 'audit'

export interface MemoryFilters {
  characterId: string | null
  kind: 'all' | 'experience' | 'fact' | 'relationship' | 'cognition'
  status: 'all' | 'active' | 'inactive' | 'superseded'
  pinnedOnly: boolean
}

interface IsolationReport {
  verified: boolean
  probes: Array<{ characterId: string; query: string; hits: number; foreign: number }>
}

interface MemoryStoreState {
  state: MemoryState | null
  loading: boolean
  busy: boolean
  streaming: string
  tab: MemoryTab
  filters: MemoryFilters
  activeProposalId: string | null
  editing: { id: string; text: string } | null
  recall: MemoryRecallResult | null
  recallQuery: string
  recallCharacterId: string | null
  isolation: IsolationReport | null
  /** 世界状态 as-of 投影（PHASE-13 M1-3）。与 state 分开：可回放到任意叙事序。 */
  projection: WorldProjectionState | null
  projectionLoading: boolean
  /** 关系图（PHASE-14 M1-5）：as-of 回放 + 确定性布局（坐标由主进程给出）。 */
  relations: RelationGraph | null
  relationsLoading: boolean
  /** 伏笔（PHASE-15 M1-10）：作者标注 + 距离；不产生任何阻断。 */
  foreshadows: ForeshadowState | null
  foreshadowsLoading: boolean
  /** 工具调用审计（PHASE-18 M1-23）：只读分页；过滤条件也放在 store 里，翻页不丢。 */
  toolCalls: ToolCallListState | null
  toolCallsLoading: boolean
  toolCallFilters: { chapterId: string; actorId: string; status: 'all' | 'ok' | 'error'; page: number }
  /** 读者视角预览：只看 reveal_seq 已揭示的事实。 */
  readerOnly: boolean
  error: string | null
  load(chapterId?: string): Promise<void>
  setChapter(chapterId: string): Promise<void>
  setTab(tab: MemoryTab): void
  setFilters(patch: Partial<MemoryFilters>): void
  extract(): Promise<void>
  decide(itemId: string, decision: 'accept' | 'edit' | 'reject', editedText?: string): Promise<void>
  decideAll(decision: 'accept' | 'reject'): Promise<void>
  beginEdit(id: string, text: string): void
  cancelEdit(): void
  saveEdit(text: string): Promise<void>
  apply(): Promise<void>
  invalidate(entryId: string, reason: string): Promise<void>
  runRecall(characterId: string, query: string): Promise<void>
  checkIsolation(): Promise<void>
  loadProjection(input?: { chapterId?: string; asOf?: number }): Promise<void>
  setReaderOnly(readerOnly: boolean): void
  /** 关系图（M1-5）：as-of 回放；坐标由主进程算好。 */
  loadRelations(input?: RelationGraphInput): Promise<void>
  /** 伏笔（M1-10）：列表 / 标注 / 回收；距离按当前章计算。 */
  loadForeshadows(chapterId?: string): Promise<void>
  /** 工具调用审计（M1-23）：只读、分页 50；patch 里省略的过滤条件保持不变。 */
  loadToolCalls(patch?: Partial<{ chapterId: string; actorId: string; status: 'all' | 'ok' | 'error'; page: number }>): Promise<void>
  createForeshadow(input: ForeshadowCreateInput): Promise<boolean>
  updateForeshadow(input: ForeshadowUpdateInput): Promise<boolean>
  closeForeshadow(foreshadowId: string, payoffChapterId: string): Promise<boolean>
  reopenForeshadow(foreshadowId: string): Promise<boolean>
  removeForeshadow(foreshadowId: string): Promise<boolean>
  /** 按章重建（M1-4）：先签发 author_confirm，再执行。 */
  rebuild(chapterId: string): Promise<void>
  /** 索引重建（M1-20）：换模型后分批重算向量。 */
  reindex(): Promise<void>
  addFact(input: WorldFactAddInput): Promise<boolean>
  closeFact(factId: string, reason?: string): Promise<boolean>
  send(text: string): Promise<void>
  focusProposal(id: string | null): void
  applyEvent(event: MemoryEvent): void
  reset(): void
}

function toastError(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'error', title: message, ...(detail ? { detail } : {}), key: 'memory' })
}

function toastOk(message: string, detail?: string): void {
  useApp.getState().toast({ tone: 'success', title: message, ...(detail ? { detail } : {}), key: 'memory' })
}

/** 同一章只自动抽取一次，避免每次进入页面都重跑。 */
const autoExtracted = new Set<string>()

export const useMemory = create<MemoryStoreState>((set, get) => {
  const apply = (next: MemoryState): void => set({ state: next, error: null })

  return {
    state: null,
    loading: false,
    busy: false,
    streaming: '',
    tab: 'proposals',
    filters: { characterId: null, kind: 'all', status: 'all', pinnedOnly: false },
    activeProposalId: null,
    editing: null,
    recall: null,
    recallQuery: '',
    recallCharacterId: null,
    isolation: null,
    projection: null,
    projectionLoading: false,
    foreshadows: null,
    foreshadowsLoading: false,
    relations: null,
    relationsLoading: false,
    toolCalls: null,
    toolCallsLoading: false,
    toolCallFilters: { chapterId: '', actorId: '', status: 'all', page: 1 },
    readerOnly: false,
    error: null,

    async load(chapterId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ loading: true })
      const result = await bridge.memory.state(chapterId)
      set({ loading: false })
      if (!result.ok) {
        set({ error: result.error.message })
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data)
      const state = result.data
      void get().loadProjection(
        state.chapterId === null ? {} : { chapterId: state.chapterId }
      )
      void get().loadRelations(state.chapterId === null ? {} : { chapterId: state.chapterId })
      if (
        state.chapterId !== null &&
        state.jobStatus === 'queued' &&
        !state.readOnly &&
        state.model.ready &&
        !state.running &&
        !autoExtracted.has(state.chapterId)
      ) {
        autoExtracted.add(state.chapterId)
        await get().extract()
      }
    },

    async setChapter(chapterId) {
      set({ activeProposalId: null, editing: null, recall: null })
      await get().load(chapterId)
    },

    async loadProjection(input = {}) {
      const bridge = getBridge()
      if (!bridge) return
      set({ projectionLoading: true })
      const result = await bridge.world.projection(input)
      set({ projectionLoading: false })
      if (!result.ok) {
        set({ projection: null })
        toastError(result.error.message, result.error.code)
        return
      }
      set({ projection: result.data })
    },

    setReaderOnly(readerOnly) {
      set({ readerOnly })
    },

    async loadRelations(input = {}) {
      const bridge = getBridge()
      if (!bridge) return
      set({ relationsLoading: true })
      const result = await bridge.world.relations(input)
      set({ relationsLoading: false })
      if (!result.ok) {
        set({ relations: null })
        toastError(result.error.message, result.error.code)
        return
      }
      set({ relations: result.data })
    },

    async loadForeshadows(chapterId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ foreshadowsLoading: true })
      const result = await bridge.world.foreshadows(chapterId === undefined ? {} : { chapterId })
      set({ foreshadowsLoading: false })
      if (!result.ok) {
        set({ foreshadows: null })
        toastError(result.error.message, result.error.code)
        return
      }
      set({ foreshadows: result.data })
    },

    async loadToolCalls(patch = {}) {
      const bridge = getBridge()
      if (!bridge) return
      const filters = { ...get().toolCallFilters, ...patch }
      set({ toolCallFilters: filters, toolCallsLoading: true })
      const result = await bridge.memory.toolCalls({
        ...(filters.chapterId === '' ? {} : { chapterId: filters.chapterId }),
        ...(filters.actorId === '' ? {} : { actorId: filters.actorId }),
        ...(filters.status === 'all' ? {} : { status: filters.status }),
        page: filters.page
      })
      set({ toolCallsLoading: false })
      if (!result.ok) {
        set({ toolCalls: null })
        toastError(result.error.message, result.error.code)
        return
      }
      set({ toolCalls: result.data })
    },

    async createForeshadow(input) {
      const bridge = getBridge()
      if (!bridge) return false
      const result = await bridge.world.createForeshadow(input)
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ foreshadows: result.data.state })
      return true
    },

    async updateForeshadow(input) {
      const bridge = getBridge()
      if (!bridge) return false
      const result = await bridge.world.updateForeshadow(input)
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ foreshadows: result.data.state })
      return true
    },

    async closeForeshadow(foreshadowId, payoffChapterId) {
      const bridge = getBridge()
      if (!bridge) return false
      const result = await bridge.world.closeForeshadow({ foreshadowId, payoffChapterId })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ foreshadows: result.data.state })
      return true
    },

    async reopenForeshadow(foreshadowId) {
      const bridge = getBridge()
      if (!bridge) return false
      const result = await bridge.world.reopenForeshadow(foreshadowId)
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ foreshadows: result.data.state })
      return true
    },

    async removeForeshadow(foreshadowId) {
      const bridge = getBridge()
      if (!bridge) return false
      const result = await bridge.world.removeForeshadow(foreshadowId)
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ foreshadows: result.data.state })
      return true
    },

    async rebuild(chapterId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ busy: true })
      // 只有真正点确认才签发 author_confirm：取消不留下未消费的令牌。
      const issued = await bridge.memory.issueRebuildToken(chapterId)
      if (!issued.ok) {
        set({ busy: false })
        toastError(issued.error.message, issued.error.code)
        return
      }
      const result = await bridge.memory.rebuild({ chapterId, token: issued.data.token })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(chapterId)
        return
      }
      apply(result.data.state)
      toastOk(result.data.detail ?? '已重建')
      await get().loadRelations({ chapterId })
      await get().loadProjection({ chapterId })
    },

    async reindex() {
      const bridge = getBridge()
      if (!bridge) return
      set({ busy: true })
      const issued = await bridge.memory.issueIndexToken()
      if (!issued.ok) {
        set({ busy: false })
        toastError(issued.error.message, issued.error.code)
        return
      }
      const result = await bridge.memory.reindex({ token: issued.data.token })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load()
        return
      }
      apply(result.data.state)
      toastOk(result.data.detail ?? '索引已重建')
      const state = get().state
      if (state !== null) {
        await get().loadRelations(state.chapterId === null ? {} : { chapterId: state.chapterId })
      }
    },

    async addFact(input) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ busy: true })
      const result = await bridge.world.addFact(input)
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ projection: result.data.projection })
      if (result.data.detail) toastOk(result.data.detail)
      return true
    },

    async closeFact(factId, reason) {
      const bridge = getBridge()
      if (!bridge) return false
      const projection = get().projection
      set({ busy: true })
      const result = await bridge.world.closeFact({
        factId,
        ...(reason === undefined ? {} : { reason }),
        ...(projection?.chapterId === null || projection?.chapterId === undefined
          ? {}
          : { chapterId: projection.chapterId }),
        ...(projection === null ? {} : { asOf: projection.asOf })
      })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return false
      }
      set({ projection: result.data.projection })
      if (result.data.detail) toastOk(result.data.detail)
      return true
    },

    setTab(tab) {
      set({ tab })
    },

    setFilters(patch) {
      set({ filters: { ...get().filters, ...patch } })
    },

    async extract() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || state.chapterId === null) return
      set({ busy: true, streaming: '' })
      const result = await bridge.memory.extract(state.chapterId)
      set({ busy: false, streaming: '' })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(state.chapterId)
        return
      }
      apply(result.data.state)
      if (result.data.detail) toastOk(result.data.detail)
    },

    async decide(itemId, decision, editedText) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.memory.decide({
        itemId,
        decision,
        ...(editedText === undefined ? {} : { editedText })
      })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
    },

    async decideAll(decision) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge) return
      const pending = state.proposals.filter((item) => item.decision === 'pending')
      if (pending.length === 0) return
      set({ busy: true })
      const result = await bridge.memory.decideMany({
        decisions: pending.map((item) => ({ itemId: item.id, decision }))
      })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
      toastOk(`${decision === 'accept' ? '已接受' : '已拒绝'} ${pending.length} 条`)
    },

    beginEdit(id, text) {
      set({ editing: { id, text } })
    },

    cancelEdit() {
      set({ editing: null })
    },

    async saveEdit(text) {
      const editing = get().editing
      if (!editing) return
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        toastError('编辑后内容为空')
        return
      }
      set({ editing: null })
      await get().decide(editing.id, 'edit', trimmed)
    },

    async apply() {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || state.chapterId === null) return
      set({ busy: true })
      // 只有真正点「应用 G7」才签发令牌：取消不留下未消费的令牌。
      const issued = await bridge.memory.issueG7Token(state.chapterId)
      if (!issued.ok) {
        set({ busy: false })
        toastError(issued.error.message, issued.error.code)
        return
      }
      const result = await bridge.memory.apply({ chapterId: state.chapterId, token: issued.data.token })
      set({ busy: false })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        await get().load(state.chapterId)
        return
      }
      apply(result.data.state)
      toastOk(result.data.detail ?? '已应用')
      // 固化会新增/关闭世界事实：投影必须跟着刷新，否则世界状态页还停在固化前。
      const projection = get().projection
      await get().loadProjection({
        ...(projection?.chapterId == null ? {} : { chapterId: projection.chapterId }),
        ...(projection === null ? {} : { asOf: projection.asOf })
      })
      await get().loadRelations({
        ...(projection?.chapterId == null ? {} : { chapterId: projection.chapterId })
      })
      set({ tab: 'entries' })
    },

    async invalidate(entryId, reason) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.memory.invalidate({ entryId, reason })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
      toastOk('已标记失效（不删除）')
    },

    async runRecall(characterId, query) {
      const bridge = getBridge()
      if (!bridge) return
      set({ recallCharacterId: characterId, recallQuery: query })
      const result = await bridge.memory.recall({ characterId, query })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      set({ recall: result.data })
    },

    async checkIsolation() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.memory.isolation()
      if (!result.ok) {
        set({ isolation: null })
        toastError(result.error.message, result.error.code)
        return
      }
      set({ isolation: result.data })
      toastOk(result.data.verified ? '隔离回归通过：跨角色 0 命中' : '隔离回归未通过')
    },

    async send(text) {
      const state = get().state
      const bridge = getBridge()
      if (!state || !bridge || text.trim().length === 0) return
      set({ busy: true, streaming: '' })
      const result = await bridge.memory.send({
        text: text.trim(),
        ...(state.chapterId === null ? {} : { chapterId: state.chapterId })
      })
      set({ busy: false, streaming: '' })
      if (!result.ok) {
        toastError(result.error.message, result.error.code)
        return
      }
      apply(result.data.state)
    },

    focusProposal(id) {
      set({ activeProposalId: id })
    },

    applyEvent(event) {
      const state = get().state
      if (!state || event.projectId !== state.projectId || event.chapterId !== state.chapterId) return
      if (event.phase === 'delta') {
        set({ streaming: event.full ?? '' })
        return
      }
      if (event.phase === 'done') set({ streaming: '' })
      if (event.phase === 'failed') {
        set({ streaming: '' })
        if (event.code) toastError('抽取失败', event.code)
      }
    },

    reset() {
      set({
        state: null,
        streaming: '',
        tab: 'proposals',
        filters: { characterId: null, kind: 'all', status: 'all', pinnedOnly: false },
        activeProposalId: null,
        editing: null,
        recall: null,
        recallQuery: '',
        recallCharacterId: null,
        isolation: null,
        projection: null,
        projectionLoading: false,
        foreshadows: null,
        foreshadowsLoading: false,
        relations: null,
        relationsLoading: false,
        toolCalls: null,
        toolCallsLoading: false,
        toolCallFilters: { chapterId: '', actorId: '', status: 'all', page: 1 },
        readerOnly: false,
        error: null,
        busy: false,
        loading: false
      })
    }
  }
})
