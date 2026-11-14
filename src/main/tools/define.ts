import { z } from 'zod'
import type { AgentKey, DegradeLevel, Milestone, SideEffect, ToolContext, ToolFamily, ToolGateId, ToolPayload, ToolServices } from './types'
import { AGENT_KEYS, RESERVED_ARG_KEYS, RUNTIME_ONLY_ARG_KEYS } from './types'

/**
 * 工具清单（manifest）的唯一真源：TS 定义 → docs/tools/*.json + generated/*。
 * 内部字段 camelCase；生成物按 PRD §4.9.2 的 snake_case 输出，映射只在本文件。
 */

export interface ToolLimits {
  timeoutMs: number
  maxResultTokens: number
  maxCallsPerTurn: number
}

export interface ToolAudit {
  logArgs: 'full' | 'hash' | 'none'
  logResultIds: boolean
}

export interface ToolDefinitionInput<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  O extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>
> {
  toolId: string
  name: string
  version: string
  family: ToolFamily
  summary: string
  actors: AgentKey[]
  sideEffect: SideEffect
  agentCallable: boolean
  requiresGate: ToolGateId | null
  idempotency: 'natural' | 'key_required'
  /** 额外注入的身份/作用域参数；project_id 等通用项由运行时对每个工具注入。 */
  injected?: string[]
  input: S
  output: O
  limits: ToolLimits
  degrade: DegradeLevel[]
  audit: ToolAudit
  milestone: Milestone
  /** 解析期实例收窄：角色实例只允许操作自己（裁掉 character_id 参数）。 */
  selfOnly?: boolean
  /** 系统能力：注册但永不下发给 Agent。 */
  system?: boolean
  enabled?: boolean
  handler: (
    args: z.infer<S>,
    ctx: ToolContext,
    services: ToolServices
  ) => ToolPayload<z.infer<O>> | Promise<ToolPayload<z.infer<O>>>
}

export interface ToolDefinition<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  O extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>
> extends ToolDefinitionInput<S, O> {
  injected: string[]
  enabled: boolean
  system: boolean
  selfOnly: boolean
  /** A1–A5 的问题清单；非空时 registry 剔除、codegen 失败。 */
  validationErrors: readonly string[]
}

export type AnyToolDefinition = ToolDefinition<z.ZodObject<z.ZodRawShape>, z.ZodObject<z.ZodRawShape>>

const NAME_PATTERN = /^[a-z][a-z_]*(?:\.[a-z][a-z_]+)+$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const TOOL_ID_PATTERN = /^[TS]\d{2}$/

/** zod 4 的 strict 判定：object 且 catchall 为 never。 */
function isStrictObject(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _zod?: { def?: { type?: string; catchall?: { _zod?: { def?: { type?: string } } } } } })
    ._zod?.def
  return def?.type === 'object' && def.catchall?._zod?.def?.type === 'never'
}

/**
 * 构建期五条断言（DEV-PLAN §6.2 A1–A5）。违反即抛错：
 * 阶段 03 由 registry 在加载时调用；codegen 加载 manifest 时同样会触发。
 */
export function assertToolDefinition(tool: ToolDefinitionInput): string[] {
  const errors: string[] = []
  const injected = tool.injected ?? []

  if (!TOOL_ID_PATTERN.test(tool.toolId)) errors.push(`toolId ${tool.toolId} 不合规`)
  if (!NAME_PATTERN.test(tool.name)) errors.push(`name ${tool.name} 不合规`)
  if (!VERSION_PATTERN.test(tool.version)) errors.push(`version ${tool.version} 不是 semver`)
  if (tool.summary.length < 8 || tool.summary.length > 120) {
    errors.push(`summary 长度 ${tool.summary.length} 超出 8–120`)
  }

  // A1：commit → !agent_callable
  if (tool.sideEffect === 'commit' && tool.agentCallable) errors.push('A1: commit 工具不得 agent_callable')

  // A2：injected 与 input 键不重叠；injected 只能是保留键；
  // 身份类参数（项目/调用者/任务/回合/epoch/令牌/模式）永远不得出现在 input。
  const inputKeys = new Set(Object.keys(tool.input.shape))
  for (const key of injected) {
    if (!(RESERVED_ARG_KEYS as readonly string[]).includes(key)) {
      errors.push(`A2: injected 含未知参数 ${key}`)
    }
    if (inputKeys.has(key)) errors.push(`A2: injected 与 input 重叠 ${key}`)
  }
  for (const reserved of RUNTIME_ONLY_ARG_KEYS) {
    if (!tool.system && inputKeys.has(reserved)) errors.push(`A2: input 含身份参数 ${reserved}`)
  }

  // A3：input / output 都是 strict object（additionalProperties:false）
  if (!isStrictObject(tool.input)) errors.push('A3: input 必须是 strictObject')
  if (!isStrictObject(tool.output)) errors.push('A3: output 必须是 strictObject')

  // A5：actors 非空且 ⊆ 六角色；有闸门就不是只读
  if (tool.system) {
    if (tool.agentCallable) errors.push('A5: 系统能力不得 agent_callable')
    if (tool.actors.length > 0) errors.push('A5: 系统能力不得有 actors')
  } else {
    if (!tool.agentCallable) errors.push('A5: 42 个 Agent 工具必须 agent_callable')
    if (tool.actors.length === 0) errors.push('A5: Agent 工具 actors 不能为空')
    for (const actor of tool.actors) {
      if (!AGENT_KEYS.includes(actor)) errors.push(`A5: 未知 agent ${actor}`)
    }
  }
  if (tool.requiresGate !== null && tool.sideEffect === 'none') {
    errors.push('A5: 有闸门的工具不能是只读')
  }
  if (tool.requiresGate !== null && tool.idempotency !== 'key_required') {
    errors.push('A5: 有闸门的工具必须 key_required')
  }
  if (tool.sideEffect !== 'none' && tool.idempotency !== 'key_required') {
    errors.push('A5: 提案/执行工具必须 key_required')
  }
  if (!tool.system && tool.sideEffect === 'execute' && tool.requiresGate === null) {
    errors.push('A5: 执行工具必须有闸门')
  }
  if (!tool.degrade.includes('full')) errors.push('degrade 必须包含 full')

  return errors
}

