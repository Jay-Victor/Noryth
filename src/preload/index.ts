import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc-channels'
import type { IpcResult } from '../shared/schema/ipc'
import type { ProjectStateEvent } from '../shared/schema/project'
import type { PlanChoiceRequest, PlanEvent } from '../shared/schema/plan'
import type { SliceBeatEvent } from '../shared/schema/slice'
import type { WriteEvent } from '../shared/schema/write'
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
    set: (patch) => invoke(IPC.settingsSet, patch),
    probeProvider: (input) => invoke(IPC.settingsProbeProvider, input)
  },
  diagnostics: {
    export: () => invoke(IPC.diagnosticsExport, {})
  },
  slice: {
    seed: () => invoke(IPC.sliceSeed, {}),
    state: () => invoke(IPC.sliceState, {}),
    generate: (beatId) => invoke(IPC.sliceGenerate, { beatId }),
    regenerate: (beatId) => invoke(IPC.sliceRegenerate, { beatId }),
    confirm: (beatId) => invoke(IPC.sliceConfirm, { beatId }),
    edit: (input) => invoke(IPC.sliceEdit, input)
  },
  plan: {
    state: (sessionId) => invoke(IPC.planState, sessionId === undefined ? {} : { sessionId }),
    createSession: (input) => invoke(IPC.planSessionCreate, input),
    renameSession: (input) => invoke(IPC.planSessionRename, input),
    archiveSession: (sessionId) => invoke(IPC.planSessionArchive, { sessionId }),
    send: (input) => invoke(IPC.planSend, input),
    stop: (sessionId) => invoke(IPC.planStop, { sessionId }),
    retry: (messageId) => invoke(IPC.planRetry, { messageId }),
    saveOutline: (input) => invoke(IPC.planSaveOutline, input),
    addOutline: (input) => invoke(IPC.planAddOutline, input),
    removeOutline: (nodeId) => invoke(IPC.planRemoveOutline, { nodeId }),
    saveCharacter: (input) => invoke(IPC.planSaveCharacter, input),
    addCharacter: (input) => invoke(IPC.planAddCharacter, input),
    removeCharacter: (characterId) => invoke(IPC.planRemoveCharacter, { characterId }),
    saveFact: (input) => invoke(IPC.planSaveFact, input),
    addFact: (input) => invoke(IPC.planAddFact, input),
    removeFact: (factId) => invoke(IPC.planRemoveFact, { factId }),
    applyProposal: (proposalId) => invoke(IPC.planApplyProposal, { proposalId }),
    rejectProposal: (proposalId) => invoke(IPC.planRejectProposal, { proposalId }),
    choose: (input) => invoke(IPC.planChoose, input),
    g1Preview: () => invoke(IPC.planG1Preview, {}),
    confirmG1: () => invoke(IPC.planConfirmG1, {}),
    retrySetup: () => invoke(IPC.planRetrySetup, {})
  },
  write: {
    state: (chapterId) => invoke(IPC.writeState, chapterId === undefined ? {} : { chapterId }),
    saveStoryboard: (input) => invoke(IPC.writeSaveStoryboard, input),
    validateStoryboard: (input) => invoke(IPC.writeValidateStoryboard, input),
    g2Preview: (chapterId) => invoke(IPC.writeG2Preview, { chapterId }),
    confirmG2: (chapterId) => invoke(IPC.writeG2Confirm, { chapterId }),
    generate: (beatId) => invoke(IPC.writeGenerate, { beatId }),
    regenerate: (beatId) => invoke(IPC.writeRegenerate, { beatId }),
    confirm: (beatId) => invoke(IPC.writeConfirm, { beatId }),
    edit: (input) => invoke(IPC.writeEdit, input),
    resolveStale: (input) => invoke(IPC.writeStaleResolve, input),
    preflight: (chapterId) => invoke(IPC.writePreflight, { chapterId }),
    autoStart: (chapterId) => invoke(IPC.writeAutoStart, { chapterId }),
    pause: (chapterId) => invoke(IPC.writePause, { chapterId }),
    resume: (chapterId) => invoke(IPC.writeResume, { chapterId }),
    cancel: (chapterId) => invoke(IPC.writeCancel, { chapterId }),
    send: (input) => invoke(IPC.writeSend, input),
    devSeed: (input) => invoke(IPC.writeDevSeed, input ?? {})
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
    },
    onSliceBeat: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SliceBeatEvent): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC_EVENTS.sliceBeat, handler)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.sliceBeat, handler)
      }
    },
    onPlanMessage: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PlanEvent): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC_EVENTS.planMessage, handler)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.planMessage, handler)
      }
    },
    onPlanChoice: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PlanChoiceRequest): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC_EVENTS.planChoice, handler)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.planChoice, handler)
      }
    },
    onWriteEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: WriteEvent): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC_EVENTS.writeEvent, handler)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.writeEvent, handler)
      }
    }
  }
}

contextBridge.exposeInMainWorld('noryth', bridge)
