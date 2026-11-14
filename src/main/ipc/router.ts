import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
  type AppInfo
} from '../../shared/schema/project'
import { ProviderProbeInputSchema } from '../../shared/schema/model'
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
  SliceBeatInputSchema,
  SliceEditInputSchema,
  SliceEmptyInputSchema
} from '../../shared/schema/slice'
import { probeProvider } from '../model/probe'
import type { Logger } from '../observability/logger'
import { exportDiagnostics } from '../observability/diagnostics'
import type { PlanService } from '../plan/service'
import type { ProjectService } from '../project/service'
import type { SettingsStore } from '../settings/store'
import type { SliceService } from '../slice/service'

const EnvelopeSchema = z.strictObject({ requestId: z.string().min(1), payload: z.unknown() })
const EmptySchema = z.strictObject({})

export interface IpcDeps {
  project: ProjectService
  settings: SettingsStore
  logger: Logger
  logPath: string
  userDataDir: string
  appInfo: () => AppInfo
  plan: PlanService
  /** 仅未打包构建注入；生产包不注册切片通道。 */
  slice?: SliceService
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

/** 规划会话生成中不允许切换/关闭项目：DB 连接会关闭，异步写入没有落点。 */
function assertPlanIdle(plan: PlanService): void {
  if (plan.isBusy()) throw new AppError('invalid_args', '规划会话生成中，请先停止再切换项目')
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

  register(IPC.appInfo, { schema: EmptySchema, handler: () => deps.appInfo() })

  register(IPC.projectList, { schema: EmptySchema, handler: () => deps.project.list() })

  register(IPC.projectCurrent, { schema: EmptySchema, handler: () => deps.project.currentResult() })

  register(IPC.projectValidatePath, {
    schema: ValidatePathInputSchema,
    handler: (payload) => deps.project.validatePath(payload)
  })

  register(IPC.projectCreate, {
    schema: CreateProjectInputSchema,
    handler: (payload) => {
      assertPlanIdle(deps.plan)
      const result = deps.project.create(payload)
      deps.settings.write({ lastOpenedProjectId: result.projectId })
      return result
    }
  })

  register(IPC.projectOpen, {
    schema: OpenProjectInputSchema,
    handler: (payload) => {
      assertPlanIdle(deps.plan)
      const result = deps.project.open(payload)
      deps.settings.write({ lastOpenedProjectId: result.project.id })
      return result
    }
  })

  register(IPC.projectClose, {
    schema: ProjectIdInputSchema,
    handler: (payload) => {
      assertPlanIdle(deps.plan)
      return { closed: deps.project.close(payload.projectId) }
    }
  })

  register(IPC.projectRemoveFromList, {
    schema: ProjectIdInputSchema,
    handler: (payload) => {
      assertPlanIdle(deps.plan)
      return { removed: deps.project.removeFromList(payload.projectId) }
    }
  })

  register(IPC.projectRelocate, {
    schema: RelocateProjectInputSchema,
    handler: (payload) => {
      assertPlanIdle(deps.plan)
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
    schema: ProviderProbeInputSchema,
    handler: (payload) =>
      probeProvider(payload, {
        save: (preset, snapshot) => {
          const current = deps.settings.read()
          deps.settings.write({ providers: { ...current.providers, [preset]: snapshot } })
        }
      })
  })

  register(IPC.diagnosticsExport, {
    schema: EmptySchema,
    handler: () => {
      const path = exportDiagnostics({
        userDataDir: deps.userDataDir,
        appInfo: deps.appInfo(),
        settings: deps.settings.read(),
        projects: deps.project.list(),
        logPath: deps.logPath
      })
      return { path }
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
