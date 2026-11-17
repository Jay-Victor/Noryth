import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError, isAppError } from '../../shared/domain/app-error'
import { messageFor } from '../../shared/domain/errors'
import { fail, IPC, ok, type IpcResult } from '../../shared/schema/ipc'
import {
  CreateProjectInputSchema,
  OpenProjectInputSchema,
  ProjectIdInputSchema,
  RelocateProjectInputSchema,
  SettingsPatchSchema,
  UpdateProjectMetaInputSchema,
  ValidatePathInputSchema,
  type AppInfo,
  type ProjectBusyState
} from '../../shared/schema/project'
import {
  AppearancePatchSchema,
  BindingProjectInputSchema,
  BindingSetInputSchema,
  ProviderClearInputSchema,
  ProviderKeySetInputSchema,
  ProviderTestInputSchema
} from '../../shared/schema/settings'
import { PresetSchema } from "../../shared/schema/model"
import { DiagnosticsExportInputSchema, ExportInputSchema } from '../../shared/schema/export'
import { exportManuscript } from '../doc/export'
import { isBusyError } from '../db/busy'
import {
  PlanAddOutlineInputSchema,
  PlanCharacterAddInputSchema,
  PlanCharacterIdInputSchema,
  PlanCharacterSaveInputSchema,
  PlanChooseInputSchema,
  PlanEmptyInputSchema,
  PlanFactAddInputSchema,
  PlanFactIdInputSchema,
  PlanFactSaveInputSchema,
  PlanMessageIdInputSchema,
  PlanProposalIdInputSchema,
  PlanRemoveOutlineInputSchema,
  PlanSaveOutlineInputSchema,
  PlanSendInputSchema,
  PlanSessionCreateInputSchema,
  PlanSessionIdInputSchema,
  PlanSessionRenameInputSchema,
  PlanStateInputSchema
} from '../../shared/schema/plan'
import {
  PlanChangeApplyInputSchema,
  PlanChangeIdInputSchema,
  PlanCoverageGateInputSchema,
  PlanCoverageInputSchema,
  PlanDismissValidationInputSchema,
  PlanImpactAnalyzeInputSchema
} from '../../shared/schema/blueprint'
import {
  ForeshadowCloseInputSchema,
  ForeshadowCreateInputSchema,
  ForeshadowIdInputSchema,
  ForeshadowListInputSchema,
  ForeshadowUpdateInputSchema
} from '../../shared/schema/foreshadow'
import {
  SliceBeatInputSchema,
  SliceEditInputSchema,
  SliceEmptyInputSchema
} from '../../shared/schema/slice'
import {
  WriteBeatInputSchema,
  WriteChapterInputSchema,
  WriteContextInputSchema,
  WriteConfirmInputSchema,
  WriteEditInputSchema,
  WriteG2InputSchema,
  WriteSendInputSchema,
  WriteSceneLinkInputSchema,
  WriteSceneReorderInputSchema,
  WriteSceneTimeInputSchema,
  WriteTimelineInputSchema,
  WriteStaleChoiceInputSchema,
  WriteDevSeedInputSchema,
  WriteStoryboardSaveInputSchema,
  WriteStoryboardValidateInputSchema
} from '../../shared/schema/write'
import {
  ReviewChapterInputSchema,
  ReviewCompareInputSchema,
  ReviewDecideInputSchema,
  ReviewDevSeedInputSchema,
  ReviewFinalizeInputSchema,
  ReviewBranchCreateInputSchema,
  ReviewBranchSwitchInputSchema,
  ReviewReopenInputSchema,
  ReviewSendInputSchema
} from '../../shared/schema/review'
import {
  IndexRebuildInputSchema,
  MemoryApplyInputSchema,
  MemoryChapterInputSchema,
  MemoryRebuildInputSchema,
  RelationGraphInputSchema,
  WorldFactAddSchema,
  WorldFactCloseSchema,
  WorldProjectionInputSchema,
  MemoryDecideInputSchema,
  MemoryDecideManyInputSchema,
  MemoryDevSeedInputSchema,
  MemoryInvalidateInputSchema,
  MemoryRecallInputSchema,
  MemorySendInputSchema,
  MemoryStateInputSchema
} from '../../shared/schema/memory'
import type { Logger } from '../observability/logger'
import { defaultDiagnosticsName, exportDiagnosticsZip, type DiagnosticsJobSummary } from '../observability/diagnostics'
import type { MemoryService } from '../memory/service'
import type { PlanService } from '../plan/service'
import type { ProjectService } from '../project/service'
import type { ReviewService } from '../review/service'
import type { SettingsStore } from '../settings/store'
import type { SettingsService } from '../settings/service'
import type { SliceService } from '../slice/service'
import type { WriteService } from '../scheduler/service'
import type { WorldService } from '../world/service'

