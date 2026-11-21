import { create } from 'zustand'
import type { IpcError, IpcResult } from '../../shared/schema/ipc'
import { AUTO_OPEN_NOTICES } from '../../shared/domain/auto-open'
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

/** 切换项目前确认：有任务在跑时不静默换库（PHASE-11 §5.1）。 */
export interface PendingSwitch {
  path: string
  title: string
  domains: Array<'write' | 'plan'>
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
  /** 费用报表对话框（PHASE-20 M2-5）：状态栏与暂停横幅共用一个入口。 */
  costOpen: boolean
  toasts: Toast[]
  newProjectOpen: boolean
  confirmRemoveId: string | null
  pendingSwitch: PendingSwitch | null
  init(): Promise<void>
  /** 启动自动打开上次项目（PHASE-11 M1-24）：1.5s 超时放弃，失败回首页。 */
  autoOpenLastProject(): Promise<void>
  refreshProjects(): Promise<void>
  setPage(page: Page): void
  openProject(path: string, readOnly?: boolean, cancelRunning?: boolean): Promise<boolean>
  /** 首页/命令面板的统一入口：先探测运行态，再决定直开还是弹确认。 */
  requestSwitch(path: string): Promise<boolean>
  confirmSwitch(): Promise<void>
  cancelSwitch(): void
  closeProject(projectId?: string): Promise<void>
  createProject(input: CreateProjectInput): Promise<boolean>
  removeProject(projectId: string): Promise<void>
  relocateProject(projectId: string, path: string): Promise<boolean>
  revealProject(projectId: string): Promise<void>
  exportDiagnostics(): Promise<void>
  /** 重新读取 AppInfo（更新状态是后台写的，设置页进入时要刷新一次）。 */
  refreshAppInfo(): Promise<void>
  /** 手动检查更新（PHASE-18 M1-7）：只刷新状态，不阻塞任何操作。 */
  checkUpdates(): Promise<void>
  applyStateEvent(event: ProjectStateEvent): void
  toast(toast: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
  setPalette(open: boolean): void
  setCostOpen(open: boolean): void
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
    costOpen: false,
    toasts: [],
    newProjectOpen: false,
    confirmRemoveId: null,
    pendingSwitch: null,

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
      const opened = current.ok ? current.data : null
      set({
        ready: true,
        appInfo: info.ok ? info.data : null,
        projects: projects.ok ? projects.data : [],
        current: opened,
        ...(devSlice ? { page: 'slice' as Page } : {})
      })
      if (!projects.ok) pushError(projects.error)
      // 首屏已经可见，自动打开在后台跑；超时/失败都停在首页（PHASE-11 §5.4）。
      if (!opened && !devSlice) void get().autoOpenLastProject()
    },

    async refreshProjects() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.project.list()
      const data = unwrap(result)
      if (data) set({ projects: data })
    },

    /**
     * 启动自动打开（PHASE-11 §5.4）。
     *
     * 首屏不 await：main 侧同步打开 30 章项目可能要几百毫秒，
     * 这里用 1.5s 截止时间兜底；真的超时就关掉并停在首页，不让 UI 半开半闭。
     */
    async autoOpenLastProject() {
      const bridge = getBridge()
      if (!bridge) return
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
      }, 1_500)
      const result = await bridge.project.autoOpen()
      clearTimeout(timer)
      if (!result.ok) {
        pushError(result.error)
        return
      }
      const { opened, reason } = result.data
      if (!opened) {
        // 状态矩阵：每个 reason 对应一条提示或静默（shared/domain/auto-open.ts）。
        const notice = AUTO_OPEN_NOTICES[reason]
        if (notice) get().toast(notice)
        return
      }
      if (timedOut) {
        // 迟到的成功：关掉，别让 UI 与 main 的状态分叉。
        await bridge.project.close(opened.project.id)
        get().toast({
          tone: 'error',
          title: '上次项目打开超时',
          detail: '已停在首页；可从列表手动打开',
          key: 'auto-open-timeout'
        })
        return
      }
      set({ current: opened, page: 'plan' })
      await get().refreshProjects()
      get().toast({ tone: 'info', title: `已自动打开「${opened.project.title}」`, key: 'auto-open' })
    },

    setPage(page) {
      set({ page })
    },

    async openProject(path, readOnly, cancelRunning) {
      const bridge = getBridge()
      if (!bridge) return false
      set({ busy: true })
      const result = await bridge.project.open({
        path,
        ...(readOnly ? { readOnly: true } : {}),
        ...(cancelRunning ? { cancelRunning: true } : {})
      })
      set({ busy: false })
      if (!result.ok) {
        pushError(result.error)
        return false
      }
      set({ current: result.data, page: 'plan', pendingSwitch: null })
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

    /**
     * 切换项目的唯一入口：先问 main「有没有任务在跑」。
     * 有任务 → 弹确认（作者点头才 cancel + 换库）；没任务 → 直接开。
     */
    async requestSwitch(path) {
      const bridge = getBridge()
      if (!bridge) return false
      const current = get().current
      if (!current) return get().openProject(path)
      if (current.project.path.toLowerCase() === path.toLowerCase()) {
        set({ page: 'plan' })
        return true
      }
      const busy = await bridge.project.busy()
      if (!busy.ok) {
        pushError(busy.error)
        return false
      }
      if (busy.data.busy) {
        const known = get().projects.find((project) => project.path.toLowerCase() === path.toLowerCase())
        const fallback = path.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? path
        set({ pendingSwitch: { path, title: known?.title ?? fallback, domains: busy.data.domains } })
        return false
      }
      return get().openProject(path)
    },

    async confirmSwitch() {
      const pending = get().pendingSwitch
      if (!pending) return
      set({ pendingSwitch: null })
      await get().openProject(pending.path, false, true)
    },

    cancelSwitch() {
      set({ pendingSwitch: null })
    },

    async closeProject(projectId) {
      const bridge = getBridge()
      const current = get().current
      if (!bridge || !current) return
      const target = projectId ?? current.project.id
      const result = await bridge.project.close(target)
      if (!result.ok) {
        pushError(result.error)
        return
      }
      if (current.project.id === target) set({ current: null, page: 'home' })
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
      // 作者在保存对话框里取消：不弹「已导出」的假成功。
      if (result.data.cancelled || !result.data.path) return
      get().toast({
        tone: 'success',
        title: '诊断包已导出',
        detail: `${result.data.path}（${result.data.entries.length} 个文件）`,
        key: 'diagnostics'
      })
    },

    async refreshAppInfo() {
      const bridge = getBridge()
      if (!bridge) return
      const info = await bridge.app.info()
      if (info.ok) set({ appInfo: info.data })
    },

    async checkUpdates() {
      const bridge = getBridge()
      if (!bridge) return
      const result = await bridge.app.checkUpdates()
      if (!result.ok) {
        pushError(result.error)
        return
      }
      const info = await bridge.app.info()
      set({ appInfo: info.ok ? info.data : get().appInfo })
      if (result.data.status === 'available' || result.data.status === 'downgrade') {
        get().toast({
          tone: 'success',
          title: '发现新版本',
          detail: `${result.data.version ?? ''}（${result.data.channel} 通道）`,
          key: 'update'
        })
      } else if (result.data.status === 'failed') {
        get().toast({
          tone: 'info',
          title: '更新检查失败（不阻塞使用）',
          detail: result.data.error ?? undefined,
          key: 'update'
        })
      }
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

    setCostOpen(open) {
      set({ costOpen: open })
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
