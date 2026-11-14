import { z } from 'zod'
import { ErrorCodeSchema } from './ipc'

/**
 * 供应商预设与能力探测（PRD §9.3 / DEV-PLAN §7.5 / PHASE-04 D2）。
 *
 * 预设只描述「base URL + 模型清单 + 能力默认值」；API Key 不进入本文件、
 * 不进入项目目录，也不落 settings.json（阶段 10 的 safeStorage 负责保管）。
 */

/** PRD 允许的三家预设；第二家按 ADR-0003 顺延到 D1 前补测。 */
export const PresetSchema = z.enum(['openai', 'deepseek', 'tongyi'])
export type Preset = z.infer<typeof PresetSchema>

export const CapabilitiesSchema = z.strictObject({
  stream: z.boolean(),
  tools: z.boolean(),
  jsonMode: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  /** 人民币 / 百万 token；只用于估算，计费以供应商 usage 为准。 */
  pricing: z.strictObject({
    in: z.number().nonnegative(),
    out: z.number().nonnegative()
  })
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export const ProviderModelSchema = z.strictObject({
  id: z.string().min(1).max(120),
  capabilities: CapabilitiesSchema
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>

export const ProviderPresetSchema = z.strictObject({
  preset: PresetSchema,
  label: z.string().min(1).max(40),
  baseUrl: z.string().min(1).max(300),
  models: z.array(ProviderModelSchema).min(1)
})
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>

export const ProviderProbeInputSchema = z.strictObject({
  preset: PresetSchema,
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().max(300).optional(),
  /** 只在本次探测中使用，不写盘、不写日志。 */
  apiKey: z.string().min(1).max(400).optional()
})
export type ProviderProbeInput = z.infer<typeof ProviderProbeInputSchema>

export const ProviderProbeErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string()
})

export const ProviderProbeResultSchema = z.strictObject({
  preset: PresetSchema,
  model: z.string(),
  baseUrl: z.string(),
  ok: z.boolean(),
  capabilities: CapabilitiesSchema.nullable(),
  latencyMs: z.number().int().nonnegative(),
  checkedAt: z.string(),
  error: ProviderProbeErrorSchema.nullable()
})
export type ProviderProbeResult = z.infer<typeof ProviderProbeResultSchema>

/** settings.json 里按预设保存的探测快照；Key 永远不在其中。 */
export const ProviderSettingsSchema = z.strictObject({
  baseUrl: z.string().max(300).nullable().default(null),
  model: z.string().max(120).nullable().default(null),
  capabilities: CapabilitiesSchema.nullable().default(null),
  checkedAt: z.string().nullable().default(null)
})
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>
