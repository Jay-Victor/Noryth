import type { Capabilities } from '../../shared/schema/model'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../model/adapter'

/**
 * 创作台的假模型适配器（E2E-WRITE / 集成测试）。
 *
 * 与切片假适配器同契约：流式推 body，最终答复是 `{body, grounding}` JSON。
 * 正文按「本拍意图」确定性地生成，重生成换一句；意图含「拒演」时先调 T41。
 *
 * 只在未打包构建 + `NORYTH_WRITE_FAKE=1` 时使用；生产包不认这个变量。
 */

const INTENT_MARKER = '本拍意图：'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageText(request: ChatRequest): string {
  return request.messages.map((message) => message.content).join('\n')
}

function intentOf(request: ChatRequest): string {
  const text = messageText(request)
  const marker = text.lastIndexOf(INTENT_MARKER)
  if (marker === -1) return ''
  return text.slice(marker + INTENT_MARKER.length).split('\n')[0]!.trim()
}

export interface FakeWriteModelOptions {
  provider?: string
  model?: string
  chunkDelayMs?: number
}

export class FakeWriteModelAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  private readonly chunkDelayMs: number
  private readonly attempts = new Map<string, number>()

  constructor(options: FakeWriteModelOptions = {}) {
    this.provider = options.provider ?? 'deepseek'
    this.model = options.model ?? 'deepseek-flash'
    this.chunkDelayMs = options.chunkDelayMs ?? 4
  }

  async probe(): Promise<Capabilities> {
    return this.capabilities()
  }

  capabilities(): Capabilities {
    return {
      stream: true,
      tools: true,
      jsonMode: true,
      contextWindow: 64_000,
      maxOutput: 8_192,
      pricing: { in: 0, out: 0 }
    }
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const started = Date.now()
    const intent = intentOf(request)
    const attempt = this.attempts.get(intent) ?? 0
    this.attempts.set(intent, attempt + 1)
    const hasToolResult = request.messages.some((message) => message.role === 'tool')

    if (intent.includes('拒演') && !hasToolResult) {
      const call = {
        id: `fake_refusal_${attempt}`,
        name: 'refusal.raise',
        arguments: JSON.stringify({ code: 'out_of_character', reason: '她不会在此时承认自己知道账本' })
      }
      hooks.onToolCallDelta?.(call, 0)
      return {
        text: '',
        reasoning: '这一拍与角色卡冲突，先拒演。',
        toolCalls: [call],
        usage: { promptTokens: 400, completionTokens: 20 },
        finishReason: 'tool_calls',
        model: this.model,
        latencyMs: Date.now() - started,
        firstTokenMs: null,
        retries: 0
      }
    }

    const body = `${intent || '继续' }（第 ${attempt + 1} 版）。她把茶盏往他那边推了推，声音压得很低，像是怕被窗外的雨听见。`
    let full = ''
    let firstTokenMs: number | null = null
    for (const chunk of body.match(/[\s\S]{1,4}/g) ?? []) {
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
      full += chunk
      if (firstTokenMs === null) firstTokenMs = Date.now() - started
      hooks.onText?.(chunk, full)
    }

    return {
      text: JSON.stringify({ body, grounding: [] }),
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 1_000, completionTokens: 90 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: Date.now() - started,
      firstTokenMs,
      retries: 0
    }
  }
}

export function createFakeWriteAdapter(options: FakeWriteModelOptions = {}): FakeWriteModelAdapter {
  return new FakeWriteModelAdapter(options)
}
