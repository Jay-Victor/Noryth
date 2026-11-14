import type { Capabilities } from '../../shared/schema/model'
import type {
  ChatAdapter,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatToolCall,
  ChatUsage,
  ProviderConfig,
  RetryContext,
  StreamHooks
} from './adapter'
import {
  ModelError,
  defaultRetryContext,
  maxRetriesFor,
  normalizeBodyError,
  normalizeHttpError,
  protocolError,
  retryDelay
} from './adapter'
import { SseParser, type SseEvent } from './sse'

/**
 * OpenAI-compatible 适配器（PRD §9.3 / DEV-PLAN §7.5 / §7.8）。
 *
 * 覆盖 DeepSeek / OpenAI / 通义 的同一套协议：
 *   POST {baseUrl}/chat/completions + SSE `data:` 行 + `tool_calls` 增量。
 *
 * 供应商差异只在这一层处理：
 * - DeepSeek 的 `delta.reasoning_content` 进 thought，不拼进 body；
 * - usage 可能出现在 choices 为空数组的最后一个 chunk；
 * - 工具参数按 `index` 拼装，拼完不是合法 JSON 就报 protocol。
 */

export interface OpenAiCompatDeps {
  fetchImpl?: typeof fetch
  retry?: Partial<RetryContext>
  now?: () => number
  totalTimeoutMs?: number
  firstTokenTimeoutMs?: number
}

const DEFAULT_TOTAL_TIMEOUT_MS = 120_000
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000

interface ToolAccumulator {
  id: string
  name: string
  arguments: string
}

function headersFor(config: ProviderConfig, accept = 'text/event-stream'): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept
  }
  if (config.apiKey && config.apiKey.length > 0) headers.Authorization = `Bearer ${config.apiKey}`
  return headers
}

function endpoint(config: ProviderConfig, path: string): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  return `${base}${path}`
}

function toChatResult(
  base: Omit<ChatResult, 'retries'>,
  retries: number
): ChatResult {
  return { ...base, retries }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw protocolError('tool_call.arguments 不是合法 JSON 对象')
  }
}

function finishToolCalls(accumulators: Map<number, ToolAccumulator>): ChatToolCall[] {
  return [...accumulators.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, item]) => {
      parseToolArguments(item.arguments)
      return {
        id: item.id.length > 0 ? item.id : `call_${index}`,
        name: item.name,
        arguments: item.arguments.trim().length === 0 ? '{}' : item.arguments
      }
    })
    .filter((call) => call.name.length > 0)
}

function usageOf(raw: unknown): ChatUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const prompt = record.prompt_tokens
  const completion = record.completion_tokens
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null
  return { promptTokens: prompt, completionTokens: completion }
}

function contentOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function reasoningOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  const value = record.reasoning_content ?? record.reasoning
  return typeof value === 'string' ? value : ''
}

