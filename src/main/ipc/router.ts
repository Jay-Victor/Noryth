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
import { probeProvider } from '../model/probe'
import type { Logger } from '../observability/logger'
import { exportDiagnostics } from '../observability/diagnostics'
import type { ProjectService } from '../project/service'
import type { SettingsStore } from '../settings/store'

const EnvelopeSchema = z.strictObject({ requestId: z.string().min(1), payload: z.unknown() })
const EmptySchema = z.strictObject({})

export interface IpcDeps {
  project: ProjectService
  settings: SettingsStore
  logger: Logger
  logPath: string
  userDataDir: string
  appInfo: () => AppInfo
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
      const result = deps.project.create(payload)
      deps.settings.write({ lastOpenedProjectId: result.projectId })
      return result
    }
  })

  register(IPC.projectOpen, {
    schema: OpenProjectInputSchema,
    handler: (payload) => {
      const result = deps.project.open(payload)
      deps.settings.write({ lastOpenedProjectId: result.project.id })
      return result
    }
  })

  register(IPC.projectClose, {
    schema: ProjectIdInputSchema,
    handler: (payload) => ({ closed: deps.project.close(payload.projectId) })
  })

  register(IPC.projectRemoveFromList, {
    schema: ProjectIdInputSchema,
    handler: (payload) => ({ removed: deps.project.removeFromList(payload.projectId) })
  })

  register(IPC.projectRelocate, {
    schema: RelocateProjectInputSchema,
    handler: (payload) => deps.project.relocate(payload)
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
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) {
    ipcMain.removeHandler(channel)
  }
}