export function defineTool<
  S extends z.ZodObject<z.ZodRawShape>,
  O extends z.ZodObject<z.ZodRawShape>
>(input: ToolDefinitionInput<S, O>): ToolDefinition<S, O> {
  const errors = assertToolDefinition(input)
  return {
    ...input,
    injected: input.injected ?? [],
    enabled: input.enabled ?? input.milestone === 'M0',
    system: input.system ?? false,
    selfOnly: input.selfOnly ?? false,
    validationErrors: errors
  }
}

/** JSON Schema 只做序列化与下发，字段由 zod 生成；这里不重复建模。 */
export type ToolJsonSchema = Record<string, unknown>

export function inputJsonSchema(tool: ToolDefinition): ToolJsonSchema {
  return z.toJSONSchema(tool.input) as ToolJsonSchema
}

export function outputJsonSchema(tool: ToolDefinition): ToolJsonSchema {
  return z.toJSONSchema(tool.output) as ToolJsonSchema
}

/** 生成物字段名（PRD §4.9.2 snake_case）。 */
export interface ToolManifestJson {
  name: string
  version: string
  family: ToolFamily
  summary: string
  actors: AgentKey[]
  side_effect: SideEffect
  agent_callable: boolean
  requires_gate: ToolGateId | null
  idempotency: 'natural' | 'key_required'
  injected: string[]
  limits: { timeout_ms: number; max_result_tokens: number; max_calls_per_turn: number }
  degrade: DegradeLevel[]
  audit: { log_args: 'full' | 'hash' | 'none'; log_result_ids: boolean }
  input_schema: ToolJsonSchema
  output_schema: ToolJsonSchema
  contract_complete: boolean
  milestone: Milestone
  m0: boolean
  tool_id: string
  system?: boolean
}

export function toManifestJson(tool: ToolDefinition): ToolManifestJson {
  if (tool.validationErrors.length > 0) {
    throw new Error(`工具 ${tool.name} 契约不合法：${tool.validationErrors.join(' | ')}`)
  }
  return {
    name: tool.name,
    version: tool.version,
    family: tool.family,
    summary: tool.summary,
    actors: [...tool.actors],
    side_effect: tool.sideEffect,
    agent_callable: tool.agentCallable,
    requires_gate: tool.requiresGate,
    idempotency: tool.idempotency,
    injected: [...tool.injected],
    limits: {
      timeout_ms: tool.limits.timeoutMs,
      max_result_tokens: tool.limits.maxResultTokens,
      max_calls_per_turn: tool.limits.maxCallsPerTurn
    },
    degrade: [...tool.degrade],
    audit: { log_args: tool.audit.logArgs, log_result_ids: tool.audit.logResultIds },
    input_schema: inputJsonSchema(tool),
    output_schema: outputJsonSchema(tool),
    contract_complete: true,
    milestone: tool.milestone,
    m0: tool.milestone === 'M0',
    tool_id: tool.toolId,
    ...(tool.system ? { system: true } : {})
  }
}

/** 下发给模型的工具描述（OpenAI-compatible tools 数组元素）。 */
export interface ModelToolDescriptor {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolJsonSchema
  }
}

export function toModelTool(tool: ToolDefinition): ModelToolDescriptor {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.summary,
      parameters: inputJsonSchema(tool)
    }
  }
}
