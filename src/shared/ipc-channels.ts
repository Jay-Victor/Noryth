/**
 * IPC 通道常量：纯字符串，不依赖 zod。
 * preload 在 sandbox 下不能加载第三方模块，所以通道表必须单独成文件。
 */

/** IPC 通道表：<domain>.<action>（DEV-PLAN §4.2）。 */
export const IPC = {
  appInfo: 'app.info',
  projectList: 'project.list',
  projectValidatePath: 'project.validatePath',
  projectCreate: 'project.create',
  projectOpen: 'project.open',
  projectClose: 'project.close',
  projectRemoveFromList: 'project.removeFromList',
  projectRelocate: 'project.relocate',
  projectUpdateMeta: 'project.updateMeta',
  projectReveal: 'project.reveal',
  projectCurrent: 'project.current',
  dialogPickDirectory: 'dialog.pickDirectory',
  dialogPickProject: 'dialog.pickProject',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  diagnosticsExport: 'diagnostics.export'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 事件通道：payload 必带 jobId（无 job 时为空串）与单调 seq。 */
export const IPC_EVENTS = {
  projectState: 'event:project.state'
} as const

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
