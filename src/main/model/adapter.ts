import type { ErrorCode } from '../../shared/domain/errors'
import type { Capabilities } from '../../shared/schema/model'

/**
 * 模型适配器契约（DEV-PLAN §7.5）。
 *
 * 所有云端供应商走 OpenAI-compatible 的 chat completions；预设只负责 base URL。
 * 错误在这一层归一化，业务层只看到 ErrorCode；不静默换弱模型。
 */

export interface ChatToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AssistantToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatMessageRole
  content: string
  /** assistant 发起的工具调用（回放给模型时使用，OpenAI-compatible 形状）。 */
  tool_calls?: AssistantToolCallWire[]
  tool_call_id?: string
  name?: string
}

export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
}

export interface ChatRequest {
  messages: ChatMessage[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  tools?: ChatToolSchema[]
  toolChoice?: 'auto' | 'none' | 'required'
  jsonMode?: boolean
  signal?: AbortSignal
  /** 只用于日志与审计，不进入请求体。 */
  meta?: { agentKey?: string; beatId?: string }
}

export interface StreamHooks {
  onText?: (delta: string, full: string) => void
  /** DeepSeek 的 reasoning_content：只进 trace，不拼进 body。 */
  onThought?: (delta: string, full: string) => void
  onToolCallDelta?: (call: ChatToolCall, index: number) => void
  /** 重试前清空已累积的增量，避免半句与重试结果拼接。 */
  onReset?: () => void
}

export interface ChatResult {
  text: string
  reasoning: string
  toolCalls: ChatToolCall[]
  usage: ChatUsage | null
  finishReason: string | null
  model: string
  latencyMs: number
  firstTokenMs: number | null
  retries: number
}

export interface ChatAdapter {
  readonly provider: string
  readonly model: string
  probe(): Promise<Capabilities>
  stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult>
}

export interface ProviderConfig {
  provider: string
  baseUrl: string
  model: string
  /** 只驻留内存；不写盘、不写日志。 */
  apiKey?: string
  /** 预设的能力默认值；探测/真实 usage 优先。 */
  capabilities?: Capabilities
  defaultTimeoutMs?: number
  firstTokenTimeoutMs?: number
}

export class ModelError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status: number | null
  readonly aborted: boolean
  readonly details: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean
      status?: number | null
      aborted?: boolean
      details?: Record<string, unknown>
    } = {}
  ) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status ?? null
    this.aborted = options.aborted ?? false
    this.details = options.details ?? {}
  }
}

export const RETRY_DELAYS_MS = [500, 1500] as const

/** 429/5xx/超时可重试 2 次；协议错误 1 次；401/400/内容过滤不重试。 */
export function maxRetriesFor(code: ErrorCode): number {
  switch (code) {
    case 'rate_limit':
    case 'timeout':
    case 'model_error':
      return 2
    case 'tool_protocol_error':
      return 1
    default:
      return 0
  }
}

export const CONTEXT_OVERFLOW_PATTERN =
  /context length|context_length|maximum context|too many tokens|reduce the length|prompt is too long|上下文长度|超出.*长度/i
export const CONTENT_FILTER_PATTERN = /content[_ ]filter|content policy|safety|违规内容|内容审查/i

/** HTTP 状态 + 响应体 → 归一化错误；文案只用于日志，不上 UI。 */
export function normalizeHttpError(status: number, body: string): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError('model_auth', `provider auth failed (${status})`, { status })
  }
  if (status === 429) {
    return new ModelError('rate_limit', `provider rate limited (${status})`, { status, retryable: true })
  }
  if (status >= 500) {
    return new ModelError('model_error', `provider server error (${status})`, { status, retryable: true })
  }
  if (status === 400 && CONTEXT_OVERFLOW_PATTERN.test(body)) {
    return new ModelError('context_overflow', 'provider rejected context length', { status })
  }
  if (status === 400 && CONTENT_FILTER_PATTERN.test(body)) {
    return new ModelError('content_filter', 'provider refused content', { status })
  }
  if (status === 408 || status === 504) {
    return new ModelError('timeout', `provider timeout (${status})`, { status, retryable: true })
  }
  return new ModelError('model_error', `provider responded ${status}`, { status })
}

export function normalizeBodyError(body: string): ModelError {
  if (CONTEXT_OVERFLOW_PATTERN.test(body)) {
    return new ModelError('context_overflow', 'provider rejected context length')
  }
  if (CONTENT_FILTER_PATTERN.test(body)) {
    return new ModelError('content_filter', 'provider refused content')
  }
  return new ModelError('model_error', 'provider error payload')
}

export function protocolError(message: string): ModelError {
  return new ModelError('tool_protocol_error', message, { retryable: true })
}

export interface RetryContext {
  sleep: (ms: number) => Promise<void>
  /** 0..1；默认 Math.random，测试注入固定值。 */
  jitter: () => number
}

export const defaultRetryContext: RetryContext = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitter: () => Math.random()
}

export function retryDelay(attempt: number, retry: RetryContext): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 1500
  return Math.round(base + retry.jitter() * base * 0.3)
}
