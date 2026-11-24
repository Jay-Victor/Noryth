import type { IpcResult } from './ipc'
import type { DiagnosticsExportInput, DiagnosticsExportResult, ExportRequest, ExportResult } from './export'
import type { UpdateState } from './update'
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
  BlueprintChangeView,
  PlanChangeApplyResult,
  PlanCoverageState,
  PlanImpactAnalyzeInput
} from './blueprint'
import type {
  ForeshadowCreateInput,
  ForeshadowListInput,
  ForeshadowMutationResult,
  ForeshadowState,
  ForeshadowUpdateInput
} from './foreshadow'
import type { VoiceSceneInput, VoiceSceneState } from './voice'
import type { CostReport, CostReportInput, WriteBudgetInput } from './cost'
import type { CalibrationReport } from './calibration'
import type { RoutingEvent, RoutingStatus } from './routing'
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
  IndexRebuildIssueResult,
  MemoryActionResult,
  MemoryArchiveApplyResult,
  MemoryArchiveCandidatesState,
  MemoryArchiveIssueResult,
  MemoryEvent,
  MemoryIssueResult,
  MemoryRecallResult,
  MemoryRebuildIssueResult,
  MemorySendResult,
  MemoryState,
  RelationGraph,
  RelationGraphInput,
  ToolCallListInput,
  ToolCallListState,
  WorldFactActionResult,
  WorldFactAddInput,
  WorldFactCloseInput,
  WorldProjectionInput,
  WorldProjectionState
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
  WriteContextInspection,
  WriteEvent,
  WritePreflightState,
  WriteSendResult,
  WriteState,
  WriteTimeline
} from './write'
import type {
  AppInfo,
  AutoOpenResult,
  CreateProjectInput,
  CreateProjectResult,
  OpenProjectInput,
  OpenProjectResult,
  PathCheck,
  ProjectBusyState,
  ProjectStateEvent,
  ProjectSummary,
  ProjectTree,
  ProjectVerifyResult,
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
  /** 启动自动打开上次项目（PHASE-11 M1-24）：失败回首页，不自动只读打开。 */
  autoOpen(): Promise<IpcResult<AutoOpenResult>>
  /** 切换前的运行态探测（PHASE-11 §5.1）。 */
  busy(): Promise<IpcResult<ProjectBusyState>>
  /** 文件树抽屉的数据源（结构 + 数据库视图，不含正文）。 */
  tree(): Promise<IpcResult<ProjectTree>>
  validatePath(input: ValidatePathInput): Promise<IpcResult<PathCheck>>
  create(input: CreateProjectInput): Promise<IpcResult<CreateProjectResult>>
  open(input: OpenProjectInput): Promise<IpcResult<OpenProjectResult>>
  close(projectId: string): Promise<IpcResult<{ closed: boolean }>>
  removeFromList(projectId: string): Promise<IpcResult<{ removed: boolean }>>
  relocate(input: RelocateProjectInput): Promise<IpcResult<{ path: string }>>
  updateMeta(input: UpdateProjectMetaInput): Promise<IpcResult<ProjectSummary>>
  reveal(projectId: string): Promise<IpcResult<{ revealed: boolean }>>
  /** 只读 DB 校验（PHASE-18 M1-15）：仅未打包构建注册；生产包返回 invalid_args。 */
  verify(): Promise<IpcResult<ProjectVerifyResult>>
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
  /** 导出 zip（PHASE-11 M1-24）：不含正文与 Key；作者取消保存时 cancelled=true。 */
  export(input?: DiagnosticsExportInput): Promise<IpcResult<DiagnosticsExportResult>>
}

