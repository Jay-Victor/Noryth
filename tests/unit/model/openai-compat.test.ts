import { describe, expect, it } from 'vitest'
import { ModelError } from '../../../src/main/model/adapter'
import { createOpenAiCompatAdapter } from '../../../src/main/model/openai-compat'

const CONFIG = {
  provider: 'deepseek',
  baseUrl: 'https://fake.local/v1',
  model: 'deepseek-flash',
  apiKey: 'test-key',
  capabilities: {
    stream: true,
    tools: true,
    jsonMode: true,
    contextWindow: 64_000,
    maxOutput: 8_192,
    pricing: { in: 0, out: 0 }
  }
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function dataLines(payloads: unknown[], done = true): string[] {
  return [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), ...(done ? ['data: [DONE]\n\n'] : [])]
}

const noSleep = { sleep: async () => undefined, jitter: () => 0 }

describe('OpenAI-compatible 适配器（DEV-PLAN §7.5 / §7.8）', () => {
  it('流式正文、reasoning、工具增量与 usage 按 index 拼装', async () => {
    const chunks = dataLines([
      { model: 'deepseek-flash', choices: [{ delta: { reasoning_content: '先想' } }] },
      { choices: [{ delta: { content: '雨' } }] },
      { choices: [{ delta: { content: '停了' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'memory.retrieve_own', arguments: '{"query":' }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"匣子"}' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }
    ])
    const calls: string[] = []
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push(String(init.body))
        return sseResponse(chunks)
      }) as unknown as typeof fetch,
      retry: noSleep,
      now: () => 1000
    })

    const deltas: string[] = []
    const thoughts: string[] = []
    const result = await adapter.stream(
      { messages: [{ role: 'user', content: '写一拍' }], stream: true, tools: [] },
      { onText: (delta) => deltas.push(delta), onThought: (delta) => thoughts.push(delta) }
    )

    expect(deltas).toEqual(['雨', '停了'])
    expect(thoughts).toEqual(['先想'])
    expect(result.text).toBe('雨停了')
    expect(result.reasoning).toBe('先想')
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'memory.retrieve_own', arguments: '{"query":"匣子"}' }
    ])
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5 })
    expect(result.finishReason).toBe('tool_calls')
    expect(calls[0]).toContain('"stream":true')
    expect(calls[0]).toContain('"include_usage":true')
  })

  it('网络分片切在 JSON 中间仍能解析', async () => {
    const raw = dataLines([
      { choices: [{ delta: { content: '雨' } }] },
      { choices: [{ delta: { content: '夜' } }] }
    ]).join('')
    const pieces = raw.match(/[\s\S]{1,7}/g) ?? []
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => sseResponse(pieces)) as unknown as typeof fetch,
      retry: noSleep
    })
    const result = await adapter.stream({ messages: [{ role: 'user', content: 'x' }], stream: true }, {})
    expect(result.text).toBe('雨夜')
  })

  it('401 归一化为 model_auth 且不重试', async () => {
    let count = 0
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => {
        count += 1
        return jsonResponse({ error: { message: 'bad key' } }, 401)
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    await expect(adapter.stream({ messages: [], stream: true }, {})).rejects.toMatchObject({
      code: 'model_auth'
    })
    expect(count).toBe(1)
  })

  it('429 重试 2 次后成功，并记录 retries', async () => {
    let count = 0
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => {
        count += 1
        if (count < 3) return jsonResponse({ error: { message: 'slow down' } }, 429)
        return sseResponse(dataLines([{ choices: [{ delta: { content: '好' } }] }]))
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    const resets: number[] = []
    const result = await adapter.stream({ messages: [], stream: true }, { onReset: () => resets.push(count) })
    expect(result.text).toBe('好')
    expect(result.retries).toBe(2)
    expect(count).toBe(3)
    expect(resets).toEqual([1, 2])
  })

  it('5xx 重试 2 次后仍失败 → model_error，共 3 次请求', async () => {
    let count = 0
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => {
        count += 1
        return jsonResponse({ error: { message: 'boom' } }, 500)
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    await expect(adapter.stream({ messages: [], stream: true }, {})).rejects.toMatchObject({ code: 'model_error' })
    expect(count).toBe(3)
  })

  it('400 上下文超长 → context_overflow，不重试', async () => {
    let count = 0
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => {
        count += 1
        return jsonResponse({ error: { message: 'This model maximum context length is 64k tokens' } }, 400)
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    await expect(adapter.stream({ messages: [], stream: true }, {})).rejects.toMatchObject({
      code: 'context_overflow'
    })
    expect(count).toBe(1)
  })

  it('工具参数不是合法 JSON → tool_protocol_error，重试 1 次', async () => {
    let count = 0
    const chunk = dataLines([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'x.y', arguments: '{not-json' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      }
    ])
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => {
        count += 1
        return sseResponse(chunk)
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    await expect(adapter.stream({ messages: [], stream: true }, {})).rejects.toMatchObject({
      code: 'tool_protocol_error'
    })
    expect(count).toBe(2)
  })

  it('首 token 超时 → timeout，重试 2 次后失败', async () => {
    let count = 0
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        count += 1
        const signal = init.signal as AbortSignal
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError'))
            )
          }
        })
        return new Response(stream, { status: 200 })
      }) as unknown as typeof fetch,
      retry: noSleep,
      firstTokenTimeoutMs: 10
    })
    await expect(adapter.stream({ messages: [], stream: true }, {})).rejects.toMatchObject({ code: 'timeout' })
    expect(count).toBe(3)
  })

  it('abort 后抛 aborted，不再重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = createOpenAiCompatAdapter(CONFIG, { fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch })
    await expect(
      adapter.stream({ messages: [], stream: true, signal: controller.signal }, {})
    ).rejects.toMatchObject({ aborted: true })
  })

  it('非流式读完整响应（探测/回退用）', async () => {
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () =>
        jsonResponse({
          model: 'deepseek-flash',
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'call_2', function: { name: 'memory.retrieve_own', arguments: '{"query":"匣子"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 }
        })) as unknown as typeof fetch,
      retry: noSleep
    })
    const result = await adapter.stream({ messages: [], stream: false }, {})
    expect(result.toolCalls).toHaveLength(1)
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4 })
  })

  it('探测：/models + 流式 + 工具 + JSON mode 全部可用', async () => {
    const calls: string[] = []
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push(String(url))
        if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
        const body = JSON.parse(String(init.body)) as { stream?: boolean; tools?: unknown; response_format?: unknown }
        if (body.tools) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [{ id: 'call_probe', function: { name: 'probe_echo', arguments: '{"text":"ok"}' } }]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })
        }
        if (body.response_format) {
          return jsonResponse({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })
        }
        if (body.stream) return sseResponse(dataLines([{ choices: [{ delta: { content: 'ok' } }] }]))
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
      }) as unknown as typeof fetch,
      retry: noSleep
    })
    const caps = await adapter.probe()
    expect(caps).toEqual(CONFIG.capabilities)
    expect(calls[0]).toContain('/models')
    expect(calls.length).toBe(4)
  })

  it('探测 401 → model_auth 直接抛出，不降级为 false', async () => {
    const adapter = createOpenAiCompatAdapter(CONFIG, {
      fetchImpl: (async () => jsonResponse({ error: { type: 'authentication_error' } }, 401)) as unknown as typeof fetch,
      retry: noSleep
    })
    await expect(adapter.probe()).rejects.toBeInstanceOf(ModelError)
    await expect(adapter.probe()).rejects.toMatchObject({ code: 'model_auth' })
  })
})
