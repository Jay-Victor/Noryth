import { z } from 'zod'
import { CapabilitiesSchema, PresetSchema, ProviderModelSchema } from './model'
import { RoutingSettingsSchema } from './routing'

/**
 * 设置中心契约（PHASE-10 I1–I4 / UI-DESIGN §8 / PRD §5.6）。
 *
 * 三条不能破的规则在这里落地：
 * 1. Key 只在主进程，renderer 永远只拿到 `configured` + 末 4 位；
 * 2. 绑定是「下一拍生效」的配置，设置视图必须给出继承来源；
 * 3. 外观是 token 级偏好，只改 CSS 变量，不改导出与正文。
 */

/** 六个 Agent 的中文名；键与 `model_binding.agent_key` 一致（DEV-PLAN §18.3）。 */
export const AGENT_LABELS = {
  planner: '规划',
  orchestrator: '编排',
  character: '角色',
  narrator: '旁白',
  reviewer: '审批',
  memory: '记忆'
} as const
export type AgentKey = keyof typeof AGENT_LABELS
export const AGENT_KEYS = Object.keys(AGENT_LABELS) as AgentKey[]

export const ACCENT_KEYS = ['clay', 'ink', 'moss', 'plum', 'slate'] as const
export type AccentKey = (typeof ACCENT_KEYS)[number]

export const AppearanceSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']).default('light'),
  accent: z.enum(ACCENT_KEYS).default('clay'),
  /** 正文字号三档（UI-DESIGN §8.3）；只影响阅读与编辑，不影响导出。 */
  fontScale: z.enum(['small', 'standard', 'large']).default('standard'),
  lineHeight: z.union([z.literal(1.6), z.literal(1.8), z.literal(2.0)]).default(1.8)
})
export type Appearance = z.infer<typeof AppearanceSchema>
/** 外观补丁同样不能带 default：否则改主题会把强调色打回默认（与 settings 补丁同一类坑）。 */
export const AppearancePatchSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accent: z.enum(ACCENT_KEYS).optional(),
  fontScale: z.enum(['small', 'standard', 'large']).optional(),
  lineHeight: z.union([z.literal(1.6), z.literal(1.8), z.literal(2.0)]).optional()
})
export type AppearancePatch = z.infer<typeof AppearancePatchSchema>

/** 审批设置（PHASE-16 §5.3）：M1 只有异构复检开关，默认关闭。 */
export const REVIEW_HETERO_MODES = ['off', 'prefer'] as const
export type ReviewHeteroMode = (typeof REVIEW_HETERO_MODES)[number]
export const ReviewSettingsSchema = z.strictObject({
  hetero: z.enum(REVIEW_HETERO_MODES).default('off')
})
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>
/** 补丁同样不带 default：只改 hetero 时不能把其它审批设置重置。 */
export const ReviewSettingsPatchSchema = z.strictObject({
  hetero: z.enum(REVIEW_HETERO_MODES).optional()
})
export type ReviewSettingsPatch = z.infer<typeof ReviewSettingsPatchSchema>

/** Key 状态：不返回明文，只返回是否配置与末 4 位。 */
export const ProviderKeyStatusSchema = z.strictObject({
  preset: PresetSchema,
  configured: z.boolean(),
  last4: z.string().nullable(),
  updatedAt: z.string().nullable()
})
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatusSchema>

export const ProviderKeySetInputSchema = z.strictObject({
  preset: PresetSchema,
  apiKey: z.string().min(8).max(400)
})
export type ProviderKeySetInput = z.infer<typeof ProviderKeySetInputSchema>

export const ProviderClearInputSchema = z.strictObject({ preset: PresetSchema })
export type ProviderClearInput = z.infer<typeof ProviderClearInputSchema>

export const ProviderModelViewSchema = z.strictObject({
  id: z.string(),
  capabilities: CapabilitiesSchema,
  /** 预设表里没有价格时为 false，UI 显示「未知」而不是 0。 */
  pricingKnown: z.boolean()
})
export type ProviderModelView = z.infer<typeof ProviderModelViewSchema>

export const ProviderCardSchema = z.strictObject({
  preset: PresetSchema,
  label: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  key: ProviderKeyStatusSchema,
  /** 最近一次测试连接的结果（settings.providers 快照）。 */
  connected: z.boolean(),
  checkedAt: z.string().nullable(),
  capabilities: CapabilitiesSchema.nullable(),
  models: z.array(ProviderModelViewSchema)
})
export type ProviderCard = z.infer<typeof ProviderCardSchema>

export const SettingsViewSchema = z.strictObject({
  appearance: AppearanceSchema,
  providers: z.array(ProviderCardSchema),
  /** safeStorage 不可用时 Key 只在本次运行有效；UI 必须提示。 */
  secureStorage: z.boolean(),
  settingsPath: z.string(),
  secretsPath: z.string(),
  lastOpenedProjectId: z.string().nullable(),
  /** 启动自动打开上次项目（PHASE-11 M1-24）。 */
  openLastProject: z.boolean(),
  /** 审批（PHASE-16 M1-22）：异构复检默认关闭。 */
  review: ReviewSettingsSchema,
  /** 多供应商路由（PHASE-21 M2-4）：默认关闭；备用家是显式配置。 */
  routing: RoutingSettingsSchema
})
export type SettingsView = z.infer<typeof SettingsViewSchema>

