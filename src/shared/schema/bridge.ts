import type { IpcResult } from './ipc'
import type { ProviderProbeInput, ProviderProbeResult } from './model'
import type {
  SliceBeatEvent,
  SliceEditInput,
  SliceGenerateResult,
  SliceSeedResult,
  SliceState
} from './slice'
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
  /** 测试连接（PHASE-04 D2）：Key 只用于本次探测，不写盘。 */
  probeProvider(input: ProviderProbeInput): Promise<IpcResult<ProviderProbeResult>>
}

export interface DiagnosticsApi {
  export(): Promise<IpcResult<{ path: string }>>
}

/**
 * 开发切片 API（PHASE-05）。生产包不注册这些通道，调用会得到 invalid_args；
 * renderer 只在未打包构建的 `#/dev/slice` 页面使用。
 */
export interface SliceApi {
  seed(): Promise<IpcResult<SliceSeedResult>>
  state(): Promise<IpcResult<SliceState>>
  generate(beatId: string): Promise<IpcResult<SliceGenerateResult>>
  regenerate(beatId: string): Promise<IpcResult<SliceGenerateResult>>
  confirm(beatId: string): Promise<IpcResult<SliceState>>
  edit(input: SliceEditInput): Promise<IpcResult<SliceState>>
}

export interface AppApi {
  info(): Promise<IpcResult<AppInfo>>
}

export interface EventApi {
  onProjectState(listener: (event: ProjectStateEvent) => void): () => void
  onSliceBeat(listener: (event: SliceBeatEvent) => void): () => void
}

export interface NorythBridge {
  project: ProjectApi
  dialog: DialogApi
  settings: SettingsApi
  diagnostics: DiagnosticsApi
  slice: SliceApi
  app: AppApi
  events: EventApi
}
