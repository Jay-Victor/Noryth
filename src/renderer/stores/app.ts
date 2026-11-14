import { create } from 'zustand'
import type { IpcError, IpcResult } from '../../shared/schema/ipc'
import type {
  AppInfo,
  CreateProjectInput,
  OpenProjectResult,
  ProjectStateEvent,
  ProjectSummary
} from '../../shared/schema/project'
import { getBridge } from '../lib/bridge'

export type Page = 'home' | 'plan' | 'write' | 'review' | 'memory' | 'settings' | 'slice'
/** 主导航只覆盖正式页面；dev 切片不进入导航。 */
export type NavPage = Exclude<Page, 'slice'>

function devSliceRequested(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#/dev/slice'
}

export interface Toast {
  id: string
  tone: 'info' | 'success' | 'error'
  title: string
  detail?: string
  key?: string
}

interface AppState {
  ready: boolean
  bridgeMissing: boolean
  page: Page
  projects: ProjectSummary[]
  current: OpenProjectResult | null
  appInfo: AppInfo | null
  busy: boolean
  paletteOpen: boolean
  toasts: Toast[]
  newProjectOpen: boolean
  confirmRemoveId: string | null
  init(): Promise<void>
  refreshProjects(): Promise<void>
  setPage(page: Page): void
  openProject(path: string, readOnly?: boolean): Promise<boolean>
  closeProject(): Promise<void>
  createProject(input: CreateProjectInput): Promise<boolean>
  removeProject(projectId: string): Promise<void>
  relocateProject(projectId: string, path: string): Promise<boolean>
  revealProject(projectId: string): Promise<void>
  exportDiagnostics(): Promise<void>
  applyStateEvent(event: ProjectStateEvent): void
  toast(toast: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
  setPalette(open: boolean): void
  setNewProjectOpen(open: boolean): void
  setConfirmRemove(projectId: string | null): void
}

let toastSeq = 0
const toastId = (): string => {
  toastSeq += 1
  return `toast_${Date.now().toString(36)}_${toastSeq}`
}

export const useApp = create<AppState>((set, get) => {
  const pushError = (error: IpcError): void => {
    get().toast({ tone: 'error', title: error.message, detail: error.code, key: error.code })
  }

  const unwrap = <T>(result: IpcResult<T>): T | null => {
    if (result.ok) return result.data
    pushError(result.error)
    return null
  }

  return {
    ready: false,
    bridgeMissing: false,
    page: 'home',
    projects: [],
    current: null,
    appInfo: null,
    busy: false,
    paletteOpen: false,
    toasts: [],
    newProjectOpen: false,
    confirmRemoveId: null,

    async init() {
      const bridge = getBridge()
      if (!bridge) {
        set({ ready: true, bridgeMissing: true })
        return
      }
      const [info, projects, current] = await Promise.all([
        bridge.app.info(),
        bridge.project.list(),
        bridge.project.current()
      ])
      const devSlice = info.ok && !info.data.packaged && devSliceRequested()
      set({
        ready: true,
        appInfo: info.ok ? info.data : null,
        projects: projects.ok ? projects.data : [],
        current: current.ok ? current.data : null,
        ...(devSlice ? { page: 'slice' as Page } : {})
      })
      if (!projects.ok) pushError(projects.error)
    },

    async refreshProjects() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.project.list()
      const data = unwrap(result)
      if (data) set({ projects: data })
    },

    setPage(page) {
      set({ page })
    },

    async openProject(path, readOnly) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ busy: true })
      const result = await bridge.project.open({ path, ...(readOnly ? { readOnly: true } : {}) })
      set({ busy: false })
      if (!result.ok) {
        pushError(result.error)
        return false
      }
      set({ current: result.data, page: 'plan' })
      await get().refreshProjects()
      const title = result.data.project.title
      get().toast({
        tone: 'success',
        title: result.data.readOnly ? `已只读打开「${title}」` : `已打开「${title}」`,
        ...(result.data.readOnly ? { detail: '项目已在另一窗口打开' } : {}),
        key: 'project-open'
      })
      return true
    },

    async closeProject() {
      const bridge = getBridge()
      const current = get().current
      if (!bridge || !current) return
      await bridge.project.close(current.project.id)
      set({ current: null, page: 'home' })
      await get().refreshProjects()
    },

    async createProject(input) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ busy: true })
      const result = await bridge.project.create(input)
      set({ busy: false })
      if (!result.ok) {
        pushError(result.error)
        return false
      }
      await get().refreshProjects()
      const opened = await get().openProject(result.data.path)
      if (opened) {
        get().toast({ tone: 'success', title: `项目「${result.data.title}」已创建`, detail: result.data.path, key: 'project-created' })
      }
      return true
    },

    async removeProject(projectId) {
      const bridge = getBridge()
      if (!bridge) return
      set({ busy: true })
      const result = await bridge.project.removeFromList(projectId)
      set({ busy: false })
      if (!result.ok) {
        pushError(result.error)
        return
      }
      if (get().current?.project.id === projectId) set({ current: null, page: 'home' })
      await get().refreshProjects()
      get().toast({ tone: 'info', title: '已从列表移除', detail: '文件没有动', key: 'project-removed' })
    },

    async relocateProject(projectId, path) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ busy: true })
      const result = await bridge.project.relocate({ projectId, path })
      set({ busy: false })
      if (!result.ok) {
        pushError(result.error)
        return false
      }
      await get().refreshProjects()
      get().toast({ tone: 'success', title: '路径已更新', detail: result.data.path, key: 'project-relocated' })
      return true
    },

    async revealProject(projectId) {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.project.reveal(projectId)
      if (!result.ok) pushError(result.error)
    },

    async exportDiagnostics() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.diagnostics.export()
      if (!result.ok) {
        pushError(result.error)
        return
      }
      get().toast({ tone: 'success', title: '诊断包已导出', detail: result.data.path, key: 'diagnostics' })
    },

    applyStateEvent(event) {
      const current = get().current
      if (!current || current.project.id !== event.projectId) return
      set({
        current: {
          ...current,
          readOnly: event.readOnly,
          project: { ...current.project, setupState: event.setupState, schemaVersion: event.schemaVersion }
        }
      })
    },

    toast(toast) {
      const today = get().toasts
      if (toast.key && today.some((item) => item.key === toast.key)) return
      const next = [...today, { ...toast, id: toastId() }].slice(-3)
      set({ toasts: next })
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
    },

    setPalette(open) {
      set({ paletteOpen: open })
    },

    setNewProjectOpen(open) {
      set({ newProjectOpen: open })
    },

    setConfirmRemove(projectId) {
      set({ confirmRemoveId: projectId })
    }
  }
})

/** 未过 G1 时创作 / 审批 / 记忆置灰（UI-DESIGN §2.1）。 */
export function navGuard(page: NavPage, current: OpenProjectResult | null): { disabled: boolean; reason?: string } {
  if (page === 'home' || page === 'settings') return { disabled: false }
  if (!current) return { disabled: true, reason: '先打开一个项目' }
  if (page === 'plan') return { disabled: false }
  if (current.project.setupState !== 'complete') {
    return { disabled: true, reason: '先完成 G1 蓝图确认' }
  }
  return { disabled: false }
}
