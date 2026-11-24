import { z } from 'zod'
import { PresetSchema } from './model'

/**
 * 多供应商路由设置（PHASE-21 §5.1 / M2-4）。
 *
 * 三条边界：
 * 1. 备用供应商是作者显式配置的，不做自动降级、不做负载均衡、不按价格选家；
 * 2. 切换只发生在回合开始前，同一拍中途不换模型；
 * 3. 触发条件只认适配器归一化后的错误，`auth` / `content_filter` / `protocol`
 *    永远不切换（PHASE-21 §5.1）。
 */

/** 可触发故障切换的归一化错误类别；`server` 对应适配器的 5xx `model_error`。 */
export const ROUTING_TRIGGERS = ['rate_limit', 'server', 'timeout'] as const
export type RoutingTrigger = (typeof ROUTING_TRIGGERS)[number]
export const RoutingTriggerSchema = z.enum(ROUTING_TRIGGERS)

export const RoutingFallbackSchema = z.strictObject({
  preset: PresetSchema,
  /** 省略时取该预设在设置里的探测模型或预设默认模型。 */
  model: z.string().min(1).max(120).optional()
})
export type RoutingFallback = z.infer<typeof RoutingFallbackSchema>

export const RoutingSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** 默认限流 + 5xx；超时由作者显式勾选。 */
  fallbackOn: z.array(RoutingTriggerSchema).max(ROUTING_TRIGGERS.length).default(['rate_limit', 'server']),
  /** 一次可重试失败后的避让时长，也是熔断打开的冷却时长。 */
  cooldownMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** 逐 Agent 备用家；角色实例归一到 `character` 这一行。 */
  agents: z.record(z.string().min(1).max(80), RoutingFallbackSchema).default({})
})
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>

/** 补丁不带 default：只改开关时不能把逐 Agent 备用家清空（与 providers 补丁同一类坑）。 */
export const RoutingSettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  fallbackOn: z.array(RoutingTriggerSchema).max(ROUTING_TRIGGERS.length).optional(),
  cooldownMs: z.number().int().min(1_000).max(600_000).optional(),
  agents: z.record(z.string().min(1).max(80), RoutingFallbackSchema).optional()
})
export type RoutingSettingsPatch = z.infer<typeof RoutingSettingsPatchSchema>

/** 切换原因：主家最近失败 / 主家熔断打开 / 异构第二家不健康 / 主备都不可用。 */
export const ROUTING_REASONS = [
  'primary_unhealthy',
  'circuit_open',
  'hetero_second_unhealthy',
  'routing_exhausted'
] as const
export type RoutingReason = (typeof ROUTING_REASONS)[number]
export const RoutingReasonSchema = z.enum(ROUTING_REASONS)

/** 写进 `turn_metric.context_json.routing` 的留痕；不伪造「没有切换」。 */
export const RoutingTraceSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: RoutingReasonSchema,
  /** 触发切换的归一化错误码；没有错误（例如熔断避让）时为 null。 */
  error: z.string().nullable(),
  at: z.string()
})
export type RoutingTrace = z.infer<typeof RoutingTraceSchema>

export const RoutingHealthViewSchema = z.strictObject({
  preset: z.string(),
  failures: z.number().int().nonnegative(),
  /** 冷却结束时间（ISO）；null = 没有失败。 */
  coolingUntil: z.string().nullable(),
  /** 熔断打开到何时（ISO）；null = 未打开。 */
  openUntil: z.string().nullable(),
  lastError: z.string().nullable()
})
export type RoutingHealthView = z.infer<typeof RoutingHealthViewSchema>

/** 状态栏只读快照（当前项目 + 当前进程内存健康状态）。 */
export const RoutingStatusSchema = z.strictObject({
  enabled: z.boolean(),
  last: z
    .strictObject({
      agentKey: z.string(),
      trace: RoutingTraceSchema
    })
    .nullable(),
  health: z.array(RoutingHealthViewSchema)
})
export type RoutingStatus = z.infer<typeof RoutingStatusSchema>

/** 状态栏推送：切换发生时立即更新徽标，不弹模态。 */
export const RoutingEventSchema = z.strictObject({
  projectId: z.string(),
  agentKey: z.string(),
  trace: RoutingTraceSchema
})
export type RoutingEvent = z.infer<typeof RoutingEventSchema>
