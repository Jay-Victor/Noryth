import { AppError, isAppError } from '../../shared/domain/app-error'
import type { ErrorCode } from '../../shared/domain/errors'
import type { Envelope, EnvelopeTraceItem, FallbackResponse, FinalAnswer } from '../../shared/schema/envelope'
import { EnvelopeSchema, FinalAnswerSchema } from '../../shared/schema/envelope'
import type { Capabilities } from '../../shared/schema/model'
import { CapabilitiesSchema } from '../../shared/schema/model'
import type { Repos } from '../db/repos'
import type { JobRecord } from '../db/repos/job'
import type { ContextBundle } from '../context/budget'
import { assembleContext, contextSnapshot } from '../context/assemble'
import { collectContext } from '../context/sources'
import type { ChatAdapter, ChatMessage, ChatResult, ChatToolCall } from '../model/adapter'
import { ModelError } from '../model/adapter'
import { bindingFor, type ResolvedBinding } from '../model/bindings'
import { parseFallbackResponse } from '../model/json-fallback'
import { capabilitiesFor, estimateCostCny } from '../model/presets'
import { estimateTokens } from '../context/tokens'
import type { ModelToolDescriptor } from '../tools/define'
import type { RegistrySnapshot } from '../tools/registry'
import { baseAgentOf } from '../tools/registry'
import { resolveToolset, type ResolvedToolset } from '../tools/resolve'
import type { AgentInstanceKey, ChoiceResolver, ToolResult, ToolServices } from '../tools/types'
import { RepoAuditSink } from '../tools/audit'
import { TurnBudget } from '../tools/budget'
import { RepoIdempotencyStore } from '../tools/idempotency'
import { invokeTool, type TurnContext } from '../tools/invoke'
import { TurnRefRegistry } from '../tools/turn-refs'
import type { TurnJobPayload } from './job'
import { parseTurnJobPayload } from './job'
import { renderPrompt, type RenderedPrompt } from './prompts'
import type { EnvelopeExpectation } from './validate'
import { assembleEnvelope, validateEnvelope } from './validate'

/**
 * 单拍运行时（DEV-PLAN §7.1）：
 *   冻结绑定/工具集 → 装配上下文 → 渲染提示词 → 调模型（流式 + 工具）
 *   → 组装信封 → 结构校验 → grounding 子集校验 →（阶段 05 落盘）
 *
 * 阶段 04 不写正文：校验通过只返回信封；commitBeat 留给阶段 05。
 * 任何一步失败都不产生「裸答正文」——失败要么抛错、要么返回 rejected。
 */

export interface TurnHooks {
  onPhase?: (phase: 'assembled' | 'generating' | 'validated' | 'rejected') => void
  onText?: (delta: string, full: string) => void
  onThought?: (delta: string, full: string) => void
  onToolCall?: (call: ChatToolCall, round: number) => void
  /** 适配器重试前通知 UI 清空当前拍增量。 */
  onReset?: () => void
}

export interface TurnDeps {
  repos: Repos
  registry: RegistrySnapshot
  /** 必须按 job 冻结的 bindings 构造；runTurn 不信外部传入的 provider/model。 */
  adapter: ChatAdapter
  gateSecret: string
  now?: () => number
  /** 设置里的 token 校准系数；缺省 1。 */
  tokenCalibration?: number
  topK?: number
  recentLimit?: number
  maxToolRounds?: number
  hooks?: TurnHooks
  choices?: ChoiceResolver
  signal?: AbortSignal
  /** 校验通过后落盘；缺省时只有校验（阶段 04 行为，测试用）。 */
  commit?: TurnCommitter
  /** 测试可关闭落库；默认写 turn_metric。 */
  writeMetric?: boolean
}

export interface TurnInput {
  job: JobRecord
  /** 已解析的 payload；不传则从 job.payload_json 读。 */
  payload?: TurnJobPayload
}

export interface TurnRejection {
  code: ErrorCode
  message: string
  details?: unknown
}

