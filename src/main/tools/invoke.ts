import { isAppError } from '../../shared/domain/app-error'
import type { ErrorCode } from '../../shared/domain/errors'
import type { AuditSink } from './audit'
import { scopeJson } from './audit'
import type { TurnBudget } from './budget'
import type { AnyToolDefinition } from './define'
import type { GateCheck } from './gates'
import { checkGate } from './gates'
import type { IdempotencyStore } from './idempotency'
import { argsHash as computeArgsHash, idempotencyKey } from './idempotency'
import type { ResolvedToolset } from './resolve'
import { truncatePayload } from './truncate'
import type { TurnRefRegistry } from './turn-refs'
import type {
  AgentInstanceKey,
  ToolContext,
  ToolPayload,
  ToolResult,
  ToolRuntime,
  ToolServices,
  VerifiedGate
} from './types'
import { sha256Hex } from '../crypto'

/**
 * 调用流水线（DEV-PLAN §6.4，九步顺序不可换）：
 *   1 快照取工具 → 2 参数 strict → 3 身份注入 → 4 幂等重放 → 5 预算
 *   → 6 闸门 → 7 执行/超时/降级 → 8 截断 → 9 审计 + 登记 refs
 *
 * 三处顺序理由：
 * - 授权先于参数：未授权工具不进 schema 解析，避免用报错探测参数。
 * - 幂等先于预算：重放不消耗额度，也不该被拒。
 * - 闸门先于执行，且只在 job 成功后消费：失败重试复用同一令牌。
 */

export interface TurnContext {
  projectId: string
  jobId: string
  turnId: string
  actorId: AgentInstanceKey
  characterId: string | null
  asOf: number
  epoch: number
  expectedRevision: string | null
  gateToken: string | null
  chapterId: string | null
  beatId: string | null
  mode: 'interactive' | 'auto' | 'batch'
}

export interface CallIntent {
  callId: string
  tool: string
  args: unknown
}

export interface InvokeDeps {
  toolset: ResolvedToolset
  budget: TurnBudget
  audit: AuditSink
  idempotency: IdempotencyStore
  gateSecret: string
  nowMs?: () => number
  gateNowMs?: () => number
  turnRefs?: TurnRefRegistry
  onInternalError?: (error: unknown) => void
}