const EnvelopeSchema = z.strictObject({ requestId: z.string().min(1), payload: z.unknown() })
const EmptySchema = z.strictObject({})

export interface IpcDeps {
  project: ProjectService
  settings: SettingsStore
  /** 设置中心（Key/绑定/外观）；与低层 settings store 分工：它管契约，store 管文件。 */
  settingsCenter: SettingsService
  logger: Logger
  logPath: string
  userDataDir: string
  appInfo: () => AppInfo
  plan: PlanService
  /** 仅未打包构建注入；生产包不注册切片通道。 */
  slice?: SliceService
  /** 仅未打包构建：注册 E2E 脚手架通道。 */
  devTools?: boolean
  write: WriteService
  review: ReviewService
  memory: MemoryService
  /** 世界状态（PHASE-13）：as-of 投影与作者事实。 */
  world: WorldService
}

interface HandlerDefinition<S extends z.ZodTypeAny, R> {
  schema: S
  /** 写通道：项目只读时在 main 侧直接拒绝，不靠 UI 禁用（PHASE-01 §5.2）。 */
  mutation?: boolean
  handler: (payload: z.infer<S>, event: Electron.IpcMainInvokeEvent) => R | Promise<R>
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 任务类型 → 域：write 可取消；审批/记忆/patch 只能等它跑完。 */
function jobDomain(type: string): 'write' | 'review' | 'memory' {
  if (type.startsWith('beat')) return 'write'
  if (type.startsWith('memory')) return 'memory'
  return 'review'
}

export function registerIpc(deps: IpcDeps): void {
  const register = <S extends z.ZodTypeAny, R>(channel: string, definition: HandlerDefinition<S, R>): void => {
    ipcMain.handle(channel, async (event, raw): Promise<IpcResult<R>> => {
      const envelope = EnvelopeSchema.safeParse(raw)
      if (!envelope.success) {
        return fail({ code: 'invalid_args', message: messageFor('invalid_args') })
      }
      if (definition.mutation && deps.project.isReadOnly()) {
        deps.logger.warn({ channel, requestId: envelope.data.requestId }, 'write rejected: project locked')
        return fail({ code: 'project_locked', message: messageFor('project_locked') })
      }
      const parsed = definition.schema.safeParse(envelope.data.payload)
      if (!parsed.success) {
        return fail({
          code: 'invalid_args',
          message: messageFor('invalid_args'),
          details: parsed.error.issues.map((issue) => issue.path.join('.'))
        })
      }
      try {
        return ok(await definition.handler(parsed.data, event))
      } catch (error) {
        if (isBusyError(error)) {
          deps.logger.warn({ channel }, 'write rejected: database busy')
          return fail({ code: 'project_locked', message: messageFor('project_locked') })
        }
        if (isAppError(error)) {
          deps.logger.warn({ channel, code: error.code, details: error.details }, 'ipc handler rejected')
          return fail(error.toIpcError())
        }
        deps.logger.error(
          { channel, error: error instanceof Error ? error.message : String(error) },
          'ipc handler failed'
        )
        return fail({ code: 'internal_error', message: messageFor('internal_error') })
      }
    })
  }

  // ── 项目切换守卫（PHASE-11 §5.1）────────────────────────────────────────

  const runningJobs = (): Array<{ type: string }> => {
    const host = deps.project.currentHandle()
    if (!host) return []
    try {
      const project = host.repos.project.get()
      return project ? host.repos.job.listByStatus(project.id, 'running') : []
    } catch {
      return []
    }
  }

  const busyState = (): ProjectBusyState => {
    const jobs = runningJobs()
    const domains: Array<'write' | 'plan'> = []
    if (deps.write.isBusy() || jobs.some((job) => jobDomain(job.type) === 'write')) domains.push('write')
    if (deps.plan.isBusy()) domains.push('plan')
    return {
      projectId: deps.project.currentResult()?.project.id ?? null,
      domains,
      busy: domains.length > 0 || jobs.length > 0
    }
  }

  /** 审批/记忆任务不可中断：切换与关闭一律拒绝，等它跑完，避免半条事务。 */
  const assertNoBlockingJobs = (): void => {
    const blocking = runningJobs().filter((job) => jobDomain(job.type) !== 'write')
    if (blocking.length === 0) return
    throw new AppError('project_busy', '审批或记忆任务在跑，等它结束再切换项目', {
      jobs: blocking.map((job) => job.type)
    })
  }

  /** 切换/关闭前收尾：取消在跑的生成与规划，并等它们真正退出再关库。 */
  const settleRunningWork = async (): Promise<void> => {
    assertNoBlockingJobs()
    const [writeIdle, planIdle] = await Promise.all([deps.write.abortAllAndWait(), deps.plan.abortAllAndWait()])
    if (!writeIdle || !planIdle) {
      deps.logger.warn({ event: 'project_switch_timeout', writeIdle, planIdle }, 'running work did not stop in time')
      throw new AppError('project_busy', '任务没有在 2 秒内停下，请稍后再切换')
    }
    deps.logger.info({ event: 'project_switch_cancelled' }, 'running work cancelled before switching project')
  }

  register(IPC.appInfo, { schema: EmptySchema, handler: () => deps.appInfo() })

  register(IPC.projectList, { schema: EmptySchema, handler: () => deps.project.list() })

  register(IPC.projectCurrent, { schema: EmptySchema, handler: () => deps.project.currentResult() })

  register(IPC.projectBusy, { schema: EmptySchema, handler: () => busyState() })

  register(IPC.projectAutoOpen, { schema: EmptySchema, handler: () => deps.project.autoOpen() })

  register(IPC.projectTree, { schema: EmptySchema, handler: () => deps.project.tree() })

  register(IPC.projectValidatePath, {
    schema: ValidatePathInputSchema,
    handler: (payload) => deps.project.validatePath(payload)
  })

  register(IPC.projectCreate, {
    schema: CreateProjectInputSchema,
    handler: async (payload) => {
      if (busyState().busy) await settleRunningWork()
      const result = deps.project.create(payload)
      deps.settings.write({ lastOpenedProjectId: result.projectId })
      return result
    }
  })

  register(IPC.projectOpen, {
    schema: OpenProjectInputSchema,
    handler: async (payload) => {
      const busy = busyState()
      if (busy.busy) {
        // 没有作者确认就换库 = 静默丢当前生成，main 侧直接拒绝。
        if (payload.cancelRunning !== true) {
          throw new AppError('project_busy', messageFor('project_busy'), { domains: busy.domains })
        }
        await settleRunningWork()
      }
      const result = deps.project.open(payload)
      deps.settings.write({ lastOpenedProjectId: result.project.id })
      return result
    }
  })

  register(IPC.projectClose, {
    schema: ProjectIdInputSchema,
    handler: async (payload) => {
      if (busyState().busy) await settleRunningWork()
      const closed = deps.project.close(payload.projectId)
      // 作者显式关闭后不再自动打开（PHASE-11 M1-24）。
      if (closed) deps.settings.write({ lastOpenedProjectId: null })
      return { closed }
    }
  })

  register(IPC.projectRemoveFromList, {
    schema: ProjectIdInputSchema,
    handler: async (payload) => {
      if (busyState().busy) await settleRunningWork()
      const wasCurrent = deps.project.currentResult()?.project.id === payload.projectId
      const removed = deps.project.removeFromList(payload.projectId)
      if (removed && wasCurrent) deps.settings.write({ lastOpenedProjectId: null })
      return { removed }
    }
  })

  register(IPC.projectRelocate, {
    schema: RelocateProjectInputSchema,
    handler: async (payload) => {
      if (busyState().busy) await settleRunningWork()
      return deps.project.relocate(payload)
    }
  })

  register(IPC.projectUpdateMeta, {
    schema: UpdateProjectMetaInputSchema,
    mutation: true,
    handler: (payload) => deps.project.updateMeta(payload)
  })

  register(IPC.projectReveal, {
    schema: ProjectIdInputSchema,
    handler: (payload) => {
      const summary = deps.project.list().find((project) => project.id === payload.projectId)
      if (!summary) throw new AppError('project_not_found', 'project not in registry')
      shell.showItemInFolder(join(summary.path, 'noryth.db'))
      return { revealed: true }
    }
  })

  register(IPC.dialogPickDirectory, {
    schema: EmptySchema,
    handler: async (_payload, event) => {
      const win = windowOf(event)
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    }
  })

  register(IPC.dialogPickProject, {
    schema: EmptySchema,
    handler: async (_payload, event) => {
      const win = windowOf(event)
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: '选择项目文件夹（含 noryth.db）'
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    }
  })

  register(IPC.settingsGet, { schema: EmptySchema, handler: () => deps.settings.read() })

  register(IPC.settingsSet, {
    schema: SettingsPatchSchema,
    handler: (payload) => deps.settings.write(payload)
  })

  register(IPC.settingsProbeProvider, {
    schema: ProviderTestInputSchema,
    handler: (payload) => deps.settingsCenter.test(payload)
  })

  register(IPC.settingsView, {
    schema: EmptySchema,
    handler: () => deps.settingsCenter.view()
  })

  register(IPC.settingsAppearance, {
    schema: AppearancePatchSchema,
    handler: (payload) => deps.settingsCenter.appearance(payload)
  })

  register(IPC.settingsProviderKey, {
    schema: ProviderKeySetInputSchema,
    handler: (payload) => deps.settingsCenter.setKey(payload)
  })

  register(IPC.settingsProviderKeyClear, {
    schema: ProviderClearInputSchema,
    handler: (payload) => deps.settingsCenter.clearKey(payload)
  })

  register(IPC.settingsProviderEnabled, {
    schema: z.strictObject({ preset: PresetSchema, enabled: z.boolean() }),
    handler: (payload) => deps.settingsCenter.setProviderEnabled(payload.preset, payload.enabled)
  })

  register(IPC.settingsBindings, {
    schema: BindingProjectInputSchema,
    handler: (payload) => deps.settingsCenter.bindings(payload.projectId)
  })

  register(IPC.settingsBindingsSet, {
    schema: BindingSetInputSchema,
    mutation: true,
    handler: (payload) => deps.settingsCenter.setBindings(payload)
  })

  register(IPC.settingsBindingsRollback, {
    schema: BindingProjectInputSchema,
    mutation: true,
    handler: (payload) => deps.settingsCenter.rollback(payload.projectId)
  })

  register(IPC.settingsBindingsAudit, {
    schema: BindingProjectInputSchema,
    handler: (payload) => deps.settingsCenter.audit(payload.projectId)
  })

  register(IPC.exportRun, {
    schema: ExportInputSchema,
    handler: (payload) => {
      const host = deps.project.currentHandle()
      if (!host) throw new AppError('project_not_found', '没有打开的项目')
      return exportManuscript(host.repos, host.dir, payload)
    }
  })

  register(IPC.diagnosticsExport, {
    schema: DiagnosticsExportInputSchema,
    handler: async (payload, event) => {
      const host = deps.project.currentHandle()
      const project = host ? host.repos.project.get() : null
      const jobs: DiagnosticsJobSummary[] = project
        ? host!.repos.job.listRecent(project.id, 20).map((job) => ({
            id: job.id,
            type: job.type,
            status: job.status,
            errorCode: job.errorCode,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
          }))
        : []

      let target = payload.path ?? null
      if (!target) {
        const win = windowOf(event)
        const options = {
          title: '导出诊断包',
          defaultPath: join(app.getPath('downloads'), defaultDiagnosticsName()),
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        }
        const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (picked.canceled || !picked.filePath) {
          return { path: null, bytes: 0, entries: [], cancelled: true }
        }
        target = picked.filePath
      }

      const exported = exportDiagnosticsZip(
        {
          userDataDir: deps.userDataDir,
          appInfo: deps.appInfo(),
          settings: deps.settings.read(),
          projects: deps.project.list(),
          logPath: deps.logPath
        },
        target,
        {
          projectTitle: project?.title ?? null,
          schemaVersion: deps.appInfo().schemaVersion,
          jobs,
          verify: deps.project.verifySnapshot()
        }
      )
      deps.logger.info({ event: 'diagnostics_exported', bytes: exported.bytes, entries: exported.entries.length }, 'diagnostics exported')
      return { ...exported, cancelled: false }
    }
  })

  const plan = deps.plan
  register(IPC.planState, { schema: PlanStateInputSchema, handler: (payload) => plan.getState(payload) })
  register(IPC.planSessionCreate, {
    schema: PlanSessionCreateInputSchema,
    mutation: true,
    handler: (payload) => plan.createSession(payload)
  })
  register(IPC.planSessionRename, {
    schema: PlanSessionRenameInputSchema,
    mutation: true,
    handler: (payload) => plan.renameSession(payload)
  })
  register(IPC.planSessionArchive, {
    schema: PlanSessionIdInputSchema,
    mutation: true,
    handler: (payload) => plan.archiveSession(payload)
  })
  register(IPC.planSend, {
    schema: PlanSendInputSchema,
    mutation: true,
    handler: (payload) => plan.send(payload)
  })
  register(IPC.planStop, {
    schema: PlanSessionIdInputSchema,
    mutation: true,
    handler: (payload) => plan.stop(payload)
  })
  register(IPC.planRetry, {
    schema: PlanMessageIdInputSchema,
    mutation: true,
    handler: (payload) => plan.retry(payload)
  })
  register(IPC.planSaveOutline, {
    schema: PlanSaveOutlineInputSchema,
    mutation: true,
    handler: (payload) => plan.saveOutline(payload)
  })
  register(IPC.planAddOutline, {
    schema: PlanAddOutlineInputSchema,
    mutation: true,
    handler: (payload) => plan.addOutline(payload)
  })
  register(IPC.planRemoveOutline, {
    schema: PlanRemoveOutlineInputSchema,
    mutation: true,
    handler: (payload) => plan.removeOutline(payload)
  })
  register(IPC.planSaveCharacter, {
    schema: PlanCharacterSaveInputSchema,
    mutation: true,
    handler: (payload) => plan.saveCharacter(payload)
  })
  register(IPC.planAddCharacter, {
    schema: PlanCharacterAddInputSchema,
    mutation: true,
    handler: (payload) => plan.addCharacter(payload)
  })
  register(IPC.planRemoveCharacter, {
    schema: PlanCharacterIdInputSchema,
    mutation: true,
    handler: (payload) => plan.removeCharacter(payload)
  })
  register(IPC.planSaveFact, {
    schema: PlanFactSaveInputSchema,
    mutation: true,
    handler: (payload) => plan.saveFact(payload)
  })
  register(IPC.planAddFact, {
    schema: PlanFactAddInputSchema,
    mutation: true,
    handler: (payload) => plan.addFact(payload)
  })
  register(IPC.planRemoveFact, {
    schema: PlanFactIdInputSchema,
    mutation: true,
    handler: (payload) => plan.removeFact(payload)
  })
  register(IPC.planApplyProposal, {
    schema: PlanProposalIdInputSchema,
    mutation: true,
    handler: (payload) => plan.applyProposal(payload)
  })
  register(IPC.planRejectProposal, {
    schema: PlanProposalIdInputSchema,
    mutation: true,
    handler: (payload) => plan.rejectProposal(payload)
  })
  register(IPC.planChoose, {
    schema: PlanChooseInputSchema,
    mutation: true,
    handler: (payload) => plan.choose(payload)
  })
  register(IPC.planG1Preview, { schema: PlanEmptyInputSchema, handler: () => plan.g1Preview() })
  register(IPC.planConfirmG1, {
    schema: PlanEmptyInputSchema,
    mutation: true,
    handler: () => plan.confirmG1()
  })
  register(IPC.planRetrySetup, {
    schema: PlanEmptyInputSchema,
    mutation: true,
    handler: () => plan.retrySetup()
  })
  register(IPC.planCoverage, { schema: PlanCoverageInputSchema, handler: () => plan.coverage() })
  register(IPC.planCoverageGate, {
    schema: PlanCoverageGateInputSchema,
    mutation: true,
    handler: (payload) => plan.setCoverageGate(payload)
  })
  register(IPC.planImpact, {
    schema: PlanImpactAnalyzeInputSchema,
    mutation: true,
    handler: (payload) => plan.analyzeImpact(payload)
  })
  register(IPC.planChanges, { schema: PlanEmptyInputSchema, handler: () => plan.listChanges() })
  register(IPC.planChangeApply, {
    schema: PlanChangeApplyInputSchema,
    mutation: true,
    handler: (payload) => plan.applyChange(payload)
  })
  register(IPC.planChangeReject, {
    schema: PlanChangeIdInputSchema,
    mutation: true,
    handler: (payload) => plan.rejectChange(payload)
  })
  register(IPC.planChapterDismiss, {
    schema: PlanDismissValidationInputSchema,
    mutation: true,
    handler: (payload) => plan.dismissInvalidation(payload)
  })

  const write = deps.write
  register(IPC.writeState, {
    schema: WriteChapterInputSchema.partial(),
    handler: (payload) => write.state(payload.chapterId)
  })
  register(IPC.writeSaveStoryboard, {
    schema: WriteStoryboardSaveInputSchema,
    mutation: true,
    handler: (payload) => write.saveStoryboard(payload)
  })
  register(IPC.writeValidateStoryboard, {
    schema: WriteStoryboardValidateInputSchema,
    handler: (payload) => write.validateStoryboard(payload)
  })
  register(IPC.writeG2Preview, {
    schema: WriteG2InputSchema,
    handler: (payload) => write.g2Preview(payload.chapterId)
  })
  register(IPC.writeG2Confirm, {
    schema: WriteG2InputSchema,
    mutation: true,
    handler: (payload) => write.confirmG2(payload.chapterId)
  })
  register(IPC.writeGenerate, {
    schema: WriteBeatInputSchema,
    mutation: true,
    handler: (payload) => write.generate(payload.beatId)
  })
  register(IPC.writeRegenerate, {
    schema: WriteBeatInputSchema,
    mutation: true,
    handler: (payload) => write.regenerate(payload.beatId)
  })
  register(IPC.writeConfirm, {
    schema: WriteConfirmInputSchema,
    mutation: true,
    handler: (payload) => write.confirm(payload.beatId)
  })
  register(IPC.writeEdit, {
    schema: WriteEditInputSchema,
    mutation: true,
    handler: (payload) => write.edit(payload)
  })
  register(IPC.writeStaleResolve, {
    schema: WriteStaleChoiceInputSchema,
    mutation: true,
    handler: (payload) => write.resolveStale(payload)
  })
  register(IPC.writePreflight, {
    schema: WriteChapterInputSchema,
    handler: (payload) => write.preflight(payload.chapterId)
  })
  register(IPC.writeAutoStart, {
    schema: WriteChapterInputSchema,
    mutation: true,
    handler: (payload) => write.autoStart(payload.chapterId)
  })
  register(IPC.writePause, {
    schema: WriteChapterInputSchema,
    mutation: true,
    handler: (payload) => write.pauseChapter(payload.chapterId)
  })
  register(IPC.writeResume, {
    schema: WriteChapterInputSchema,
    mutation: true,
    handler: (payload) => write.resume(payload.chapterId)
  })
  register(IPC.writeCancel, {
    schema: WriteChapterInputSchema,
    mutation: true,
    handler: (payload) => write.cancel(payload.chapterId)
  })
  register(IPC.writeSend, {
    schema: WriteSendInputSchema,
    mutation: true,
    handler: (payload) => write.send(payload)
  })
  register(IPC.writeSceneLink, {
    schema: WriteSceneLinkInputSchema,
    mutation: true,
    handler: (payload) => write.linkScene(payload)
  })
  register(IPC.writeSceneUnlink, {
    schema: WriteSceneLinkInputSchema,
    mutation: true,
    handler: (payload) => write.unlinkScene(payload)
  })
  register(IPC.writeSceneReorder, {
    schema: WriteSceneReorderInputSchema,
    mutation: true,
    handler: (payload) => write.reorderScenes(payload)
  })
  register(IPC.writeSceneFork, {
    schema: WriteSceneLinkInputSchema,
    mutation: true,
    handler: (payload) => write.forkScene(payload)
  })
  register(IPC.writeSceneRemove, {
    schema: WriteSceneLinkInputSchema,
    mutation: true,
    handler: (payload) => write.deleteScene(payload)
  })
  register(IPC.writeSceneTime, {
    schema: WriteSceneTimeInputSchema,
    mutation: true,
    handler: (payload) => write.setSceneTime(payload)
  })
  register(IPC.writeTimeline, {
    schema: WriteTimelineInputSchema,
    handler: (payload) => write.timeline(payload.chapterId)
  })
  register(IPC.writeContext, {
    schema: WriteContextInputSchema,
    handler: (payload) => write.inspectContext(payload.beatId)
  })
  if (deps.devTools) {
    register(IPC.writeDevSeed, {
      schema: WriteDevSeedInputSchema,
      mutation: true,
      handler: (payload) => {
        const state = write.devSeed(payload)
        deps.project.refreshState()
        return state
      }
    })
  }

  const review = deps.review
  register(IPC.reviewState, {
    schema: ReviewChapterInputSchema.partial(),
    handler: (payload) => review.state(payload.chapterId)
  })
  register(IPC.reviewRun, {
    schema: ReviewChapterInputSchema,
    mutation: true,
    handler: (payload) => review.run(payload.chapterId)
  })
  register(IPC.reviewSend, {
    schema: ReviewSendInputSchema,
    mutation: true,
    handler: (payload) => review.send(payload.chapterId, payload.text)
  })
  register(IPC.reviewG5, {
    schema: ReviewChapterInputSchema,
    mutation: true,
    handler: (payload) => review.authorizeRevision(payload.chapterId)
  })
  register(IPC.reviewDecide, {
    schema: ReviewDecideInputSchema,
    mutation: true,
    handler: (payload) => review.decide(payload)
  })
  register(IPC.reviewRecheck, {
    schema: ReviewChapterInputSchema,
    mutation: true,
    handler: (payload) => review.recheck(payload.chapterId)
  })
  register(IPC.reviewCompare, {
    schema: ReviewCompareInputSchema,
    handler: (payload) => review.compare(payload)
  })
  register(IPC.reviewG6Preview, {
    schema: ReviewChapterInputSchema,
    handler: (payload) => review.finalizePreview(payload.chapterId)
  })
  register(IPC.reviewG6Issue, {
    schema: ReviewChapterInputSchema,
    mutation: true,
    handler: (payload) => review.issueFinalizeToken(payload.chapterId)
  })
  register(IPC.reviewFinalize, {
    schema: ReviewFinalizeInputSchema,
    mutation: true,
    handler: (payload) => review.finalize(payload)
  })
  register(IPC.reviewReopen, {
    schema: ReviewReopenInputSchema,
    mutation: true,
    handler: (payload) => review.reopen(payload)
  })
  register(IPC.reviewBranchCreate, {
    schema: ReviewBranchCreateInputSchema,
    mutation: true,
    handler: (payload) => review.createBranch(payload)
  })
  register(IPC.reviewBranchSwitch, {
    schema: ReviewBranchSwitchInputSchema,
    mutation: true,
    handler: (payload) => review.switchBranch(payload)
  })
  if (deps.devTools) {
    register(IPC.reviewDevSeed, {
      schema: ReviewDevSeedInputSchema,
      mutation: true,
      handler: (payload) => {
        const state = review.devSeed(payload)
        deps.project.refreshState()
        return state
      }
    })
  }

  const memory = deps.memory
  register(IPC.memoryState, {
    schema: MemoryStateInputSchema,
    handler: (payload) => memory.state(payload.chapterId)
  })
  register(IPC.memoryExtract, {
    schema: MemoryChapterInputSchema,
    mutation: true,
    handler: (payload) => memory.extract(payload.chapterId)
  })
  register(IPC.memoryDecide, {
    schema: MemoryDecideInputSchema,
    mutation: true,
    handler: (payload) => memory.decide(payload)
  })
  register(IPC.memoryDecideMany, {
    schema: MemoryDecideManyInputSchema,
    mutation: true,
    handler: (payload) => memory.decideMany(payload)
  })
  register(IPC.memoryG7Issue, {
    schema: MemoryStateInputSchema,
    mutation: true,
    handler: (payload) => memory.issueG7Token(payload.chapterId)
  })
  register(IPC.memoryApply, {
    schema: MemoryApplyInputSchema,
    mutation: true,
    handler: (payload) => memory.apply(payload)
  })
  register(IPC.memoryInvalidate, {
    schema: MemoryInvalidateInputSchema,
    mutation: true,
    handler: (payload) => memory.invalidate(payload)
  })
  register(IPC.memoryRecall, {
    schema: MemoryRecallInputSchema,
    handler: (payload) => memory.recall(payload)
  })
  register(IPC.memoryIsolation, {
    schema: EmptySchema,
    handler: () => memory.isolationReport()
  })
  register(IPC.memorySend, {
    schema: MemorySendInputSchema,
    mutation: true,
    handler: (payload) => memory.send(payload)
  })
  register(IPC.memoryRebuildIssue, {
    schema: MemoryStateInputSchema,
    mutation: true,
    handler: (payload) => memory.issueRebuildToken(payload.chapterId)
  })
  register(IPC.memoryRebuild, {
    schema: MemoryRebuildInputSchema,
    mutation: true,
    handler: (payload) => memory.rebuild(payload)
  })
  register(IPC.memoryIndexIssue, {
    schema: EmptySchema,
    mutation: true,
    handler: () => memory.issueIndexToken()
  })
  register(IPC.memoryIndexRebuild, {
    schema: IndexRebuildInputSchema,
    mutation: true,
    handler: (payload) => memory.reindex(payload)
  })
  if (deps.devTools) {
    register(IPC.memoryDevSeed, {
      schema: MemoryDevSeedInputSchema,
      mutation: true,
      handler: (payload) => {
        const state = memory.devSeed(payload)
        deps.project.refreshState()
        return state
      }
    })
  }

  const world = deps.world
  register(IPC.worldProjection, {
    schema: WorldProjectionInputSchema,
    handler: (payload) => world.projection(payload)
  })
  register(IPC.worldFactAdd, {
    schema: WorldFactAddSchema,
    mutation: true,
    handler: (payload) => world.addFact(payload)
  })
  register(IPC.worldFactClose, {
    schema: WorldFactCloseSchema,
    mutation: true,
    handler: (payload) => world.closeFact(payload)
  })
  register(IPC.worldRelations, {
    schema: RelationGraphInputSchema,
    handler: (payload) => world.relations(payload)
  })
  register(IPC.worldForeshadowList, {
    schema: ForeshadowListInputSchema,
    handler: (payload) => world.foreshadows(payload)
  })
  register(IPC.worldForeshadowCreate, {
    schema: ForeshadowCreateInputSchema,
    mutation: true,
    handler: (payload) => world.foreshadowCreate(payload)
  })
  register(IPC.worldForeshadowUpdate, {
    schema: ForeshadowUpdateInputSchema,
    mutation: true,
    handler: (payload) => world.foreshadowUpdate(payload)
  })
  register(IPC.worldForeshadowClose, {
    schema: ForeshadowCloseInputSchema,
    mutation: true,
    handler: (payload) => world.foreshadowClose(payload)
  })
  register(IPC.worldForeshadowReopen, {
    schema: ForeshadowIdInputSchema,
    mutation: true,
    handler: (payload) => world.foreshadowReopen(payload)
  })
  register(IPC.worldForeshadowRemove, {
    schema: ForeshadowIdInputSchema,
    mutation: true,
    handler: (payload) => world.foreshadowRemove(payload)
  })

  const slice = deps.slice
  if (slice) {
    register(IPC.sliceSeed, {
      schema: SliceEmptyInputSchema,
      mutation: true,
      handler: () => slice.seed()
    })
    register(IPC.sliceState, { schema: SliceEmptyInputSchema, handler: () => slice.state() })
    register(IPC.sliceGenerate, {
      schema: SliceBeatInputSchema,
      mutation: true,
      handler: (payload) => slice.generate(payload.beatId)
    })
    register(IPC.sliceRegenerate, {
      schema: SliceBeatInputSchema,
      mutation: true,
      handler: (payload) => slice.regenerate(payload.beatId)
    })
    register(IPC.sliceConfirm, {
      schema: SliceBeatInputSchema,
      mutation: true,
      handler: (payload) => slice.confirm(payload.beatId)
    })
    register(IPC.sliceEdit, {
      schema: SliceEditInputSchema,
      mutation: true,
      handler: (payload) => slice.edit(payload)
    })
  }
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) {
    ipcMain.removeHandler(channel)
  }
}
