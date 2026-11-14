import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc-channels'
import type { IpcResult } from '../shared/schema/ipc'
import type { ProjectStateEvent } from '../shared/schema/project'
import type { NorythBridge } from '../shared/schema/bridge'

let requestSeq = 0

async function invoke<T>(channel: string, payload: unknown): Promise<IpcResult<T>> {
  requestSeq += 1
  const requestId = `rq_${Date.now().toString(36)}_${requestSeq}`
  try {
    return (await ipcRenderer.invoke(channel, { requestId, payload })) as IpcResult<T>
  } catch (error) {
    // preload 不向上抛原始异常：统一形状，renderer 只处理 IpcResult
    return {
      ok: false,
      error: {
        code: 'invalid_args',
        message: '主进程未处理该请求',
        details: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

const bridge: NorythBridge = {
  project: {
    list: () => invoke(IPC.projectList, {}),
    current: () => invoke(IPC.projectCurrent, {}),
    validatePath: (input) => invoke(IPC.projectValidatePath, input),
    create: (input) => invoke(IPC.projectCreate, input),
    open: (input) => invoke(IPC.projectOpen, input),
    close: (projectId) => invoke(IPC.projectClose, { projectId }),
    removeFromList: (projectId) => invoke(IPC.projectRemoveFromList, { projectId }),
    relocate: (input) => invoke(IPC.projectRelocate, input),
    updateMeta: (input) => invoke(IPC.projectUpdateMeta, input),
    reveal: (projectId) => invoke(IPC.projectReveal, { projectId })
  },
  dialog: {
    pickDirectory: () => invoke(IPC.dialogPickDirectory, {}),
    pickProject: () => invoke(IPC.dialogPickProject, {})
  },
  settings: {
    get: () => invoke(IPC.settingsGet, {}),
    set: (patch) => invoke(IPC.settingsSet, patch)
  },
  diagnostics: {
    export: () => invoke(IPC.diagnosticsExport, {})
  },
  app: {
    info: () => invoke(IPC.appInfo, {})
  },
  events: {
    onProjectState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ProjectStateEvent): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC_EVENTS.projectState, handler)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.projectState, handler)
      }
    }
  }
}

contextBridge.exposeInMainWorld('noryth', bridge)
