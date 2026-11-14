import { z } from 'zod'

/**
 * Agent 输出信封（PRD §4.6 / DEV-PLAN §7.2）。
 *
 * 只有 body 进入下一轮与稿件；trace 与 grounding 只进 UI 与归档。
 * 信封由运行时装配：模型只交 `body` 与 `grounding`（见 FinalAnswerSchema），
 * trace 来自真实工具调用记录，meta 来自供应商 usage——模型无法伪造调用轨迹。
 */

export const REF_TYPES = ['memory', 'belief', 'fact', 'canon', 'outline', 'manuscript'] as const
export const RefTypeSchema = z.enum(REF_TYPES)
export type EnvelopeRefType = z.infer<typeof RefTypeSchema>

export const EnvelopeSpeakerSchema = z.strictObject({
  type: z.enum(['character', 'narrator']),
  id: z.string().min(1)
})
export type EnvelopeSpeaker = z.infer<typeof EnvelopeSpeakerSchema>

export const ThoughtTraceSchema = z.strictObject({
  type: z.literal('thought'),
  text: z.string().max(2000)
})

export const ToolCallTraceSchema = z.strictObject({
  type: z.literal('tool_call'),
  call_id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  runtime_args: z.record(z.string(), z.unknown()).default({}),
  result_ids: z.array(z.string()).default([]),
  degraded: z.string().optional(),
  latency_ms: z.number().optional()
})

export const EnvelopeTraceItemSchema = z.discriminatedUnion('type', [
  ThoughtTraceSchema,
  ToolCallTraceSchema
])
export type EnvelopeTraceItem = z.infer<typeof EnvelopeTraceItemSchema>

export const GroundingItemSchema = z.strictObject({
  type: RefTypeSchema,
  id: z.string().min(1),
  quote: z.string().min(1)
})
export type GroundingItem = z.infer<typeof GroundingItemSchema>

export const EnvelopeMetaSchema = z.strictObject({
  model: z.string(),
  degraded: z.boolean(),
  tokens_in: z.number().int().nonnegative().nullable(),
  tokens_out: z.number().int().nonnegative().nullable()
})
export type EnvelopeMeta = z.infer<typeof EnvelopeMetaSchema>

export const EnvelopeSchema = z.strictObject({
  turn_id: z.string().min(1),
  speaker: EnvelopeSpeakerSchema,
  trace: z.array(EnvelopeTraceItemSchema).max(40).default([]),
  body: z.string().min(1),
  grounding: z.array(GroundingItemSchema).max(8).default([]),
  meta: EnvelopeMetaSchema
})
export type Envelope = z.infer<typeof EnvelopeSchema>

/**
 * 模型最终答复：只交正文与自报依据。
 * `meta` 允许模型报告 degraded，但运行时会用真实降级源覆盖为 true（DEV-PLAN §7.2）。
 */
export const FinalAnswerSchema = z.strictObject({
  body: z.string().min(1),
  grounding: z.array(GroundingItemSchema).max(8).default([]),
  meta: EnvelopeMetaSchema.partial().optional()
})
export type FinalAnswer = z.infer<typeof FinalAnswerSchema>

/** JSON 回退协议（DEV-PLAN §7.6）：一次只允许一轮工具；final 为最终答复或完整信封。 */
export const FallbackToolCallSchema = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
})

export const FallbackResponseSchema = z.strictObject({
  tool_calls: z.array(FallbackToolCallSchema).max(8).default([]),
  final: z.union([FinalAnswerSchema, EnvelopeSchema]).nullable().default(null)
})
export type FallbackResponse = z.infer<typeof FallbackResponseSchema>
export type FallbackToolCall = z.infer<typeof FallbackToolCallSchema>