/**
 * 校验通过后的落盘回调（PHASE-05 V2）。
 *
 * runtime 不在 agents 层直接写正文：调用方注入 DocController.commitBeat，
 * 这样阶段 07 换调度器时 runTurn 不改，单一写入者也不被绕过。
 * 回调抛错 → 事务回滚 + job failed；不会出现「job 成功但正文没落盘」。
 */
export interface TurnCommitInput {
  jobId: string
  turnId: string
  chapterId: string
  /** 生成时的槽位拍（可能是被替换的旧版本）。 */
  beatId: string
  expectedRevision: string | null
  epoch: number
  supersedesId: string | null
  mode: 'interactive' | 'auto' | 'batch'
  envelope: Envelope
  context: { bundle: ContextBundle; prefixHash: string }
  binding: { provider: string; model: string; version: number }
}

export interface TurnCommitResult {
  beatId: string
  revisionId: string
  seq: number
  contentHash: string
  mirrorHash?: string
  traceRef?: string | null
}

export type TurnCommitter = (input: TurnCommitInput) => TurnCommitResult

export interface TurnResult {
  status: 'validated' | 'rejected'
  jobId: string
  turnId: string
  beatId: string
  envelope: Envelope | null
  rejection: TurnRejection | null
  /** 未注入 committer 时为 null（阶段 04 的纯校验路径）。 */
  commit: TurnCommitResult | null
  context: {
    bundle: ContextBundle
    prefixHash: string
    asOf: number
    degraded: string[]
  }
  binding: { provider: string; model: string; version: number }
  usage: { tokensIn: number | null; tokensOut: number | null }
  toolCalls: number
  attempts: number
  notes: string[]
  latencyMs: number
}

const MAX_TOOL_ROUNDS = 4
const MAX_FALLBACK_STEPS = 4

/** turn ID 的唯一格式；流式事件与 trace 路径都用它，避免两处拼串漂移。 */
export function turnIdFor(jobId: string, beatId: string): string {
  return `turn_${jobId}_${beatId}`
}

interface TurnRuntime {
  deps: TurnDeps
  repos: Repos
  job: JobRecord
  payload: TurnJobPayload
  actor: AgentInstanceKey
  binding: ResolvedBinding
  capabilities: Capabilities
  prompt: RenderedPrompt
  contextBundle: ContextBundle
  turnContext: TurnContext
  turnRefs: TurnRefRegistry
  services: ToolServices
  budget: TurnBudget
  audit: RepoAuditSink
  idempotency: RepoIdempotencyStore
  toolset: ResolvedToolset
  tools: ModelToolDescriptor[]
  rounds: ChatResult[]
  degradedSources: string[]
}

interface AttemptOutcome {
  draft: FinalAnswer
  rawText: string
  trace: EnvelopeTraceItem[]
  toolCalls: number
}

function characterIdOf(actor: AgentInstanceKey): string | null {
  return actor.startsWith('character:') ? actor.slice('character:'.length) : null
}

function capabilitiesOf(binding: ResolvedBinding): Capabilities {
  if (binding.capabilities) return binding.capabilities
  const fromParams = binding.params.capabilities
  if (fromParams !== undefined) {
    const parsed = CapabilitiesSchema.safeParse(fromParams)
    if (parsed.success) return parsed.data
  }
  return (
    capabilitiesFor(binding.provider, binding.model) ?? {
      stream: true,
      tools: false,
      jsonMode: false,
      contextWindow: 32_000,
      maxOutput: 8_192,
      pricing: { in: 0, out: 0 }
    }
  )
}

function traceArgs(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

function parseJsonArgs(raw: string): unknown {
  try {
    return JSON.parse(raw.trim().length === 0 ? '{}' : raw) as unknown
  } catch {
    throw new AppError('invalid_args', '工具参数不是合法 JSON', { preview: raw.slice(0, 80) })
  }
}

function parseFinalAnswer(text: string): FinalAnswer {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new AppError('schema_invalid', '模型没有返回最终答复')
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new AppError('schema_invalid', '最终答复不是合法 JSON', { preview: trimmed.slice(0, 120) })
  }
  const direct = FinalAnswerSchema.safeParse(raw)
  if (direct.success) return direct.data
  const envelope = EnvelopeSchema.safeParse(raw)
  if (envelope.success) {
    return { body: envelope.data.body, grounding: envelope.data.grounding, meta: envelope.data.meta }
  }
  throw new AppError('schema_invalid', '最终答复不符合契约', {
    issues: direct.error.issues.map((issue) => issue.path.join('.'))
  })
}

