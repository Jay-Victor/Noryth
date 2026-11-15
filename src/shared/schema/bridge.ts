import type { IpcResult } from './ipc'
import type {
  AppearancePatch,
  BindingAuditEntry,
  BindingMatrix,
  BindingSetInput,
  ProviderClearInput,
  ProviderKeySetInput,
  ProviderKeyStatus,
  ProviderTestInput,
  ProviderTestResult,
  SettingsView
} from './settings'
import type {
  PlanAddOutlineInput,
  PlanCharacterAddInput,
  PlanCharacterSaveInput,
  PlanChoiceRequest,
  PlanChooseInput,
  PlanEvent,
  PlanFactAddInput,
  PlanFactSaveInput,
  PlanG1Preview,
  PlanG1Result,
  PlanProposalApplyResult,
  PlanSaveOutlineInput,
  PlanSaveResult,
  PlanSendInput,
  PlanSendResult,
  PlanSessionCreateInput,
  PlanSessionView,
  PlanState
} from './plan'
import type {
  SliceBeatEvent,
  SliceEditInput,
  SliceGenerateResult,
  SliceSeedResult,
  SliceState
} from './slice'
import type { StoryboardConflict, StoryboardDraft } from './storyboard'
import type {
  MemoryActionResult,
  MemoryEvent,
  MemoryIssueResult,
  MemoryRecallResult,
  MemorySendResult,
  MemoryState
} from './memory'
import type {
  ReviewActionResult,
  ReviewCompareResult,
  ReviewEvent,
  ReviewFinalizePreview,
  ReviewSendResult,
  ReviewState
} from './review'
import type {
  WriteActionResult,
  WriteEvent,
  WritePreflightState,
  WriteSendResult,
  WriteState
} from './write'
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
  /** 设置中心视图：Key 只回末 4 位，绑定/提供方/外观一次取齐（PHASE-10 I1–I4）。 */
  view(): Promise<IpcResult<SettingsView>>
  appearance(patch: AppearancePatch): Promise<IpcResult<SettingsView>>
  setProviderKey(input: ProviderKeySetInput): Promise<IpcResult<ProviderKeyStatus>>
  clearProviderKey(input: ProviderClearInput): Promise<IpcResult<ProviderKeyStatus>>
  setProviderEnabled(input: { preset: ProviderTestInput['preset']; enabled: boolean }): Promise<IpcResult<SettingsView>>
  /** 测试连接：用 safeStorage 里的 Key（或本次临时 Key），返回延迟、模型与错误码。 */
  testProvider(input: ProviderTestInput): Promise<IpcResult<ProviderTestResult>>
  bindings(projectId: string): Promise<IpcResult<BindingMatrix>>
  setBindings(input: BindingSetInput): Promise<IpcResult<BindingMatrix>>
  rollbackBindings(projectId: string): Promise<IpcResult<BindingMatrix>>
  bindingAudit(projectId: string): Promise<IpcResult<BindingAuditEntry[]>>
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

/** 规划台 API（PHASE-06）。所有写操作在只读项目上由主进程拒绝。 */
export interface PlanApi {
  state(sessionId?: string): Promise<IpcResult<PlanState>>
  createSession(input: PlanSessionCreateInput): Promise<IpcResult<PlanSessionView>>
  renameSession(input: { sessionId: string; title: string }): Promise<IpcResult<PlanSessionView>>
  archiveSession(sessionId: string): Promise<IpcResult<{ archived: boolean }>>
  send(input: PlanSendInput): Promise<IpcResult<PlanSendResult>>
  stop(sessionId: string): Promise<IpcResult<{ stopped: boolean }>>
  retry(messageId: string): Promise<IpcResult<PlanSendResult>>
  saveOutline(input: PlanSaveOutlineInput): Promise<IpcResult<PlanSaveResult>>
  addOutline(input: PlanAddOutlineInput): Promise<IpcResult<{ id: string; version: number }>>
  removeOutline(nodeId: string): Promise<IpcResult<{ removed: boolean }>>
  saveCharacter(
    input: PlanCharacterSaveInput
  ): Promise<IpcResult<PlanSaveResult & { cardVersion: number; affectedChapters: string[] }>>
  addCharacter(input: PlanCharacterAddInput): Promise<IpcResult<{ id: string; cardVersion: number }>>
  removeCharacter(characterId: string): Promise<IpcResult<{ removed: boolean }>>
  saveFact(input: PlanFactSaveInput): Promise<IpcResult<PlanSaveResult>>
  addFact(input: PlanFactAddInput): Promise<IpcResult<{ id: string; ord: number }>>
  removeFact(factId: string): Promise<IpcResult<{ removed: boolean }>>
  applyProposal(proposalId: string): Promise<IpcResult<PlanProposalApplyResult>>
  rejectProposal(proposalId: string): Promise<IpcResult<{ rejected: boolean }>>
  choose(input: PlanChooseInput): Promise<IpcResult<{ chosen: boolean }>>
  g1Preview(): Promise<IpcResult<PlanG1Preview>>
  confirmG1(): Promise<IpcResult<PlanG1Result>>
  retrySetup(): Promise<IpcResult<PlanG1Result>>
}

