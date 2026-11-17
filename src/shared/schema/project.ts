import { z } from 'zod'
import { ProviderSettingsSchema, PresetSchema } from './model'
import { UpdateStateSchema } from './update'
import {
  AppearanceSchema,
  AppearancePatchSchema,
  ReviewSettingsSchema,
  ReviewSettingsPatchSchema
} from './settings'

export { PresetSchema }
export type { Preset } from './model'

export const PovSchema = z.enum(['first', 'third_limited', 'third_omniscient'])
export type Pov = z.infer<typeof PovSchema>

export const SetupStateSchema = z.enum(['pending', 'complete', 'failed'])
export type SetupState = z.infer<typeof SetupStateSchema>

/** 项目列表项：首页只需要摘要，不暴露 Key、费用明细（PRD §4.10 T01）。 */
export const ProjectSummarySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  path: z.string(),
  genre: z.string(),
  pov: PovSchema,
  targetWords: z.number().int().positive().nullable(),
  setupState: SetupStateSchema,
  schemaVersion: z.number().int().nonnegative(),
  chapterCount: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string().nullable(),
  available: z.boolean()
})
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export const ValidatePathInputSchema = z.strictObject({
  parentDir: z.string().min(1),
  folderName: z.string().min(1).max(80)
})
export type ValidatePathInput = z.infer<typeof ValidatePathInputSchema>

export const PathCheckSchema = z.strictObject({
  ok: z.boolean(),
  targetPath: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  freeBytes: z.number().nonnegative()
})
export type PathCheck = z.infer<typeof PathCheckSchema>

export const CreateProjectInputSchema = z.strictObject({
  parentDir: z.string().min(1),
  folderName: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  genre: z.string().max(60),
  targetWords: z.number().int().min(10_000).max(10_000_000).nullable(),
  pov: PovSchema,
  boundaries: z.string().max(2000)
})
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>

export const CreateProjectResultSchema = z.strictObject({
  projectId: z.string(),
  path: z.string(),
  title: z.string(),
  schemaVersion: z.number().int().nonnegative()
})
export type CreateProjectResult = z.infer<typeof CreateProjectResultSchema>

export const OpenProjectInputSchema = z.strictObject({
  path: z.string().min(1),
  /** 强制只读打开（列表里「以只读打开」）；锁仍会被当前窗口持有为只读。 */
  readOnly: z.boolean().optional(),
  /**
   * 切换项目：先取消并等待在跑的任务（作者已确认），再关旧库开新库。
   * 不带这个字段时，main 侧遇到运行中的任务直接返回 `project_busy`，不静默丢稿。
   */
  cancelRunning: z.boolean().optional()
})
export type OpenProjectInput = z.infer<typeof OpenProjectInputSchema>

export const OpenProjectResultSchema = z.strictObject({
  project: ProjectSummarySchema,
  readOnly: z.boolean(),
  readOnlyReason: z.enum(['locked', 'schema_newer', 'requested']).nullable(),
  lockHolder: z
    .strictObject({
      pid: z.number().int(),
      host: z.string(),
      appVersion: z.string(),
      heartbeatAt: z.string()
    })
    .nullable()
})
export type OpenProjectResult = z.infer<typeof OpenProjectResultSchema>

/**
 * 启动自动打开上次项目（PHASE-11 M1-24）。
 *
 * 失败一律「回首页 + 可读提示」，不是错误：renderer 不把它当异常处理，
 * 也绝不因为上次项目被占用就自动只读打开（会把锁问题放大成双窗口）。
 */
export const AUTO_OPEN_REASONS = [
  'disabled',
  'no_last_project',
  'missing',
  'locked',
  'schema_newer',
  'failed',
  'ok'
] as const
export const AutoOpenReasonSchema = z.enum(AUTO_OPEN_REASONS)
export type AutoOpenReason = z.infer<typeof AutoOpenReasonSchema>

export const AutoOpenResultSchema = z.strictObject({
  opened: OpenProjectResultSchema.nullable(),
  reason: AutoOpenReasonSchema,
  elapsedMs: z.number().int().nonnegative()
})
export type AutoOpenResult = z.infer<typeof AutoOpenResultSchema>

/** 切换项目前的运行态探测：有任务就不静默切库（PHASE-11 §5.1）。 */
export const ProjectBusyStateSchema = z.strictObject({
  projectId: z.string().nullable(),
  /** write=生成/自动模式在跑；plan=规划会话在等模型或工具。 */
  domains: z.array(z.enum(['write', 'plan'])),
  busy: z.boolean()
})
export type ProjectBusyState = z.infer<typeof ProjectBusyStateSchema>

