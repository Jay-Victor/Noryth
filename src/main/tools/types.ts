import type { Repos } from '../db/repos'
import type { ErrorCode } from '../../shared/domain/errors'

/** 六个 Agent；没有第七个（AGENTS.md 铁律）。 */
export const AGENT_KEYS = ['planner', 'orchestrator', 'character', 'narrator', 'reviewer', 'memory'] as const
export type AgentKey = (typeof AGENT_KEYS)[number]

/** 角色实例键：`character:<character_id>`；解析期收窄身份与参数。 */
export type AgentInstanceKey = AgentKey | `character:${string}`

export type ToolFamily = 'structure' | 'knowledge' | 'verify' | 'propose' | 'interaction'
export type SideEffect = 'none' | 'propose' | 'execute' | 'commit'
export type ToolGateId = 'G1' | 'G5' | 'G6' | 'G7' | 'author_confirm'
export type Milestone = 'M0' | 'P1' | 'M1' | 'M2'
export type DegradeLevel = 'full' | 'none' | 'summary' | 'facts_only' | 'empty' | 'schema_fallback' | 'fail'

/**
 * 身份与作用域参数：模型不可见、不可覆盖（PRD §4.9.1 I3）。
 * 其中 project_id / actor_id / job_id / turn_id / epoch 由运行时对每个工具注入；
 * 其余按 manifest 的 `injected` 声明。任何一项都不得出现在 input_schema。
 */
export const RESERVED_ARG_KEYS = [
  'project_id',
  'actor_id',
  'character_id',
  'as_of',
  'job_id',
  'turn_id',
  'epoch',
  'expected_revision',
  'gate_token',
  'chapter_id',
  'beat_id',
  'mode'
] as const
export type ReservedArgKey = (typeof RESERVED_ARG_KEYS)[number]

/** 身份类参数：既是保留键，也永远不得出现在 input_schema。 */
export const RUNTIME_ONLY_ARG_KEYS = [
  'project_id',
  'actor_id',
  'job_id',
  'turn_id',
  'epoch',
  'gate_token',
  'mode'
] as const

/** 运行时注入的完整参数集（handler 内部可用，模型看不到）。 */
export interface ToolRuntime {
  project_id: string
  actor_id: string
  character_id: string | null
  as_of: number
  job_id: string
  turn_id: string
  epoch: number
  expected_revision: string | null
  gate_token: string | null
  chapter_id: string | null
  beat_id: string | null
  mode: 'interactive' | 'auto' | 'batch'
}

export type RefType = 'memory' | 'belief' | 'fact' | 'canon' | 'outline' | 'manuscript'

/** 可回放的依据引用：grounding 只能是本轮 refs 的子集（PRD §4.9.4）。 */
export interface ToolRef {
  type: RefType
  id: string
  quote: string
  seq?: number
}

/** handler 的返回：数据 + 引用 + 降级标记；截断由流水线统一处理。 */
export interface ToolPayload<D = unknown> {
  data: D
  refs?: ToolRef[]
  degraded?: DegradeLevel
  filteredCount?: number
  total?: number
  truncated?: boolean
}

export interface ToolErrorBody {
  code: ErrorCode
  fields?: string[]
}

/** 统一返回信封（PRD §4.9.4）。 */
export interface ToolResult<D = unknown> {
  call_id: string
  ok: boolean
  data?: D
  refs: ToolRef[]
  truncated: boolean
  total?: number
  filtered_count?: number
  degraded: DegradeLevel
  duplicate?: boolean
  error?: ToolErrorBody
  latency_ms: number
}

export interface ChoiceOption {
  id: string
  label: string
}

export interface ChoiceResolver {
  ask(question: string, options: readonly ChoiceOption[]): Promise<ChoiceOption | null>
}

/** 校验通过的闸门令牌负载（gates.ts 解码后传入 handler）。 */
export interface VerifiedGate {
  g: ToolGateId
  et: string
  eid: string
  rev: string | null
  job: string
  exp: number
  nonce: string
}

export interface ToolContext {
  runtime: ToolRuntime
  /** 本拍上下文：来自 job payload，不是模型参数。 */
  chapterId: string | null
  beatId: string | null
  mode: 'interactive' | 'auto' | 'batch'
  gate: VerifiedGate | null
  /** 超时前上报部分结果；流水线据此返回 degraded:'summary'。 */
  reportPartial: (payload: ToolPayload<never>) => void
}

export interface ToolServices {
  repos: Repos
  /** 毫秒时钟，测试可注入；审计 latency 与超时共用。 */
  now: () => number
  choices?: ChoiceResolver
}