export function createOpenAiCompatAdapter(
  config: ProviderConfig,
  deps: OpenAiCompatDeps = {}
): ChatAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const retry: RetryContext = { ...defaultRetryContext, ...deps.retry }
  const totalTimeoutMs = deps.totalTimeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const firstTokenTimeoutMs =
    deps.firstTokenTimeoutMs ?? config.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS

  function bodyOf(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages,
      stream
    }
    if (stream) body.stream_options = { include_usage: true }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
      body.tool_choice = request.toolChoice ?? 'auto'
    }
    if (request.jsonMode) body.response_format = { type: 'json_object' }
    return body
  }

  async function fetchText(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal })
    } catch (error) {
      throw new ModelError('model_error', 'provider request failed', {
        retryable: true,
        details: { message: error instanceof Error ? error.message : String(error) }
      })
    }
  }

  /** 非流式（探测与 JSON 回退的小请求）：一次性读完整响应。 */
  async function completeOnce(request: ChatRequest): Promise<ChatResult> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, totalTimeoutMs)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort)
    const started = now()
    try {
      const response = await fetchText(
        endpoint(config, '/chat/completions'),
        { method: 'POST', headers: headersFor(config), body: JSON.stringify(bodyOf(request, false)) },
        controller.signal
      )
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw normalizeHttpError(response.status, text)
      }
      const payload = (await response.json()) as Record<string, unknown>
      if (payload.error) throw normalizeBodyError(JSON.stringify(payload.error))
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const first = (choices[0] ?? {}) as Record<string, unknown>
      const message = first.message
      const toolCallsRaw = message && typeof message === 'object' ? (message as Record<string, unknown>).tool_calls : []
      const toolCalls: ChatToolCall[] = Array.isArray(toolCallsRaw)
        ? toolCallsRaw.map((raw, index) => {
            const entry = raw as Record<string, unknown>
            const fn = (entry.function ?? {}) as Record<string, unknown>
            const args = typeof fn.arguments === 'string' ? fn.arguments : '{}'
            parseToolArguments(args)
            return {
              id: typeof entry.id === 'string' ? entry.id : `call_${index}`,
              name: typeof fn.name === 'string' ? fn.name : '',
              arguments: args
            }
          })
        : []
      const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : null
      if (finishReason === 'content_filter') {
        throw new ModelError('content_filter', 'provider refused content')
      }
      return toChatResult(
        {
          text: contentOf(message),
          reasoning: reasoningOf(message),
          toolCalls: toolCalls.filter((call) => call.name.length > 0),
          usage: usageOf(payload.usage),
          finishReason,
          model: typeof payload.model === 'string' ? payload.model : config.model,
          latencyMs: now() - started,
          firstTokenMs: null
        },
        0
      )
    } catch (error) {
      if (error instanceof ModelError) {
        if (error.aborted) throw error
        if (timedOut) throw new ModelError('timeout', 'provider timeout', { retryable: true })
        throw error
      }
      if (timedOut) throw new ModelError('timeout', 'provider timeout', { retryable: true })
      if (request.signal?.aborted) {
        throw new ModelError('model_error', 'aborted', { aborted: true })
      }
      throw new ModelError('model_error', 'provider request failed', {
        retryable: true,
        details: { message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  async function complete(request: ChatRequest): Promise<ChatResult> {
    let attempt = 0
    for (;;) {
      try {
        const result = await completeOnce(request)
        return toChatResult(result, attempt)
      } catch (error) {
        const failure = error instanceof ModelError ? error : new ModelError('model_error', 'unknown failure')
        if (failure.aborted || !failure.retryable) throw failure
        const limit = maxRetriesFor(failure.code)
        if (attempt >= limit) throw failure
        await retry.sleep(retryDelay(attempt, retry))
        attempt += 1
      }
    }
  }

  async function streamOnce(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    if (request.signal?.aborted) throw new ModelError('model_error', 'aborted', { aborted: true })
    const controller = new AbortController()
    let timedOut = false
    let firstTokenSeen = false
    const started = now()
    let firstTokenMs: number | null = null

    const totalTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, totalTimeoutMs)
    const firstTokenTimer = setTimeout(() => {
      if (!firstTokenSeen) {
        timedOut = true
        controller.abort()
      }
    }, firstTokenTimeoutMs)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort)

    let text = ''
    let reasoning = ''
    let finishReason: string | null = null
    let model = config.model
    let usage: ChatUsage | null = null
    const tools = new Map<number, ToolAccumulator>()

    const markFirstToken = (): void => {
      if (firstTokenSeen) return
      firstTokenSeen = true
      firstTokenMs = now() - started
      clearTimeout(firstTokenTimer)
    }

    const handleEvent = (event: SseEvent): boolean => {
      if (event.data === '[DONE]') return true
      const raw = event.data.trim()
      if (raw.length === 0) return false
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        throw protocolError('SSE data 不是合法 JSON')
      }
      if (payload.error) throw normalizeBodyError(JSON.stringify(payload.error))
      if (typeof payload.model === 'string') model = payload.model
      const chunkUsage = usageOf(payload.usage)
      if (chunkUsage) usage = chunkUsage

      const choices = Array.isArray(payload.choices) ? payload.choices : []
      for (const rawChoice of choices) {
        if (rawChoice === null || typeof rawChoice !== 'object') continue
        const choice = rawChoice as Record<string, unknown>
        const delta = (choice.delta ?? {}) as Record<string, unknown>
        const content = delta.content
        if (typeof content === 'string' && content.length > 0) {
          markFirstToken()
          text += content
          hooks.onText?.(content, text)
        }
        const thought = delta.reasoning_content ?? delta.reasoning
        if (typeof thought === 'string' && thought.length > 0) {
          markFirstToken()
          reasoning += thought
          hooks.onThought?.(thought, reasoning)
        }
        const deltas = delta.tool_calls
        if (Array.isArray(deltas)) {
          for (const rawDelta of deltas) {
            if (rawDelta === null || typeof rawDelta !== 'object') continue
            const item = rawDelta as Record<string, unknown>
            const index = typeof item.index === 'number' ? item.index : 0
            const fn = (item.function ?? {}) as Record<string, unknown>
            const current = tools.get(index) ?? { id: '', name: '', arguments: '' }
            if (typeof item.id === 'string' && item.id.length > 0 && current.id.length === 0) current.id = item.id
            if (typeof fn.name === 'string' && fn.name.length > 0) current.name = fn.name
            if (typeof fn.arguments === 'string') current.arguments += fn.arguments
            tools.set(index, current)
            markFirstToken()
            hooks.onToolCallDelta?.(
              { id: current.id, name: current.name, arguments: current.arguments },
              index
            )
          }
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      }
      return false
    }

    try {
      const response = await fetchText(
        endpoint(config, '/chat/completions'),
        { method: 'POST', headers: headersFor(config), body: JSON.stringify(bodyOf(request, true)) },
        controller.signal
      )
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw normalizeHttpError(response.status, body)
      }
      if (!response.body) throw protocolError('provider returned empty stream')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      let done = false
      try {
        while (!done) {
          const chunk = await reader.read()
          if (chunk.done) break
          const events = parser.push(decoder.decode(chunk.value, { stream: true }))
          for (const event of events) {
            if (handleEvent(event)) {
              done = true
              break
            }
          }
        }
        if (!done) {
          for (const event of parser.end()) {
            if (handleEvent(event)) break
          }
        }
      } finally {
        if (!done) await reader.cancel().catch(() => undefined)
      }
      if (timedOut) throw new ModelError('timeout', 'provider timeout', { retryable: true })
      if (request.signal?.aborted) throw new ModelError('model_error', 'aborted', { aborted: true })
      if (finishReason === 'content_filter') {
        throw new ModelError('content_filter', 'provider refused content')
      }
      if (text.length === 0 && tools.size === 0) {
        throw protocolError('provider returned no content and no tool calls')
      }
      const toolCalls = finishToolCalls(tools)
      if (toolCalls.length === 0 && finishReason === 'tool_calls') {
        throw protocolError('finish_reason=tool_calls 但没有可拼装的工具调用')
      }
      return toChatResult(
        {
          text,
          reasoning,
          toolCalls,
          usage,
          finishReason,
          model,
          latencyMs: now() - started,
          firstTokenMs
        },
        0
      )
    } catch (error) {
      if (error instanceof ModelError) {
        if (error.aborted) throw error
        if (timedOut) throw new ModelError('timeout', 'provider timeout', { retryable: true })
        throw error
      }
      if (timedOut) throw new ModelError('timeout', 'provider timeout', { retryable: true })
      if (request.signal?.aborted) {
        throw new ModelError('model_error', 'aborted', { aborted: true })
      }
      throw new ModelError('model_error', 'provider stream failed', {
        retryable: true,
        details: { message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      clearTimeout(totalTimer)
      clearTimeout(firstTokenTimer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  async function stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    if (!request.stream) return complete(request)
    let attempt = 0
    for (;;) {
      try {
        const result = await streamOnce(request, hooks)
        return toChatResult(result, attempt)
      } catch (error) {
        const failure = error instanceof ModelError ? error : new ModelError('model_error', 'unknown failure')
        if (failure.aborted || !failure.retryable) throw failure
        const limit = maxRetriesFor(failure.code)
        if (attempt >= limit) throw failure
        hooks.onReset?.()
        await retry.sleep(retryDelay(attempt, retry))
        attempt += 1
      }
    }
  }

  /**
   * 探测能可靠验证的只有 stream / tools / jsonMode；
   * contextWindow / maxOutput / pricing 在 OpenAI-compatible 的 /models 里没有统一字段，
   * 取预设表的保守默认值（`presets.ts`），UI 标注「预设值，非实测」。
   */
  async function probe(): Promise<Capabilities> {
    const fallback: Capabilities =
      config.capabilities ?? {
        stream: true,
        tools: false,
        jsonMode: false,
        contextWindow: 32_000,
        maxOutput: 8_192,
        pricing: { in: 0, out: 0 }
      }

    const probeTools = async (choice: 'required' | 'auto'): Promise<boolean> => {
      const result = await completeOnce({
        messages: [
          {
            role: 'user',
            content: '调用 probe_echo 工具，参数 text 固定为 "ok"。'
          }
        ],
        stream: false,
        maxTokens: 64,
        temperature: 0,
        tools: [
          {
            type: 'function',
            function: {
              name: 'probe_echo',
              description: '原样返回 text',
              parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false
              }
            }
          }
        ],
        toolChoice: choice
      })
      return result.toolCalls.length > 0
    }

    // 1) /models：验证 base URL 与 Key；404 表示供应商不实现该端点，不视为失败。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), totalTimeoutMs)
    try {
      const response = await fetchText(
        endpoint(config, '/models'),
        { method: 'GET', headers: headersFor(config, 'application/json') },
        controller.signal
      )
      if (!response.ok && response.status !== 404 && response.status !== 405) {
        const body = await response.text().catch(() => '')
        throw normalizeHttpError(response.status, body)
      }
    } finally {
      clearTimeout(timer)
    }

    const probeStream = async (): Promise<boolean> => {
      try {
        const streamed = await streamOnce(
          {
            messages: [{ role: 'user', content: '只回复 ok' }],
            stream: true,
            maxTokens: 8,
            temperature: 0
          },
          {}
        )
        return streamed.text.length > 0 || streamed.toolCalls.length > 0
      } catch (error) {
        if (error instanceof ModelError && error.code === 'model_auth') throw error
        return false
      }
    }

    const probeToolSupport = async (): Promise<boolean> => {
      try {
        return await probeTools('required')
      } catch (error) {
        if (error instanceof ModelError && error.code === 'model_auth') throw error
        // 个别供应商不接受 tool_choice=required（400），退回 auto 再试一次。
        if (error instanceof ModelError && error.status === 400) {
          try {
            return await probeTools('auto')
          } catch (retryError) {
            if (retryError instanceof ModelError && retryError.code === 'model_auth') throw retryError
            return false
          }
        }
        return false
      }
    }

    const probeJsonMode = async (): Promise<boolean> => {
      try {
        const result = await completeOnce({
          messages: [
            {
              role: 'system',
              content: '只输出一个 JSON 对象，不得输出其他字符。'
            },
            { role: 'user', content: '输出 {"ok":true}' }
          ],
          stream: false,
          maxTokens: 32,
          temperature: 0,
          jsonMode: true
        })
        try {
          const parsed = JSON.parse(result.text.trim()) as unknown
          return parsed !== null && typeof parsed === 'object'
        } catch {
          return false
        }
      } catch (error) {
        if (error instanceof ModelError && error.code === 'model_auth') throw error
        return false
      }
    }

    const streamSupported = await probeStream()
    const toolsSupported = await probeToolSupport()
    const jsonSupported = await probeJsonMode()

    return {
      stream: streamSupported,
      tools: toolsSupported,
      jsonMode: jsonSupported,
      contextWindow: fallback.contextWindow,
      maxOutput: fallback.maxOutput,
      pricing: fallback.pricing
    }
  }

  return {
    provider: config.provider,
    model: config.model,
    probe,
    stream
  }
}

export type { ChatMessage }