/**
 * 文件树抽屉的数据源（PHASE-11 M1-16 / UI-DESIGN §2.6）。
 *
 * 抽屉是「临时选择器」：节点只描述「点它会去哪」，不携带正文。
 * 结构与数据库视图混在同一棵树里，和 W1 常驻树同源。
 */
export const ProjectTreeNodeSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  kind: z.enum(['group', 'file']),
  depth: z.number().int().min(0).max(2),
  /** 选中后跳转的页面；group 为 null。 */
  page: z.enum(['plan', 'write', 'review', 'memory']).nullable(),
  chapterId: z.string().nullable(),
  /** 状态徽标文案（章状态 / 计数），没有就 null。 */
  status: z.string().nullable()
})
export type ProjectTreeNode = z.infer<typeof ProjectTreeNodeSchema>

export const ProjectTreeSchema = z.strictObject({
  projectId: z.string(),
  projectTitle: z.string(),
  nodes: z.array(ProjectTreeNodeSchema)
})
export type ProjectTree = z.infer<typeof ProjectTreeSchema>

export const UpdateProjectMetaInputSchema = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  genre: z.string().max(60).optional(),
  targetWords: z.number().int().min(10_000).max(10_000_000).nullable().optional()
})
export type UpdateProjectMetaInput = z.infer<typeof UpdateProjectMetaInputSchema>

export const RelocateProjectInputSchema = z.strictObject({
  projectId: z.string().min(1),
  path: z.string().min(1)
})
export type RelocateProjectInput = z.infer<typeof RelocateProjectInputSchema>

export const ProjectIdInputSchema = z.strictObject({ projectId: z.string().min(1) })
export type ProjectIdInput = z.infer<typeof ProjectIdInputSchema>

export const SettingsSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  lastOpenedProjectId: z.string().nullable().default(null),
  /** 启动自动打开上次项目（PHASE-11 M1-24）；关掉后启动停在首页。 */
  openLastProject: z.boolean().default(true),
  /** 能力探测快照（PHASE-04 D2）：按预设保存，Key 不在其中。 */
  providers: z.record(z.string(), ProviderSettingsSchema).default({}),
  /** token 估算校准系数（DEV-PLAN §7.4）：按 provider 取中位数，clamp [0.7, 1.6]。 */
  tokenCalibration: z.record(z.string(), z.number()).default({}),
  /** 提供方启用开关（PHASE-10 I1）；缺省视为启用。 */
  providersEnabled: z.record(z.string(), z.boolean()).default({}),
  /** 外观与基础偏好（PHASE-10 I4）：只改 CSS 变量，不改导出。 */
  appearance: AppearanceSchema.default(AppearanceSchema.parse({})),
  /** 审批（PHASE-16 M1-22）：异构复检默认关闭。 */
  review: ReviewSettingsSchema.default(ReviewSettingsSchema.parse({}))
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * 补丁 schema 必须显式写、且**不带 default**。
 *
 * `SettingsSchema.partial()` 仍会对缺省键套用 default：一次 `{lastOpenedProjectId}`
 * 的写入会顺手把 `providers` 覆盖成 `{}`，把探测快照与绑定可用性全部清空。
 * 这个坑在实际流程里很难复现（要先探测、再打开别的项目），所以锁在这里并加回归测试。
 */
export const SettingsPatchSchema = z
  .strictObject({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    lastOpenedProjectId: z.string().nullable().optional(),
    openLastProject: z.boolean().optional(),
    providers: z.record(z.string(), ProviderSettingsSchema).optional(),
    tokenCalibration: z.record(z.string(), z.number()).optional(),
    providersEnabled: z.record(z.string(), z.boolean()).optional(),
    appearance: AppearancePatchSchema.optional(),
    review: ReviewSettingsPatchSchema.optional()
  })
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** 只读 DB 校验（PHASE-18 M1-15）：E2E 每 5 章跑一次；dev 构建才注册通道。 */
export const ProjectVerifyIssueSchema = z.strictObject({
  code: z.string(),
  severity: z.enum(['error', 'warn']),
  message: z.string()
})
export const ProjectVerifyResultSchema = z.strictObject({
  ok: z.boolean(),
  checkedAt: z.string(),
  issues: z.array(ProjectVerifyIssueSchema),
  stats: z.record(z.string(), z.number())
})
export type ProjectVerifyResult = z.infer<typeof ProjectVerifyResultSchema>

export const AppInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  packaged: z.boolean(),
  /** 更新通道与最近一次检查结果（PHASE-18 M1-7）。 */
  update: UpdateStateSchema
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export const ProjectStateEventSchema = z.strictObject({
  projectId: z.string(),
  readOnly: z.boolean(),
  setupState: SetupStateSchema,
  schemaVersion: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  jobId: z.string()
})
export type ProjectStateEvent = z.infer<typeof ProjectStateEventSchema>
