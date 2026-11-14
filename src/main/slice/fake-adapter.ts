import type { Capabilities } from '../../shared/schema/model'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../model/adapter'
import type { SliceFakeBeat, SliceFixture } from './fixture'

/**
 * 开发切片的假模型适配器（PHASE-05 §2.1 / §3）。
 *
 * 严格走真实 ChatAdapter 契约：流式逐块推 body、可注入一次工具调用、
 * 产出与真模型同形的 JSON 最终答复。不做「简化信封」——否则切片跑通
 * 不能证明真实链路可跑。
 *
 * 只由未打包构建的 SliceService 使用；测试直接从
 * `tests/fixtures/slice/fake-adapter.ts` 复用它。
 */

const INTENT_MARKER = '本拍意图：'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageText(request: ChatRequest): string {
  return request.messages.map((message) => message.content).join('\n')
}

function scriptFor(scripts: readonly SliceFakeBeat[], request: ChatRequest): SliceFakeBeat {
  const text = messageText(request)
  const marker = text.lastIndexOf(INTENT_MARKER)
  const intentLine = marker === -1 ? '' : text.slice(marker + INTENT_MARKER.length).split('\n')[0]!.trim()
  const matched = scripts.find((script) => intentLine.startsWith(script.intent))
  return matched ?? scripts[0]!
}

function isRetryRequest(request: ChatRequest): boolean {
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
  return lastUser?.content.includes('上一次答复未通过校验') === true
}

export interface FakeSliceModelOptions {
  fixture: SliceFixture
  provider?: string
  model?: string
  /** 每个流式分片之间的延迟；强杀测试把它调大。 */
  chunkDelayMs?: number
  /** 注入无效 grounding：每次最终答复都伪造（用于拒绝路径）。 */
  forceInvalidGrounding?: boolean
}

export class FakeSliceModelAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  private readonly scripts: readonly SliceFakeBeat[]
  private readonly chunkDelayMs: number
  private readonly attempts = new Map<string, number>()

  constructor(private readonly options: FakeSliceModelOptions) {
    this.provider = options.provider ?? 'deepseek'
    this.model = options.model ?? 'deepseek-flash'
    this.scripts = options.fixture.fakeModel.beats
    this.chunkDelayMs = options.chunkDelayMs ?? 8
  }

  async probe(): Promise<Capabilities> {
    return this.capabilities()
  }

  /** job 创建时同步冻结能力；与 probe() 同源。 */
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

  /** 已经完整生成过几次（重生成换下一句）；测试断言用。 */
  completionsOf(intent: string): number {
    return this.attempts.get(intent) ?? 0
  }

  resetAttempts(): void {
    this.attempts.clear()
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const started = Date.now()
    const script = scriptFor(this.scripts, request)
    const hasToolResult = request.messages.some((message) => message.role === 'tool')
    const retry = isRetryRequest(request)

    if (script.toolCall && request.tools !== undefined && request.tools.length > 0 && !hasToolResult) {
      const call = {
        id: `fake_call_${script.intent.length}_${this.attempts.get(script.intent) ?? 0}`,
        name: script.toolCall.name,
        arguments: JSON.stringify(script.toolCall.args)
      }
      hooks.onToolCallDelta?.(call, 0)
      return {
        text: '',
        reasoning: '先查自己记得什么，再开口。',
        toolCalls: [call],
        usage: { promptTokens: 600, completionTokens: 20 },
        finishReason: 'tool_calls',
        model: this.model,
        latencyMs: Date.now() - started,
        firstTokenMs: null,
        retries: 0
      }
    }

    const attempt = this.attempts.get(script.intent) ?? 0
    if (!retry) this.attempts.set(script.intent, attempt + 1)
    const body = script.bodies[Math.min(retry ? Math.max(0, attempt - 1) : attempt, script.bodies.length - 1)]!

    let full = ''
    let firstTokenMs: number | null = null
    for (const chunk of body.match(/[\s\S]{1,3}/g) ?? []) {
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
      full += chunk
      if (firstTokenMs === null) firstTokenMs = Date.now() - started
      hooks.onText?.(chunk, full)
    }

    if (this.options.forceInvalidGrounding) {
      return this.finalResult(
        JSON.stringify({
          body,
          grounding: [{ type: 'memory', id: 'mem_forged', quote: '不存在的记忆' }]
        }),
        started,
        firstTokenMs
      )
    }

    return this.finalResult(
      JSON.stringify({ body, grounding: script.grounding }),
      started,
      firstTokenMs
    )
  }

  private finalResult(text: string, started: number, firstTokenMs: number | null): ChatResult {
    return {
      text,
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 1_200, completionTokens: 80 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: Date.now() - started,
      firstTokenMs,
      retries: 0
    }
  }
}

export function createFakeSliceAdapter(options: FakeSliceModelOptions): FakeSliceModelAdapter {
  return new FakeSliceModelAdapter(options)
}