export interface EventApi {
  onProjectState(listener: (event: ProjectStateEvent) => void): () => void
  onSliceBeat(listener: (event: SliceBeatEvent) => void): () => void
  onPlanMessage(listener: (event: PlanEvent) => void): () => void
  onPlanChoice(listener: (event: PlanChoiceRequest) => void): () => void
  onWriteEvent(listener: (event: WriteEvent) => void): () => void
  onReviewEvent(listener: (event: ReviewEvent) => void): () => void
  onMemoryEvent(listener: (event: MemoryEvent) => void): () => void
}

/** 创作台 G2 预览（PHASE-07 F1）。 */
export interface WriteG2Preview {
  chapterId: string
  ready: boolean
  blocker: string | null
  conflicts: StoryboardConflict[]
  sceneCount: number
  beatCount: number
  storyboardRev: number | null
  maxBeats: number
}

/** 创作台 API（PHASE-07）。所有写操作在只读项目上由主进程拒绝。 */
export interface WriteApi {
  state(chapterId?: string): Promise<IpcResult<WriteState>>
  saveStoryboard(input: {
    chapterId: string
    scenes: StoryboardDraft['scenes']
  }): Promise<IpcResult<{ state: WriteState; conflicts: StoryboardConflict[] }>>
  validateStoryboard(input: {
    chapterId: string
    scenes: StoryboardDraft['scenes']
  }): Promise<IpcResult<StoryboardConflict[]>>
  g2Preview(chapterId: string): Promise<IpcResult<WriteG2Preview>>
  confirmG2(chapterId: string): Promise<IpcResult<WriteActionResult>>
  generate(beatId: string): Promise<IpcResult<WriteActionResult>>
  regenerate(beatId: string): Promise<IpcResult<WriteActionResult>>
  confirm(beatId: string): Promise<IpcResult<WriteActionResult>>
  edit(input: { beatId: string; body: string; expectedRevision: string | null }): Promise<IpcResult<WriteActionResult>>
  resolveStale(input: {
    chapterId: string
    beatId: string
    choice: 'replace' | 'rerun' | 'branch'
  }): Promise<IpcResult<WriteActionResult>>
  preflight(chapterId: string): Promise<IpcResult<WritePreflightState>>
  autoStart(chapterId: string): Promise<IpcResult<WriteActionResult>>
  pause(chapterId: string): Promise<IpcResult<WriteActionResult>>
  resume(chapterId: string): Promise<IpcResult<WriteActionResult>>
  cancel(chapterId: string): Promise<IpcResult<WriteActionResult>>
  send(input: { chapterId: string; text: string }): Promise<IpcResult<WriteSendResult>>
  /** 仅未打包构建：E2E 脚手架，生产包调用返回 invalid_args。 */
  devSeed(input?: { scenes?: number; beatsPerScene?: number; exit?: string }): Promise<IpcResult<WriteState>>
}