function toFinalAnswer(value: FinalAnswer | Envelope): FinalAnswer {
  if ('turn_id' in value) {
    return { body: value.body, grounding: value.grounding, meta: value.meta }
  }
  return value
}

function toolResultPayload(result: ToolResult): string {
  return JSON.stringify({
    data: result.data ?? null,
    refs: result.refs,
    degraded: result.degraded,
    truncated: result.truncated,
    ...(result.error === undefined ? {} : { error: result.error })
  })
}

function refCatalog(turnRefs: TurnRefRegistry): string {
  const refs = turnRefs
    .list()
    .slice(0, 24)
    .map((ref) => `- ${ref.type}:${ref.id}｜${ref.quote.slice(0, 80)}`)
  return refs.length === 0 ? '（本轮没有任何可引用材料，grounding 必须为空）' : refs.join('\n')
}

function sumUsage(rounds: readonly ChatResult[]): { tokensIn: number | null; tokensOut: number | null } {
  let input = 0
  let output = 0
  let seen = false
  for (const round of rounds) {
    if (!round.usage) continue
    seen = true
    input += round.usage.promptTokens
    output += round.usage.completionTokens
  }
  return seen ? { tokensIn: input, tokensOut: output } : { tokensIn: null, tokensOut: null }
}

function isRejection(code: ErrorCode): boolean {
  return (
    code === 'invalid_grounding' ||
    code === 'grounding_not_returned' ||
    code === 'grounding_quote_mismatch' ||
    code === 'schema_invalid' ||
    code === 'tool_protocol_error'
  )
}

function rejectionOf(error: unknown): TurnRejection {
  if (isAppError(error)) return { code: error.code, message: error.message, details: error.details }
  if (error instanceof ModelError) return { code: error.code, message: error.message, details: error.details }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error)
  }
}

function failJob(repos: Repos, jobId: string, error: unknown): void {
  const code = isAppError(error) ? error.code : error instanceof ModelError ? error.code : 'internal_error'
  try {
    repos.job.setStatus(jobId, 'failed', { errorCode: code })
  } catch {
    // 失败路径不再抛错
  }
}

