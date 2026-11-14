import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 假 LLM 服务器（DEV-PLAN §13.2 / PHASE-04 J1）。
 *
 * - 按请求顺序返回脚本化响应，同一脚本同一请求序列输出完全一致；
 * - 支持流式正文、reasoning、工具调用分片、usage、错误注入；
 * - 不调用真实 API，CI 与本地测试都跑它。
 */

export interface FakeToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface FakeReply {
  text?: string
  reasoning?: string
  toolCalls?: FakeToolCall[]
  usage?: { in: number; out: number }
  finishReason?: string
  /** 注入 HTTP 错误（不进入协议）。 */
  httpStatus?: number
  httpBody?: string
}

export type FakeReplyFactory = (request: ChatRequestBody, index: number) => FakeReply | Promise<FakeReply>

export interface ChatRequestBody {
  model: string
  stream?: boolean
  messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }>
  tools?: Array<{ type: string; function: { name: string } }>
  response_format?: unknown
  tool_choice?: string
}

export interface FakeLlmServer {
  baseUrl: string
  requests: ChatRequestBody[]
  close: () => Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sseWrite(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function streamReply(response: ServerResponse, reply: FakeReply, model: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const text = reply.text ?? ''
  const chunks = text.match(/[\s\S]{1,3}/g) ?? []
  for (const chunk of chunks) {
    sseWrite(response, { model, choices: [{ delta: { content: chunk } }] })
  }
  if (reply.reasoning) {
    sseWrite(response, { model, choices: [{ delta: { reasoning_content: reply.reasoning } }] })
  }
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    const args = JSON.stringify(call.args)
    const split = Math.max(1, Math.floor(args.length / 2))
    sseWrite(response, {
      model,
      choices: [
        {
          delta: {
            tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: args.slice(0, split) } }]
          }
        }
      ]
    })
    sseWrite(response, {
      model,
      choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(split) } }] } }]
    })
  }
  const finish = reply.finishReason ?? ((reply.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop')
  sseWrite(response, { model, choices: [{ delta: {}, finish_reason: finish }] })
  if (reply.usage) {
    sseWrite(response, {
      model,
      choices: [],
      usage: { prompt_tokens: reply.usage.in, completion_tokens: reply.usage.out }
    })
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

function jsonReply(response: ServerResponse, reply: FakeReply, model: string): void {
  writeJson(response, 200, {
    model,
    choices: [
      {
        message: {
          content: reply.text ?? '',
          ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
          ...(reply.toolCalls && reply.toolCalls.length > 0
            ? {
                tool_calls: reply.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }))
              }
            : {})
        },
        finish_reason: reply.finishReason ?? ((reply.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop')
      }
    ],
    ...(reply.usage ? { usage: { prompt_tokens: reply.usage.in, completion_tokens: reply.usage.out } } : {})
  })
}

export async function startFakeLlm(reply: FakeReplyFactory, model = 'deepseek-flash'): Promise<FakeLlmServer> {
  const requests: ChatRequestBody[] = []
  let counter = 0

  const server: Server = createServer(async (request, response) => {
    const url = request.url ?? ''
    if (request.method === 'GET' && url.endsWith('/models')) {
      writeJson(response, 200, { data: [{ id: model }] })
      return
    }
    if (request.method !== 'POST' || !url.endsWith('/chat/completions')) {
      writeJson(response, 404, { error: { message: 'not found' } })
      return
    }

    const raw = await readBody(request)
    let body: ChatRequestBody
    try {
      body = JSON.parse(raw) as ChatRequestBody
    } catch {
      writeJson(response, 400, { error: { message: 'invalid json' } })
      return
    }
    requests.push(body)
    const index = counter
    counter += 1
    const replyValue = await reply(body, index)
    if (replyValue.httpStatus !== undefined) {
      response.writeHead(replyValue.httpStatus, { 'content-type': 'application/json' })
      response.end(replyValue.httpBody ?? JSON.stringify({ error: { message: 'injected' } }))
      return
    }
    if (body.stream) {
      streamReply(response, replyValue, model)
    } else {
      jsonReply(response, replyValue, model)
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
