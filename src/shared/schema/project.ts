import { z } from 'zod'

export const PovSchema = z.enum(['first', 'third_limited', 'third_omniscient'])
export type Pov = z.infer<typeof PovSchema>

export const SetupStateSchema = z.enum(['pending', 'complete', 'failed'])
export type SetupState = z.infer<typeof SetupStateSchema>

export const PresetSchema = z.enum(['openai', 'deepseek', 'tongyi'])
export type Preset = z.infer<typeof PresetSchema>

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
  readOnly: z.boolean().optional()
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
  lastOpenedProjectId: z.string().nullable().default(null)
})
export type Settings = z.infer<typeof SettingsSchema>

export const SettingsPatchSchema = SettingsSchema.partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const AppInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  packaged: z.boolean()
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