function toAppError(error: ModelError): AppError {
  return new AppError(error.code, error.message, { ...error.details, status: error.status })
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const job = input.job
  const repos = deps.repos

  let payload: TurnJobPayload
  let actor: AgentInstanceKey
  let binding: ResolvedBinding
  try {
    payload = input.payload ?? parseTurnJobPayload(job)
    actor = payload.actor as AgentInstanceKey
    binding = bindingFor(payload.bindings, actor)
  } catch (error) {
    failJob(repos, job.id, error)
    throw error
  }
  const capabilities = capabilitiesOf(binding)

  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const chapter = repos.chapter.get(payload.chapter_id)
  const beat = repos.beat.get(payload.beat_id)
  if (!chapter || !beat) {
    const error = new AppError('project_not_found', 'job references missing chapter/beat')
    failJob(repos, job.id, error)
    throw error
  }
  if (deps.adapter.provider !== binding.provider || deps.adapter.model !== binding.model) {
    const error = new AppError('setup_incomplete', '适配器与 job 冻结绑定不一致', {
      adapter: { provider: deps.adapter.provider, model: deps.adapter.model },
      binding: { provider: binding.provider, model: binding.model }
    })
    failJob(repos, job.id, error)
    throw error
  }

  const turnId = turnIdFor(job.id, beat.id)
  repos.job.setStatus(job.id, 'running')

  let collected: ReturnType<typeof collectContext>
  let assembled: ReturnType<typeof assembleContext>
  let prompt: RenderedPrompt
  try {
    collected = collectContext(repos, {
      projectId: project.id,
      chapterId: payload.chapter_id,
      beatId: payload.beat_id,
      agent: actor,
      contextWindow: capabilities.contextWindow,
      ...(deps.topK === undefined ? {} : { topK: deps.topK }),
      ...(deps.recentLimit === undefined ? {} : { recentLimit: deps.recentLimit })
    })
    assembled = assembleContext({ ...collected.input, calibration: deps.tokenCalibration ?? 1 })
    prompt = renderPrompt({
      agentKey: actor,
      bundle: assembled.bundle,
      jsonFallback: !capabilities.tools
    })
  } catch (error) {
    failJob(repos, job.id, error)
    throw error
  }

  const toolset = resolveToolset(actor, {}, deps.registry)
  const services: ToolServices = {
    repos,
    now,
    ...(deps.choices === undefined ? {} : { choices: deps.choices })
  }
  const turnRefs = new TurnRefRegistry()
  turnRefs.register(assembled.refs)

  const runtime: TurnRuntime = {
    deps,
    repos,
    job,
    payload,
    actor,
    binding,
    capabilities,
    prompt,
    contextBundle: assembled.bundle,
    turnContext: {
      projectId: project.id,
      jobId: job.id,
      turnId,
      actorId: actor,
      characterId: characterIdOf(actor),
      asOf: collected.asOf,
      epoch: job.epoch,
      expectedRevision: job.expectedRevision,
      gateToken: null,
      chapterId: payload.chapter_id,
      beatId: payload.beat_id,
      mode: payload.mode
    },
    turnRefs,
    services,
    budget: new TurnBudget(actor),
    audit: new RepoAuditSink(repos.toolCall),
    idempotency: new RepoIdempotencyStore(repos.toolCall),
    toolset,
    tools: toolset.toModelTools(),
    rounds: [],
    degradedSources: [...assembled.bundle.degraded]
  }

  const useNativeTools = capabilities.tools && runtime.tools.length > 0
  if (!useNativeTools && !capabilities.jsonMode) {
    const error = new AppError('tool_unavailable', '模型不支持工具调用且不支持 JSON mode', {
      provider: binding.provider,
      model: binding.model
    })
    failJob(repos, job.id, error)
    throw error
  }

  deps.hooks?.onPhase?.('assembled')
  deps.hooks?.onPhase?.('generating')

  let outcome: AttemptOutcome
  try {
    outcome = useNativeTools ? await nativeTurn(runtime) : await fallbackTurn(runtime)
  } catch (error) {
    failJob(repos, job.id, error)
    deps.hooks?.onPhase?.('rejected')
    if (isAppError(error) && isRejection(error.code)) {
      return rejectedResult(runtime, turnId, beat.id, started, rejectionOf(error), 1, 0)
    }
    throw error instanceof ModelError ? toAppError(error) : error
  }

  let attempts = 1
  let validation: ReturnType<typeof validateEnvelope>
  try {
    validation = validateOn(runtime, turnId, beat, outcome)
  } catch (error) {
    if (!isAppError(error) || !isRejection(error.code)) {
      failJob(repos, job.id, error)
      throw error
    }
    attempts = 2
    try {
      outcome = await retryFinalAnswer(runtime, outcome, error)
      validation = validateOn(runtime, turnId, beat, outcome)
    } catch (retryError) {
      failJob(repos, job.id, retryError)
      deps.hooks?.onPhase?.('rejected')
      if (isAppError(retryError) && isRejection(retryError.code)) {
        return rejectedResult(runtime, turnId, beat.id, started, rejectionOf(retryError), attempts, outcome.toolCalls)
      }
      throw retryError instanceof ModelError ? toAppError(retryError) : retryError
    }
  }

  const usage = sumUsage(runtime.rounds)
  const cost = estimateCostCny(capabilities, usage.tokensIn, usage.tokensOut)

  let committed: TurnCommitResult | null = null
  if (deps.commit) {
    try {
      committed = deps.commit({
        jobId: job.id,
        turnId,
        chapterId: payload.chapter_id,
        beatId: beat.id,
        expectedRevision: job.expectedRevision,
        epoch: job.epoch,
        supersedesId: payload.supersedes_id ?? null,
        mode: payload.mode,
        envelope: validation.envelope,
        context: { bundle: assembled.bundle, prefixHash: prompt.prefixHash },
        binding: { provider: binding.provider, model: binding.model, version: binding.version }
      })
    } catch (error) {
      failJob(repos, job.id, error)
      deps.hooks?.onPhase?.('rejected')
      throw error
    }
  }

  if (deps.writeMetric !== false) {
    repos.turnMetric.upsert({
      turnId,
      projectId: project.id,
      jobId: job.id,
      beatId: beat.id,
      agentKey: baseAgentOf(actor),
      provider: binding.provider,
      model: binding.model,
      bindingVersion: binding.version,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costCny: cost,
      latencyMs: now() - started,
      firstTokenMs: runtime.rounds.find((round) => round.firstTokenMs !== null)?.firstTokenMs ?? null,
      contextJson: contextSnapshot(assembled.bundle, prompt.prefixHash, {
        toolset_version: payload.toolset_version,
        binding_hash: payload.binding_hash,
        prompt_version: payload.prompt_version,
        turn_id: turnId,
        actor,
        as_of: collected.asOf
      }),
      degradedJson: JSON.stringify(validation.envelope.meta.degraded ? runtime.degradedSources : []),
      createdAt: new Date(now()).toISOString()
    })
  }

  repos.job.setStatus(job.id, 'succeeded', {
    resultJson: JSON.stringify({
      turn_id: validation.envelope.turn_id,
      beat_id: beat.id,
      word_count: validation.wordCount,
      grounding_count: validation.envelope.grounding.length,
      degraded: validation.envelope.meta.degraded,
      binding_hash: payload.binding_hash,
      toolset_version: payload.toolset_version,
      ...(committed === null
        ? {}
        : {
            committed_beat_id: committed.beatId,
            revision_id: committed.revisionId,
            seq: committed.seq,
            content_hash: committed.contentHash
          })
    })
  })
  deps.hooks?.onPhase?.('validated')

  return {
    status: 'validated',
    jobId: job.id,
    turnId,
    beatId: beat.id,
    envelope: validation.envelope,
    rejection: null,
    commit: committed,
    context: {
      bundle: assembled.bundle,
      prefixHash: prompt.prefixHash,
      asOf: collected.asOf,
      degraded: runtime.degradedSources
    },
    binding: { provider: binding.provider, model: binding.model, version: binding.version },
    usage,
    toolCalls: outcome.toolCalls,
    attempts,
    notes: validation.notes,
    latencyMs: now() - started
  }
}

