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
  settingsProbeProvider: 'settings.probeProvider',
  diagnosticsExport: 'diagnostics.export',
  // 开发切片（PHASE-05）：只在未打包构建注册
  sliceSeed: 'slice.seed',
  sliceState: 'slice.state',
  sliceGenerate: 'slice.generate',
  sliceRegenerate: 'slice.regenerate',
  sliceConfirm: 'slice.confirm',
  sliceEdit: 'slice.edit',
  // 规划台（PHASE-06）
  planState: 'plan.state',
  planSessionCreate: 'plan.session.create',
  planSessionRename: 'plan.session.rename',
  planSessionArchive: 'plan.session.archive',
  planSend: 'plan.send',
  planStop: 'plan.stop',
  planRetry: 'plan.retry',
  planSaveOutline: 'plan.outline.save',
  planAddOutline: 'plan.outline.add',
  planRemoveOutline: 'plan.outline.remove',
  planSaveCharacter: 'plan.character.save',
  planAddCharacter: 'plan.character.add',
  planRemoveCharacter: 'plan.character.remove',
  planSaveFact: 'plan.fact.save',
  planAddFact: 'plan.fact.add',
  planRemoveFact: 'plan.fact.remove',
  planApplyProposal: 'plan.proposal.apply',
  planRejectProposal: 'plan.proposal.reject',
  planChoose: 'plan.choose',
  planG1Preview: 'plan.g1.preview',
  planConfirmG1: 'plan.g1.confirm',
  planRetrySetup: 'plan.g1.retry',
  // 创作台（PHASE-07）
  writeState: 'write.state',
  writeSaveStoryboard: 'write.storyboard.save',
  writeValidateStoryboard: 'write.storyboard.validate',
  writeG2Preview: 'write.g2.preview',
  writeG2Confirm: 'write.g2.confirm',
  writeGenerate: 'write.beat.generate',
  writeRegenerate: 'write.beat.regenerate',
  writeConfirm: 'write.beat.confirm',
  writeEdit: 'write.beat.edit',
  writeStaleResolve: 'write.beat.stale',
  writePreflight: 'write.auto.preflight',
  writeAutoStart: 'write.auto.start',
  writePause: 'write.pause',
  writeResume: 'write.resume',
  writeCancel: 'write.cancel',
  writeSend: 'write.send',
  // 未打包构建的 E2E 脚手架（生产包不注册）
  writeDevSeed: 'write.devSeed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 事件通道：payload 必带 jobId（无 job 时为空串）与单调 seq。 */
export const IPC_EVENTS = {
  projectState: 'event:project.state',
  sliceBeat: 'event:slice.beat',
  planMessage: 'event:plan.message',
  planChoice: 'event:plan.choice',
  writeEvent: 'event:write'
} as const

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