/** 稿件导出（PRD §5.5）：Markdown / TXT，可选附带审批批注。 */
export interface ManuscriptApi {
  export(input: ExportRequest): Promise<IpcResult<ExportResult>>
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
  /** 手动检查更新（PHASE-18 M1-7）：下载仍由 electron-updater 后台做；失败不阻塞。 */
  checkUpdates(): Promise<IpcResult<UpdateState>>
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
  /** 覆盖检查（M1-11）：与 G1 阻断同一份规则；gate=false 时不阻断。 */
  coverage(): Promise<IpcResult<PlanCoverageState>>
  setCoverageGate(enabled: boolean): Promise<IpcResult<PlanCoverageState>>
  /** 影响分析（M1-8）：写一条 blueprint_change(status=proposed)。 */
  analyzeImpact(input: PlanImpactAnalyzeInput): Promise<IpcResult<BlueprintChangeView>>
  changes(): Promise<IpcResult<BlueprintChangeView[]>>
  applyChange(input: { changeId: string; markChapters?: boolean }): Promise<IpcResult<PlanChangeApplyResult>>
  rejectChange(changeId: string): Promise<IpcResult<BlueprintChangeView>>
  /** 作者忽略跨章标脏：只清标记，不改正文。 */
  dismissInvalidation(chapterId: string): Promise<IpcResult<{ dismissed: boolean }>>
}

export interface EventApi {
  onProjectState(listener: (event: ProjectStateEvent) => void): () => void
  onSliceBeat(listener: (event: SliceBeatEvent) => void): () => void
  onPlanMessage(listener: (event: PlanEvent) => void): () => void
  onPlanChoice(listener: (event: PlanChoiceRequest) => void): () => void
  onWriteEvent(listener: (event: WriteEvent) => void): () => void
  onReviewEvent(listener: (event: ReviewEvent) => void): () => void
  onMemoryEvent(listener: (event: MemoryEvent) => void): () => void
  onRoutingEvent(listener: (event: RoutingEvent) => void): () => void
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
  /** 场景库（M1-1）：链接/解链/排序/fork/删除。 */
  linkScene(input: { chapterId: string; sceneId: string }): Promise<IpcResult<WriteActionResult>>
  unlinkScene(input: { chapterId: string; sceneId: string }): Promise<IpcResult<WriteActionResult>>
  reorderScenes(input: { chapterId: string; sceneIds: string[] }): Promise<IpcResult<WriteActionResult>>
  forkScene(input: { chapterId: string; sceneId: string }): Promise<IpcResult<WriteActionResult>>
  removeScene(input: { chapterId: string; sceneId: string }): Promise<IpcResult<WriteActionResult>>
  /** 上下文检查器（M1-17）：只读 turn_metric.context_json。 */
  context(beatId: string): Promise<IpcResult<WriteContextInspection>>
  /** 时间三轴（M1-2）：省略 = 不改，null = 清空。 */
  setSceneTime(input: {
    chapterId: string
    sceneId: string
    storyStart?: string | null
    storyEnd?: string | null
    timeline?: 'main' | 'flashback' | 'dream'
  }): Promise<IpcResult<WriteActionResult>>
  /** T23 的只读投影（M1-2）。 */
  timeline(chapterId: string): Promise<IpcResult<WriteTimeline>>
  /** 章预算编辑（PHASE-20 M2-3）：null = 恢复默认值。 */
  setBudget(input: WriteBudgetInput): Promise<IpcResult<WriteActionResult>>
  /** 仅未打包构建：E2E 脚手架，生产包调用返回 invalid_args。 */
  devSeed(input?: {
    scenes?: number
    beatsPerScene?: number
    chapters?: number
    seedEveryChapter?: boolean
    characters?: number
    volumes?: number
    chaptersPerVolume?: number
    exit?: string
  }): Promise<IpcResult<WriteState>>
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
  /** 重新打开定稿（M1-21）：旧 final 保留，新建 draft；write_epoch+1。 */
  reopen(input: { chapterId: string; reason?: string }): Promise<IpcResult<ReviewActionResult>>
  /** 异构校准（M2-8）：只读报告/patch/gate，输出代理指标与 D4 建议。 */
  calibration(): Promise<IpcResult<CalibrationReport>>
  /** 分支树（M1-21）：开新分支 / 切换；切到 final 走 reopen。 */
  createBranch(input: { chapterId: string; name: string }): Promise<IpcResult<ReviewActionResult>>
  switchBranch(input: { chapterId: string; branchId: string | null }): Promise<IpcResult<ReviewActionResult>>
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
  /** 按章重建（M1-4）：先签发 author_confirm（10 分钟），作者确认后才执行。 */
  issueRebuildToken(chapterId?: string): Promise<IpcResult<MemoryRebuildIssueResult>>
  rebuild(input: { chapterId: string; token: string }): Promise<IpcResult<MemoryActionResult>>
  /** 索引重建（M1-20）：换模型后把旧向量分批重算；author_confirm。 */
  issueIndexToken(): Promise<IpcResult<IndexRebuildIssueResult>>
  reindex(input: { token: string }): Promise<IpcResult<MemoryActionResult>>
  /** 仅未打包构建：E2E 脚手架。 */
  devSeed(input?: {
    scenes?: number
    beatsPerScene?: number
    extraChapters?: number
  }): Promise<IpcResult<MemoryState>>
  /** 工具调用审计（M1-23）：只读、分页 50；不返回 args。 */
  toolCalls(input?: ToolCallListInput): Promise<IpcResult<ToolCallListState>>
  /** 归档候选（M2-7）：只读；只含 experience，keeper/相似度/原因由主进程算好。 */
  archiveCandidates(): Promise<IpcResult<MemoryArchiveCandidatesState>>
  /** 签发 author_confirm（10 分钟）：绑定到这批 id 的哈希。 */
  issueArchiveToken(ids: string[]): Promise<IpcResult<MemoryArchiveIssueResult>>
  /** 执行归档：单事务 + 审计；失效候选进 skipped，不半写。 */
  archiveApply(input: { ids: string[]; token: string }): Promise<IpcResult<MemoryArchiveApplyResult>>
  /** 恢复归档条目：不需要令牌，但 UI 要二次确认。 */
  restoreArchive(entryId: string): Promise<IpcResult<MemoryActionResult>>
}