function expectationOf(
  runtime: TurnRuntime,
  turnId: string,
  speakerType: 'character' | 'narrator',
  speakerId: string,
  maxWords: number | null
): EnvelopeExpectation {
  const usage = sumUsage(runtime.rounds)
  return {
    turnId,
    speakerType,
    speakerId,
    maxWords,
    turnRefs: runtime.turnRefs,
    degradedSources: runtime.degradedSources,
    model: runtime.binding.model,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut
  }
}

function validateOn(
  runtime: TurnRuntime,
  turnId: string,
  beat: { speakerType: 'character' | 'narrator'; speakerId: string; maxWords: number | null },
  outcome: AttemptOutcome
): ReturnType<typeof validateEnvelope> {
  const expectation = expectationOf(runtime, turnId, beat.speakerType, beat.speakerId, beat.maxWords)
  return validateEnvelope(assembleEnvelope(outcome.draft, expectation, outcome.trace), expectation)
}

function rejectedResult(
  runtime: TurnRuntime,
  turnId: string,
  beatId: string,
  started: number,
  rejection: TurnRejection,
  attempts: number,
  toolCalls: number
): TurnResult {
  const now = runtime.deps.now ?? (() => Date.now())
  return {
    status: 'rejected',
    jobId: runtime.job.id,
    turnId,
    beatId,
    envelope: null,
    rejection,
    commit: null,
    context: {
      bundle: runtime.contextBundle,
      prefixHash: runtime.prompt.prefixHash,
      asOf: runtime.turnContext.asOf,
      degraded: runtime.degradedSources
    },
    binding: { provider: runtime.binding.provider, model: runtime.binding.model, version: runtime.binding.version },
    usage: sumUsage(runtime.rounds),
    toolCalls,
    attempts,
    notes: [],
    latencyMs: now() - started
  }
}

