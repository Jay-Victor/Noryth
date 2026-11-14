import type { IpcResult } from './ipc'
import type {
  AppInfo,
  CreateProjectInput,
  CreateProjectResult,
  OpenProjectInput,
  OpenProjectResult,
  PathCheck,
  ProjectStateEvent,
  ProjectSummary,
  RelocateProjectInput,
  Settings,
  SettingsPatch,
  UpdateProjectMetaInput,
  ValidatePathInput
} from './project'

/**
 * preload 暴露的全部能力（window.noryth）。
 * 只有命名空间方法，没有通用 invoke(channel, ...)（DEV-PLAN §4.2）。
 */
export interface ProjectApi {
  list(): Promise<IpcResult<ProjectSummary[]>>
  current(): Promise<IpcResult<OpenProjectResult | null>>
  validatePath(input: ValidatePathInput): Promise<IpcResult<PathCheck>>
  create(input: CreateProjectInput): Promise<IpcResult<CreateProjectResult>>
  open(input: OpenProjectInput): Promise<IpcResult<OpenProjectResult>>
  close(projectId: string): Promise<IpcResult<{ closed: boolean }>>
  removeFromList(projectId: string): Promise<IpcResult<{ removed: boolean }>>
  relocate(input: RelocateProjectInput): Promise<IpcResult<{ path: string }>>
  updateMeta(input: UpdateProjectMetaInput): Promise<IpcResult<ProjectSummary>>
  reveal(projectId: string): Promise<IpcResult<{ revealed: boolean }>>
}

export interface DialogApi {
  pickDirectory(): Promise<IpcResult<{ path: string | null }>>
  pickProject(): Promise<IpcResult<{ path: string | null }>>
}

export interface SettingsApi {
  get(): Promise<IpcResult<Settings>>
  set(patch: SettingsPatch): Promise<IpcResult<Settings>>
}

export interface DiagnosticsApi {
  export(): Promise<IpcResult<{ path: string }>>
}

export interface AppApi {
  info(): Promise<IpcResult<AppInfo>>
}

export interface EventApi {
  onProjectState(listener: (event: ProjectStateEvent) => void): () => void
}

export interface NorythBridge {
  project: ProjectApi
  dialog: DialogApi
  settings: SettingsApi
  diagnostics: DiagnosticsApi
  app: AppApi
  events: EventApi
}