/** 世界状态（PHASE-13 M1-3 / M1-18）：as-of 投影 + 作者显式新增/关闭事实。 */
export interface WorldApi {
  projection(input?: WorldProjectionInput): Promise<IpcResult<WorldProjectionState>>
  addFact(input: WorldFactAddInput): Promise<IpcResult<WorldFactActionResult>>
  closeFact(input: WorldFactCloseInput): Promise<IpcResult<WorldFactActionResult>>
  /** 关系图（PHASE-14 M1-5）：只读 as-of 回放，含确定性布局坐标。 */
  relations(input?: RelationGraphInput): Promise<IpcResult<RelationGraph>>
  /** 伏笔（PHASE-15 M1-10）：作者标注 + 距离；不产生任何阻断。 */
  foreshadows(input?: ForeshadowListInput): Promise<IpcResult<ForeshadowState>>
  createForeshadow(input: ForeshadowCreateInput): Promise<IpcResult<ForeshadowMutationResult>>
  updateForeshadow(input: ForeshadowUpdateInput): Promise<IpcResult<ForeshadowMutationResult>>
  closeForeshadow(input: { foreshadowId: string; payoffChapterId: string }): Promise<IpcResult<ForeshadowMutationResult>>
  reopenForeshadow(foreshadowId: string): Promise<IpcResult<ForeshadowMutationResult>>
  removeForeshadow(foreshadowId: string): Promise<IpcResult<ForeshadowMutationResult>>
}

/** 声音指标（PHASE-19 M2-1 / M2-2）：只读；必要时主进程重算并落 voice_metric。 */
export interface VoiceApi {
  scene(input: VoiceSceneInput): Promise<IpcResult<VoiceSceneState>>
}

/** 成本/耗时报表（PHASE-20 M2-5）：只读；数字与 DB 同口径。 */
export interface ReportApi {
  cost(input?: CostReportInput): Promise<IpcResult<CostReport>>
}

/** 供应商路由（PHASE-21 M2-4）：状态栏只读快照 + 切换事件。 */
export interface RoutingApi {
  status(): Promise<IpcResult<RoutingStatus>>
}

export interface NorythBridge {
  project: ProjectApi
  dialog: DialogApi
  settings: SettingsApi
  diagnostics: DiagnosticsApi
  manuscript: ManuscriptApi
  slice: SliceApi
  plan: PlanApi
  write: WriteApi
  review: ReviewApi
  memory: MemoryApi
  world: WorldApi
  voice: VoiceApi
  report: ReportApi
  routing: RoutingApi
  app: AppApi
  events: EventApi
}