async function nativeTurn(runtime: TurnRuntime): Promise<AttemptOutcome> {
  const { deps, prompt, turnContext, services, budget, audit, idempotency, rounds, turnRefs, toolset } = runtime
  const messages: ChatMessage[] = [...prompt.messages]
  const trace: EnvelopeTraceItem[] = []
  let toolCalls = 0
  const maxRounds = deps.maxToolRounds ?? MAX_TOOL_ROUNDS

  const adapterHooks = {
    onText: (delta: string, full: string) => deps.hooks?.onText?.(delta, full),
    onThought: (delta: string, full: string) => deps.hooks?.onThought?.(delta, full),
    onReset: () => deps.hooks?.onReset?.()
  }

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await deps.adapter.stream(
      {
        messages,
        stream: true,
        tools: runtime.tools,
        toolChoice: 'auto',
        temperature: 0.7,
        signal: deps.signal
      },
      adapterHooks
    )
    rounds.push(result)
    if (result.reasoning.trim().length > 0) {
      trace.push({ type: 'thought', text: result.reasoning.slice(0, 2000) })
    }

    if (result.toolCalls.length === 0) {
      const draft = parseFinalAnswer(result.text)
      return { draft, rawText: result.text, trace, toolCalls }
    }

    messages.push({
      role: 'assistant',
      content: result.text,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments }
      }))
    })

    for (const call of result.toolCalls) {
      deps.hooks?.onToolCall?.(call, round)
      const args = parseJsonArgs(call.arguments)
      const toolResult = await invokeTool(
        { callId: call.id, tool: call.name, args },
        turnContext,
        { toolset, budget, audit, idempotency, gateSecret: deps.gateSecret, turnRefs },
        services
      )
      toolCalls += 1
      if (toolResult.degraded !== 'none' && toolResult.degraded !== 'full') {
        runtime.degradedSources.push(`tool_degraded:${call.name}:${toolResult.degraded}`)
      }
      trace.push({
        type: 'tool_call',
        call_id: call.id,
        tool: call.name,
        args: traceArgs(args),
        runtime_args: {
          character_id: turnContext.characterId,
          as_of: turnContext.asOf,
          chapter_id: turnContext.chapterId,
          beat_id: turnContext.beatId
        },
        result_ids: toolResult.refs.map((ref) => `${ref.type}:${ref.id}`),
        degraded: toolResult.degraded,
        latency_ms: toolResult.latency_ms
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: `<tool_result tool="${call.name}" call_id="${call.id}" ok="${String(toolResult.ok)}">\n${toolResultPayload(toolResult)}\n</tool_result>`
      })
    }
  }

  throw new AppError('tool_protocol_error', '工具调用轮数超过上限', { maxRounds })
}

