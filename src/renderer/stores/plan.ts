import { create } from 'zustand'
import type {
  CharacterCard,
  PlanAddOutlineInput,
  PlanCharacterAddInput,
  PlanChoiceRequest,
  PlanEvent,
  PlanG1Result,
  PlanMessageView,
  PlanProposalApplyResult,
  PlanSaveOutlineInput,
  PlanState
} from '../../shared/schema/plan'
import type { IpcError, IpcResult } from '../../shared/schema/ipc'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

export type PlanTab = 'blueprint' | 'characters' | 'world' | 'coverage'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface PlanStore {
  state: PlanState | null
  loading: boolean
  error: string | null
  tab: PlanTab
  /** 流式增量：messageId → 完整文本；终态后清空。 */
  streaming: Record<string, string>
  busySessionId: string | null
  choice: PlanChoiceRequest | null
  saveStatus: SaveStatus
  lastSavedAt: string | null
  load(sessionId?: string): Promise<void>
  selectSession(sessionId: string): Promise<void>
  createSession(): Promise<string | null>
  renameSession(sessionId: string, title: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  send(text: string): Promise<boolean>
  stop(): Promise<void>
  retry(messageId: string): Promise<void>
  applyProposal(proposalId: string): Promise<PlanProposalApplyResult | null>
  rejectProposal(proposalId: string): Promise<void>
  saveOutline(input: PlanSaveOutlineInput): Promise<void>
  addOutline(input: PlanAddOutlineInput): Promise<boolean>
  removeOutline(nodeId: string): Promise<void>
  saveCharacter(characterId: string, card: CharacterCard): Promise<string[] | null>
  addCharacter(input: PlanCharacterAddInput): Promise<boolean>
  removeCharacter(characterId: string): Promise<void>
  saveFact(input: {
    factId: string
    subject: string
    predicate: string
    object: string
    visibility: 'public' | 'secret'
  }): Promise<void>
  addFact(input: {
    subject: string
    predicate: string
    object: string
    visibility: 'public' | 'secret'
  }): Promise<boolean>
  removeFact(factId: string): Promise<void>
  confirmG1(): Promise<PlanG1Result | null>
  retrySetup(): Promise<PlanG1Result | null>
  setTab(tab: PlanTab): void
  choose(choiceId: string, optionId: string): Promise<void>
  applyEvent(event: PlanEvent): void
  applyChoice(event: PlanChoiceRequest): void
  reset(): void
}

function toastError(error: IpcError): void {
  useApp.getState().toast({ tone: 'error', title: error.message, detail: error.code, key: `plan-${error.code}` })
}

export const usePlan = create<PlanStore>((set, get) => {
  const bridge = (): ReturnType<typeof getBridge> => getBridge()

  const unwrap = <T>(result: IpcResult<T>): T | null => {
    if (result.ok) return result.data
    toastError(result.error)
    return null
  }

  const patchMessage = (messageId: string, patch: Partial<PlanMessageView>): void => {
    const state = get().state
    if (!state) return
    set({
      state: {
        ...state,
        messages: state.messages.map((message) =>
          message.id === messageId ? { ...message, ...patch } : message
        )
      }
    })
  }

  const refreshG1 = async (api: NonNullable<ReturnType<typeof getBridge>>): Promise<void> => {
    const preview = await api.plan.g1Preview()
    if (!preview.ok) return
    const state = get().state
    if (!state) return
    set({ state: { ...state, g1: preview.data } })
  }

  const clearStreaming = (messageId: string): void => {
    const next = { ...get().streaming }
    delete next[messageId]
    set({ streaming: next })
  }

  return {
    state: null,
    loading: false,
    error: null,
    tab: 'blueprint',
    streaming: {},
    busySessionId: null,
    choice: null,
    saveStatus: 'idle',
    lastSavedAt: null,

    async load(sessionId) {
      const api = bridge()
      if (!api) return
      set({ loading: true })
      const result = await api.plan.state(sessionId ?? get().state?.activeSessionId ?? undefined)
      set({ loading: false })
      if (!result.ok) {
        set({ error: result.error.message })
        toastError(result.error)
        return
      }
      const streamingActive = result.data.messages.some((message) => message.status === 'streaming')
      set({
        state: result.data,
        error: null,
        busySessionId: streamingActive ? result.data.activeSessionId : null
      })
    },

    async selectSession(sessionId) {
      await get().load(sessionId)
    },

    async createSession() {
      const api = bridge()
      if (!api) return null
      const result = await api.plan.createSession({})
      const created = unwrap(result)
      if (!created) return null
      await get().load(created.id)
      return created.id
    },

    async renameSession(sessionId, title) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.renameSession({ sessionId, title })
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async archiveSession(sessionId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.archiveSession(sessionId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async send(text) {
      const api = bridge()
      if (!api) return false
      let sessionId = get().state?.activeSessionId ?? null
      if (!sessionId) sessionId = await get().createSession()
      if (!sessionId) return false
      set({ busySessionId: sessionId })
      const result = await api.plan.send({ sessionId, text })
      if (!result.ok) {
        toastError(result.error)
        set({ busySessionId: null })
        return false
      }
      await get().load(sessionId)
      return true
    },

    async stop() {
      const api = bridge()
      const sessionId = get().busySessionId ?? get().state?.activeSessionId ?? null
      if (!api || !sessionId) return
      const result = await api.plan.stop(sessionId)
      if (!result.ok) toastError(result.error)
    },

    async retry(messageId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.retry(messageId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      set({ busySessionId: result.data.sessionId })
      await get().load(result.data.sessionId)
    },

    async applyProposal(proposalId) {
      const api = bridge()
      if (!api) return null
      const result = await api.plan.applyProposal(proposalId)
      const applied = unwrap(result)
      if (!applied) return null
      await get().load()
      useApp.getState().toast({
        tone: 'success',
        title: '已应用建议',
        detail: `草案 v${applied.blueprintVersion} · 新增 ${applied.nodesCreated} 节点 / ${applied.charactersCreated} 角色 / ${applied.factsCreated} 条初值${
          applied.affectedChapters.length > 0 ? ` · 影响 ${applied.affectedChapters.length} 章` : ''
        }`,
        key: `plan-apply-${proposalId}`
      })
      return applied
    },

    async rejectProposal(proposalId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.rejectProposal(proposalId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async saveOutline(input) {
      const api = bridge()
      if (!api) return
      set({ saveStatus: 'saving' })
      const result = await api.plan.saveOutline(input)
      if (!result.ok) {
        set({ saveStatus: 'error' })
        toastError(result.error)
        return
      }
      const state = get().state
      if (state) {
        set({
          state: {
            ...state,
            blueprint: {
              ...state.blueprint,
              nodes: state.blueprint.nodes.map((node) =>
                node.id === input.nodeId
                  ? {
                      ...node,
                      ...(input.title === undefined ? {} : { title: input.title }),
                      ...(input.content === undefined ? {} : { content: input.content }),
                      version: result.data.version
                    }
                  : node
              )
            }
          },
          saveStatus: 'saved',
          lastSavedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        })
      }
    },

    async addOutline(input) {
      const api = bridge()
      if (!api) return false
      const result = await api.plan.addOutline(input)
      if (!result.ok) {
        toastError(result.error)
        return false
      }
      await get().load()
      return true
    },

    async removeOutline(nodeId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.removeOutline(nodeId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async saveCharacter(characterId, card) {
      const api = bridge()
      if (!api) return null
      set({ saveStatus: 'saving' })
      const result = await api.plan.saveCharacter({ characterId, card })
      if (!result.ok) {
        set({ saveStatus: 'error' })
        toastError(result.error)
        return null
      }
      const state = get().state
      if (state) {
        set({
          state: {
            ...state,
            characters: state.characters.map((character) =>
              character.id === characterId
                ? { ...character, card, cardVersion: result.data.cardVersion }
                : character
            )
          },
          saveStatus: 'saved',
          lastSavedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        })
      }
      await refreshG1(api)
      return result.data.affectedChapters
    },

    async addCharacter(input) {
      const api = bridge()
      if (!api) return false
      const result = await api.plan.addCharacter(input)
      if (!result.ok) {
        toastError(result.error)
        return false
      }
      await get().load()
      return true
    },

    async removeCharacter(characterId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.removeCharacter(characterId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async saveFact(input) {
      const api = bridge()
      if (!api) return
      set({ saveStatus: 'saving' })
      const result = await api.plan.saveFact(input)
      if (!result.ok) {
        set({ saveStatus: 'error' })
        toastError(result.error)
        return
      }
      const state = get().state
      if (state) {
        set({
          state: {
            ...state,
            facts: state.facts.map((fact) => (fact.id === input.factId ? { ...fact, ...input } : fact))
          },
          saveStatus: 'saved',
          lastSavedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        })
      }
      await refreshG1(api)
    },

    async addFact(input) {
      const api = bridge()
      if (!api) return false
      const result = await api.plan.addFact(input)
      if (!result.ok) {
        toastError(result.error)
        return false
      }
      await get().load()
      return true
    },

    async removeFact(factId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.removeFact(factId)
      if (!result.ok) {
        toastError(result.error)
        return
      }
      await get().load()
    },

    async confirmG1() {
      const api = bridge()
      if (!api) return null
      const result = await api.plan.confirmG1()
      if (!result.ok) {
        toastError(result.error)
        await get().load()
        return null
      }
      await get().load()
      useApp.getState().toast({
        tone: 'success',
        title: 'G1 已完成',
        detail: `${result.data.registeredCount} 个角色 · ${result.data.namespaces.length} 个命名空间`,
        key: 'plan-g1'
      })
      return result.data
    },

    async retrySetup() {
      const api = bridge()
      if (!api) return null
      const result = await api.plan.retrySetup()
      if (!result.ok) {
        toastError(result.error)
        await get().load()
        return null
      }
      await get().load()
      useApp.getState().toast({ tone: 'success', title: '建库重试成功', key: 'plan-setup-retry' })
      return result.data
    },

    setTab(tab) {
      set({ tab })
    },

    async choose(choiceId, optionId) {
      const api = bridge()
      if (!api) return
      const result = await api.plan.choose({ choiceId, optionId })
      if (!result.ok) {
        toastError(result.error)
        set({ choice: null })
        return
      }
      set({ choice: null })
    },

    applyChoice(event) {
      const state = get().state
      if (!state || state.projectId !== event.projectId) return
      set({ choice: event })
    },

    applyEvent(event) {
      const state = get().state
      if (!state || state.projectId !== event.projectId) return
      if (event.phase === 'start') {
        set({ busySessionId: event.sessionId })
        return
      }
      if (event.phase === 'delta') {
        if (event.full === undefined) return
        set({ streaming: { ...get().streaming, [event.messageId]: event.full } })
        return
      }
      if (event.phase === 'done') {
        patchMessage(event.messageId, {
          body: event.full ?? '',
          status: 'done',
          meta: {
            ...(state.messages.find((message) => message.id === event.messageId)?.meta ?? {}),
            ...(event.label === undefined ? {} : { label: event.label }),
            ...(event.proposalIds === undefined ? {} : { proposal_ids: event.proposalIds })
          }
        })
        clearStreaming(event.messageId)
        set({ busySessionId: null, choice: null })
        void get().load(event.sessionId)
        return
      }
      if (event.phase === 'stopped') {
        patchMessage(event.messageId, {
          body: event.full ?? '',
          status: 'stopped',
          meta: { ...(state.messages.find((message) => message.id === event.messageId)?.meta ?? {}), interrupted: true }
        })
        clearStreaming(event.messageId)
        set({ busySessionId: null, choice: null })
        void get().load(event.sessionId)
        return
      }
      if (event.phase === 'failed') {
        patchMessage(event.messageId, {
          body: event.full ?? '',
          status: 'failed',
          meta: {
            ...(state.messages.find((message) => message.id === event.messageId)?.meta ?? {}),
            ...(event.code === undefined ? {} : { error_code: event.code }),
            ...(event.message === undefined ? {} : { error_message: event.message })
          }
        })
        clearStreaming(event.messageId)
        set({ busySessionId: null, choice: null })
        void get().load(event.sessionId)
      }
    },

    reset() {
      set({
        state: null,
        loading: false,
        error: null,
        tab: 'blueprint',
        streaming: {},
        busySessionId: null,
        choice: null,
        saveStatus: 'idle',
        lastSavedAt: null
      })
    }
  }
})