/** 审批台 API（PHASE-08）。G5/G6 的令牌都在主进程签发，renderer 只持有一次性 token。 */
export interface ReviewApi {
  state(chapterId?: string): Promise<IpcResult<ReviewState>>
  /** G4：生成全量审批报告。 */
  run(chapterId: string): Promise<IpcResult<ReviewActionResult>>
  send(input: { chapterId: string; text: string }): Promise<IpcResult<ReviewSendResult>>
  /** G5：授权修订并产出 patch 提案。 */
  authorizeRevision(chapterId: string): Promise<IpcResult<ReviewActionResult>>
  decide(input: {
    chapterId: string
    expectedRevision: string | null
    decisions: Array<{ patchId: string; accept: boolean }>
  }): Promise<IpcResult<ReviewActionResult>>
  /** 复检：只跑受影响维度。 */
  recheck(chapterId: string): Promise<IpcResult<ReviewActionResult>>
  compare(input: {
    chapterId: string
    leftRevisionId: string
    rightRevisionId: string
  }): Promise<IpcResult<ReviewCompareResult>>
  /** G6：打开确认框前取「阻断/未复检」清单（不签发令牌）。 */
  finalizePreview(chapterId: string): Promise<IpcResult<ReviewFinalizePreview>>
  /** G6：签发一次性定稿令牌（10 分钟）；只有真正点「确认定稿」时才调用。 */
  issueFinalizeToken(
    chapterId: string
  ): Promise<IpcResult<{ token: string; expiresAt: string; preview: ReviewFinalizePreview }>>
  finalize(input: {
    chapterId: string
    token: string
    ackBlocking: boolean
    ackUnreviewed: boolean
    reason?: string
  }): Promise<IpcResult<ReviewActionResult>>
  /** 仅未打包构建：E2E 脚手架。 */
  devSeed(input?: { scenes?: number; beatsPerScene?: number }): Promise<IpcResult<ReviewState>>
}

/** 记忆台 API（PHASE-09）。G7 令牌在主进程签发；apply 是唯一写记忆的入口。 */
export interface MemoryApi {
  state(chapterId?: string): Promise<IpcResult<MemoryState>>
  /** 生成固化提案（只写 job + 提案，不写记忆库）。 */
  extract(chapterId: string): Promise<IpcResult<MemoryActionResult>>
  decide(input: {
    itemId: string
    decision: 'accept' | 'edit' | 'reject'
    editedText?: string
  }): Promise<IpcResult<MemoryActionResult>>
  decideMany(input: {
    decisions: Array<{ itemId: string; decision: 'accept' | 'edit' | 'reject'; editedText?: string }>
  }): Promise<IpcResult<MemoryActionResult>>
  /** G7：签发一次性应用令牌（10 分钟）。 */
  issueG7Token(chapterId?: string): Promise<IpcResult<MemoryIssueResult>>
  apply(input: { chapterId?: string; token: string }): Promise<IpcResult<MemoryActionResult>>
  /** 标记错误：软失效，不删除。 */
  invalidate(input: { entryId: string; reason: string }): Promise<IpcResult<MemoryActionResult>>
  /** 召回探针（只读）：用真实检索管线按角色取记忆。 */
  recall(input: {
    characterId: string
    query: string
    asOf?: number
    topK?: number
  }): Promise<IpcResult<MemoryRecallResult>>
  /** 隔离回归（H5）：写向量后的跨角色探针。 */
  isolation(): Promise<IpcResult<{ verified: boolean; probes: Array<{ characterId: string; query: string; hits: number; foreign: number }> }>>
  send(input: { chapterId?: string; text: string }): Promise<IpcResult<MemorySendResult>>
  /** 仅未打包构建：E2E 脚手架。 */
  devSeed(input?: {
    scenes?: number
    beatsPerScene?: number
    extraChapters?: number
  }): Promise<IpcResult<MemoryState>>
}

export interface NorythBridge {
  project: ProjectApi
  dialog: DialogApi
  settings: SettingsApi
  diagnostics: DiagnosticsApi
  slice: SliceApi
  plan: PlanApi
  write: WriteApi
  review: ReviewApi
  memory: MemoryApi
  app: AppApi
  events: EventApi
}