async function fallbackTurn(runtime: TurnRuntime): Promise<AttemptOutcome> {
  const { deps, prompt, turnContext, services, budget, audit, idempotency, rounds, turnRefs, toolset } = runtime
  const messages: ChatMessage[] = [...prompt.messages]
  const trace: EnvelopeTraceItem[] = []
  let toolCalls = 0
  let toolRounds = 0
  let parseFailures = 0

  for (let step = 0; step < MAX_FALLBACK_STEPS; step += 1) {
    const result = await deps.adapter.stream(
      { messages, stream: false, jsonMode: true, temperature: 0.2, signal: deps.signal },
      {}
    )
    rounds.push(result)
    if (result.reasoning.trim().length > 0) {
      trace.push({ type: 'thought', text: result.reasoning.slice(0, 2000) })
    }

    let parsed: FallbackResponse
    try {
      parsed = parseFallbackResponse(result.text)
      parseFailures = 0
    } catch {
      parseFailures += 1
      if (parseFailures >= 2) {
        throw new AppError('tool_protocol_error', '连续两次无法解析 JSON 回退响应', {
          preview: result.text.slice(0, 120)
        })
      }
      messages.push({ role: 'assistant', content: result.text })
      messages.push({
        role: 'user',
        content: '上一次输出不是协议要求的 JSON。只输出一个 JSON 对象，不得输出其他字符；重试一次。'
      })
      continue
    }

    if (parsed.final !== null) {
      return { draft: toFinalAnswer(parsed.final), rawText: result.text, trace, toolCalls }
    }

    if (toolRounds >= 1) {
      throw new AppError('tool_protocol_error', 'JSON 回退只允许一轮工具', { step })
    }
    toolRounds += 1
    messages.push({ role: 'assistant', content: result.text })

    const results: string[] = []
    for (const [index, call] of parsed.tool_calls.entries()) {
      const callId = `fallback_${step}_${index}`
      const toolResult = await invokeTool(
        { callId, tool: call.tool, args: call.args },
        turnContext,
        { toolset, budget, audit, idempotency, gateSecret: deps.gateSecret, turnRefs },
        services
      )
      toolCalls += 1
      if (toolResult.degraded !== 'none' && toolResult.degraded !== 'full') {
        runtime.degradedSources.push(`tool_degraded:${call.tool}:${toolResult.degraded}`)
      }
      trace.push({
        type: 'tool_call',
        call_id: callId,
        tool: call.tool,
        args: traceArgs(call.args),
        runtime_args: {
          character_id: turnContext.characterId,
          as_of: turnContext.asOf,
          chapter_id: turnContext.chapterId,
          beat_id: turnContext.beatId
        },
        result_ids: toolResult.refs.map((ref) => `${ref.type}:${ref.id}`),
        degraded: toolResult.degraded,
        latency_ms: toolResult.latency_ms
      })
      results.push(
        `<tool_result tool="${call.tool}" ok="${String(toolResult.ok)}">\n${toolResultPayload(toolResult)}\n</tool_result>`
      )
    }
    messages.push({
      role: 'user',
      content: `${results.join('\n')}\n现在给出最终 JSON（tool_calls 必须为空）。`
    })
  }

  throw new AppError('tool_protocol_error', 'JSON 回退轮数超过上限')
}

async function retryFinalAnswer(
  runtime: TurnRuntime,
  previous: AttemptOutcome,
  error: AppError
): Promise<AttemptOutcome> {
  const messages: ChatMessage[] = [
    ...runtime.prompt.messages,
    { role: 'assistant', content: previous.rawText },
    {
      role: 'user',
      content: [
        `上一次答复未通过校验：${error.message}。`,
        '只允许引用以下材料（type:id｜原文）：',
        refCatalog(runtime.turnRefs),
        '请重新输出最终 JSON，不要调用工具。'
      ].join('\n')
    }
  ]
  const result = await runtime.deps.adapter.stream(
    { messages, stream: false, jsonMode: false, temperature: 0.2, signal: runtime.deps.signal },
    {}
  )
  runtime.rounds.push(result)
  const trace = [...previous.trace]
  if (result.reasoning.trim().length > 0) trace.push({ type: 'thought', text: result.reasoning.slice(0, 2000) })
  return {
    draft: parseFinalAnswer(result.text),
    rawText: result.text,
    trace,
    toolCalls: previous.toolCalls
  }
}

/** 供阶段 05 与测试使用：预估一次装配的 token（不读数据库）。 */
export function estimateContextTokens(blocks: readonly { text: string }[]): number {
  return blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0)
}

export { parseFinalAnswer, parseJsonArgs }