export const ProviderTestInputSchema = z.strictObject({
  preset: PresetSchema,
  model: z.string().min(1).max(120).optional(),
  /** 只在本次测试使用；不传则用 safeStorage 里的 Key。 */
  apiKey: z.string().min(1).max(400).optional(),
  baseUrl: z.string().url().max(300).optional()
})
export type ProviderTestInput = z.infer<typeof ProviderTestInputSchema>

export const ProviderTestResultSchema = z.strictObject({
  preset: PresetSchema,
  ok: z.boolean(),
  /** 首个可用模型：探测成功时取请求里的 model，失败为空。 */
  model: z.string().nullable(),
  baseUrl: z.string(),
  latencyMs: z.number().int().nonnegative(),
  capabilities: CapabilitiesSchema.nullable(),
  checkedAt: z.string(),
  error: z
    .strictObject({ code: z.string(), message: z.string(), advice: z.string().nullable() })
    .nullable()
})
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>

export const BindingSourceSchema = z.enum(['instance', 'agent', 'project', 'preset'])
export type BindingSourceKey = z.infer<typeof BindingSourceSchema>

export const BindingRowSchema = z.strictObject({
  agentKey: z.string(),
  label: z.string(),
  kind: z.enum(['project', 'agent', 'character']),
  provider: PresetSchema,
  model: z.string(),
  source: BindingSourceSchema,
  version: z.number().int().nonnegative(),
  temperature: z.number().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  recentlyUsedAt: z.string().nullable(),
  /** 该模型最近一次测试连接是否通过；未测试为 null。 */
  tested: z.boolean().nullable()
})
export type BindingRow = z.infer<typeof BindingRowSchema>

export const CharacterBindingRowSchema = z.strictObject({
  characterId: z.string(),
  name: z.string(),
  /** 显式的实例绑定；null 表示继承角色行。 */
  override: BindingRowSchema.nullable(),
  /** 实际生效的绑定（含继承来源）。 */
  effective: BindingRowSchema
})
export type CharacterBindingRow = z.infer<typeof CharacterBindingRowSchema>

export const BindingMatrixSchema = z.strictObject({
  projectId: z.string(),
  defaultPreset: PresetSchema,
  providers: z.array(
    z.strictObject({
      preset: PresetSchema,
      label: z.string(),
      enabled: z.boolean(),
      keyConfigured: z.boolean(),
      connected: z.boolean(),
      /** 可选模型清单：绑定表的下拉只在这里取值，避免出现空模型。 */
      models: z.array(z.string())
    })
  ),
  /** 项目默认 + 六个 Agent（不含角色实例）。 */
  rows: z.array(BindingRowSchema),
  characters: z.array(CharacterBindingRowSchema),
  canRollback: z.boolean(),
  auditCount: z.number().int().nonnegative()
})
export type BindingMatrix = z.infer<typeof BindingMatrixSchema>

export const BindingChangeSchema = z.strictObject({
  agentKey: z.string().min(1).max(80),
  provider: PresetSchema,
  model: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(16).max(200_000).nullable().optional()
})
export type BindingChange = z.infer<typeof BindingChangeSchema>

export const BindingSetInputSchema = z.strictObject({
  projectId: z.string().min(1),
  changes: z.array(BindingChangeSchema).min(1).max(40)
})
export type BindingSetInput = z.infer<typeof BindingSetInputSchema>

export const BindingProjectInputSchema = z.strictObject({ projectId: z.string().min(1) })
export type BindingProjectInput = z.infer<typeof BindingProjectInputSchema>

export const BindingAuditEntrySchema = z.strictObject({
  id: z.string(),
  agentKey: z.string(),
  batchId: z.string().nullable(),
  oldProvider: z.string().nullable(),
  oldModel: z.string().nullable(),
  newProvider: z.string(),
  newModel: z.string(),
  actor: z.string(),
  createdAt: z.string()
})
export type BindingAuditEntry = z.infer<typeof BindingAuditEntrySchema>

export function isAgentKey(value: string): value is AgentKey {
  return Object.prototype.hasOwnProperty.call(AGENT_LABELS, value)
}

/** `character:<id>` 视为角色实例键；其余必须是六个 Agent 或 project。 */
export function agentLabelFor(agentKey: string): string {
  if (agentKey === 'project') return '项目默认'
  if (agentKey.startsWith('character:')) return '角色实例'
  return isAgentKey(agentKey) ? AGENT_LABELS[agentKey] : agentKey
}

export const PRESET_LABELS: Record<z.infer<typeof PresetSchema>, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  tongyi: '通义千问'
}

export { ProviderModelSchema }