class TimeoutError extends Error {
  constructor() {
    super('tool timeout')
    this.name = 'TimeoutError'
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function runtimeOf(context: TurnContext): ToolRuntime {
  return {
    project_id: context.projectId,
    actor_id: context.actorId,
    character_id: context.characterId,
    as_of: context.asOf,
    job_id: context.jobId,
    turn_id: context.turnId,
    epoch: context.epoch,
    expected_revision: context.expectedRevision,
    gate_token: context.gateToken,
    chapter_id: context.chapterId,
    beat_id: context.beatId,
    mode: context.mode
  }
}

function errorResult(callId: string, code: ErrorCode, latencyMs: number, fields?: string[]): ToolResult {
  return {
    call_id: callId,
    ok: false,
    refs: [],
    truncated: false,
    degraded: 'none',
    error: fields && fields.length > 0 ? { code, fields } : { code },
    latency_ms: latencyMs
  }
}

function safeArgsHash(args: unknown): string {
  try {
    return computeArgsHash(args)
  } catch {
    return sha256Hex('unhashable_args')
  }
}

export async function invokeTool(
  intent: CallIntent,
  context: TurnContext,
  deps: InvokeDeps,
  services: ToolServices
): Promise<ToolResult> {
  const clock = deps.nowMs ?? (() => Date.now())
  const started = clock()
  const elapsed = (): number => Math.max(0, clock() - started)
  const scope = {
    actorId: context.actorId,
    characterId: context.characterId,
    asOf: context.asOf,
    expectedRevision: context.expectedRevision
  }
  const hash = safeArgsHash(intent.args)

  const auditError = (tool: AnyToolDefinition | undefined, code: ErrorCode): void => {
    deps.audit.record({
      projectId: context.projectId,
      jobId: context.jobId,
      turnId: context.turnId,
      tool: tool?.name ?? intent.tool,
      toolVersion: tool?.version ?? '',
      actorId: context.actorId,
      scopeJson: scopeJson(scope),
      argsHash: hash,
      status: 'error',
      errorCode: code,
      latencyMs: elapsed(),
      degraded: 'none'
    })
  }

  // 1) 从快照取工具：未授权 = 不存在
  const tool = deps.toolset.get(intent.tool)
  if (!tool) {
    deps.audit.record({
      projectId: context.projectId,
      jobId: context.jobId,
      turnId: context.turnId,
      tool: intent.tool,
      toolVersion: '',
      actorId: context.actorId,
      scopeJson: scopeJson({ ...scope, unauthorized: true }),
      argsHash: hash,
      status: 'error',
      errorCode: 'tool_not_found',
      latencyMs: elapsed(),
      degraded: 'none'
    })
    return errorResult(intent.callId, 'tool_not_found', elapsed())
  }

  // 2) 参数 strict 校验
  const parsed = tool.input.safeParse(intent.args)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.'))
    auditError(tool, 'invalid_args')
    return errorResult(intent.callId, 'invalid_args', elapsed(), fields)
  }
  const args = parsed.data as Record<string, unknown>

  // 3) 运行时注入（模型不可见、不可覆盖）
  const runtime = runtimeOf(context)

  // 4) 幂等重放（只对 propose / execute）
  const idempotency = tool.idempotency === 'key_required'
  const key = idempotency
    ? idempotencyKey({
        projectId: context.projectId,
        jobId: context.jobId,
        tool: tool.name,
        version: tool.version,
        args
      })
    : null
  if (key) {
    const replay = deps.idempotency.find(context.projectId, key)
    if (replay) return { ...replay, duplicate: true, latency_ms: 0 }
  }

  // 5) 单轮预算与单工具上限
  if (!deps.budget.take(tool.name, tool.limits.maxCallsPerTurn)) {
    auditError(tool, 'tool_budget_exceeded')
    return errorResult(intent.callId, 'tool_budget_exceeded', elapsed())
  }

  // 6) 闸门令牌校验（不消费）
  let gate: VerifiedGate | null = null
  if (tool.requiresGate) {
    const check: GateCheck = checkGate({
      repos: services.repos,
      secret: deps.gateSecret,
      required: tool.requiresGate,
      token: context.gateToken,
      runtime: { project_id: runtime.project_id, job_id: runtime.job_id, expected_revision: runtime.expected_revision },
      nowMs: deps.gateNowMs?.()
    })
    if (!check.ok) {
      auditError(tool, check.code)
      return errorResult(intent.callId, check.code, elapsed())
    }
    gate = check.payload
  }

  // 7) 执行 + 超时 + 降级
  let partial: ToolPayload<never> | null = null
  const toolContext: ToolContext = {
    runtime,
    chapterId: context.chapterId,
    beatId: context.beatId,
    mode: context.mode,
    gate,
    reportPartial: (payload) => {
      partial = payload
    }
  }

  let payload: ToolPayload<unknown>
  try {
    payload = (await withTimeout(
      Promise.resolve(tool.handler(args as never, toolContext, services)),
      tool.limits.timeoutMs
    )) as ToolPayload<unknown>
  } catch (error) {
    if (error instanceof TimeoutError) {
      if (partial) {
        const fallback = partial as ToolPayload<unknown>
        payload = { ...fallback, degraded: 'summary', truncated: true }
      } else {
        auditError(tool, 'timeout')
        return errorResult(intent.callId, 'timeout', elapsed())
      }
    } else if (isAppError(error)) {
      deps.onInternalError?.(error)
      auditError(tool, error.code)
      return errorResult(intent.callId, error.code, elapsed())
    } else {
      deps.onInternalError?.(error)
      auditError(tool, 'internal_error')
      return errorResult(intent.callId, 'internal_error', elapsed())
    }
  }

  // 8) 截断（整条丢弃，不静默切半句）
  const shaped = truncatePayload(payload, tool.limits.maxResultTokens)
  const result: ToolResult = {
    call_id: intent.callId,
    ok: true,
    data: shaped.payload.data,
    refs: shaped.payload.refs ?? [],
    truncated: shaped.truncated,
    degraded: shaped.degraded,
    latency_ms: elapsed(),
    ...(shaped.total === undefined ? {} : { total: shaped.total }),
    ...(shaped.payload.filteredCount === undefined ? {} : { filtered_count: shaped.payload.filteredCount }),
    ...(payload.truncated === true ? { truncated: true } : {})
  }

  // 9) 审计 + 登记 refs
  deps.turnRefs?.register(result.refs)
  deps.audit.record({
    projectId: context.projectId,
    jobId: context.jobId,
    turnId: context.turnId,
    tool: tool.name,
    toolVersion: tool.version,
    actorId: context.actorId,
    scopeJson: scopeJson(scope),
    argsHash: hash,
    resultIdsJson: JSON.stringify(result.refs.map((ref) => `${ref.type}:${ref.id}`)),
    resultJson: key ? JSON.stringify(result) : null,
    status: 'ok',
    latencyMs: result.latency_ms,
    degraded: result.degraded,
    idempotencyKey: key
  })
  return result
}

