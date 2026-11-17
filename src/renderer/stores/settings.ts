import { create } from 'zustand'
import type { IpcError } from '../../shared/schema/ipc'
import type {
  AppearancePatch,
  BindingAuditEntry,
  BindingChange,
  BindingMatrix,
  ProviderTestResult,
  SettingsView
} from '../../shared/schema/settings'
import type { Preset } from '../../shared/schema/model'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'

/**
 * 设置中心状态（PHASE-10 I1–I4）。
 *
 * 只做三件事：取视图、按段保存、把失败原样交给 toast。
 * 任何「Key 明文」都不进这个 store —— 主进程只回 configured + 末 4 位。
 */

interface SettingsState {
  view: SettingsView | null
  bindings: BindingMatrix | null
  audit: BindingAuditEntry[]
  loading: boolean
  saving: boolean
  testing: Record<string, boolean>
  testResults: Record<string, ProviderTestResult | null>
  error: IpcError | null
  load(): Promise<void>
  loadProject(projectId: string): Promise<void>
  appearance(patch: AppearancePatch): Promise<void>
  /** 启动行为（PHASE-11 M1-24）：是否自动打开上次项目。 */
  setOpenLastProject(enabled: boolean): Promise<void>
  /** 审批（PHASE-16 M1-22）：异构复检 off / prefer。 */
  setReviewHetero(mode: 'off' | 'prefer'): Promise<void>
  setKey(preset: Preset, apiKey: string): Promise<boolean>
  clearKey(preset: Preset): Promise<void>
  setProviderEnabled(preset: Preset, enabled: boolean): Promise<void>
  test(preset: Preset, model?: string): Promise<void>
  saveBindings(projectId: string, changes: BindingChange[]): Promise<boolean>
  rollback(projectId: string): Promise<void>
  loadAudit(projectId: string): Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => {
  const notify = (error: IpcError): void => {
    set({ error })
    useApp.getState().toast({ tone: 'error', title: error.message, detail: error.code, key: error.code })
  }

  return {
    view: null,
    bindings: null,
    audit: [],
    loading: false,
    saving: false,
    testing: {},
    testResults: {},
    error: null,

    async load() {
      const bridge = getBridge()
      if (!bridge) return
      set({ loading: true })
      const result = await bridge.settings.view()
      if (!result.ok) {
        set({ loading: false })
        notify(result.error)
        return
      }
      set({ view: result.data, loading: false })
    },

    async loadProject(projectId) {
      const bridge = getBridge()
      if (!bridge) return
      const [bindings, audit] = await Promise.all([
        bridge.settings.bindings(projectId),
        bridge.settings.bindingAudit(projectId)
      ])
      if (!bindings.ok) {
        notify(bindings.error)
        return
      }
      set({ bindings: bindings.data, audit: audit.ok ? audit.data : [] })
    },

    async appearance(patch) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.appearance(patch)
      if (!result.ok) {
        notify(result.error)
        return
      }
      set({ view: result.data })
    },

    async setOpenLastProject(enabled) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.set({ openLastProject: enabled })
      if (!result.ok) {
        notify(result.error)
        return
      }
      await get().load()
    },

    async setReviewHetero(mode) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.set({ review: { hetero: mode } })
      if (!result.ok) {
        notify(result.error)
        return
      }
      await get().load()
    },

    async setKey(preset, apiKey) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ saving: true })
      const result = await bridge.settings.setProviderKey({ preset, apiKey })
      set({ saving: false })
      if (!result.ok) {
        notify(result.error)
        return false
      }
      await get().load()
      return true
    },

    async clearKey(preset) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.clearProviderKey({ preset })
      if (!result.ok) {
        notify(result.error)
        return
      }
      set((state) => ({ testResults: { ...state.testResults, [preset]: null } }))
      await get().load()
    },

    async setProviderEnabled(preset, enabled) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.setProviderEnabled({ preset, enabled })
      if (!result.ok) {
        notify(result.error)
        return
      }
      set({ view: result.data })
    },

    async test(preset, model) {
      const bridge = getBridge()
      if (!bridge) return
      set((state) => ({ testing: { ...state.testing, [preset]: true } }))
      const result = await bridge.settings.testProvider({ preset, ...(model === undefined ? {} : { model }) })
      set((state) => ({
        testing: { ...state.testing, [preset]: false },
        testResults: { ...state.testResults, [preset]: result.ok ? result.data : null }
      }))
      if (!result.ok) {
        notify(result.error)
        return
      }
      await get().load()
    },

    async saveBindings(projectId, changes) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ saving: true })
      const result = await bridge.settings.setBindings({ projectId, changes })
      set({ saving: false })
      if (!result.ok) {
        notify(result.error)
        return false
      }
      set({ bindings: result.data })
      await get().loadAudit(projectId)
      return true
    },

    async rollback(projectId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ saving: true })
      const result = await bridge.settings.rollbackBindings(projectId)
      set({ saving: false })
      if (!result.ok) {
        notify(result.error)
        return
      }
      set({ bindings: result.data })
      await get().loadAudit(projectId)
    },

    async loadAudit(projectId) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.settings.bindingAudit(projectId)
      if (result.ok) set({ audit: result.data })
    }
  }
})
