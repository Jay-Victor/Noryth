import type { Capabilities } from '../../shared/schema/model'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../model/adapter'
import { ModelError } from '../model/adapter'

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

// ── 长文本模式（PHASE-24 E2E-M2-A / M2-SMOKE） ───────────────────────────────
//
// 10 万字长跑需要每拍 ≥150 字，且不同角色要有不同的句长 / 口头禅（否则声音
// 区分度必然为 0）。角色卡在 L2 里以「角色：<名字>」出现，这里按名字选风格；
// 正文不换行、不含全角冒号，保证审批/记忆的 `[bt_x] 说话人：正文` 行解析稳定。

const CHARACTER_NAME = /^角色：(.+)$/m
const LONG_TARGETS = [150, 156, 162, 168, 174]
const NARRATOR_TARGET = 172

const NAME_STYLE: Record<string, number> = { 沈昼: 0, 沈砚: 1, 周叙: 2, 柳七: 3, 管事: 4 }

const STYLE_SENTENCES: readonly (readonly string[])[] = [
  // 0 沈昼：短句，句号密集，几乎不用「我」。
  [
    '她把茶盏推开。',
    '雨点砸在瓦上。',
    '他不说话。',
    '灯芯爆了一下。',
    '她把袖口攥紧。',
    '堂屋很冷。',
    '香灰落在供桌前。',
    '窗外有人走过。',
    '她低头看自己的鞋尖。',
    '门轴响了一声。',
    '她把手收进袖子里。',
    '烛火晃了晃。'
  ],
  // 1 沈砚：短问句为主，第一人称多。
  [
    '我问他那本账去了哪里？',
    '他抬眼，没有答？',
    '我听见雨声更密了？',
    '你呢，你怕什么？',
    '我只看见半页纸？',
    '他为什么不肯说？',
    '我把伞放在门边？',
    '那匣子是谁锁上的？'
  ],
  // 2 周叙：中等长度，逗号分句。
  [
    '他把伞靠在门边，雨水顺着伞骨一滴滴落下来。',
    '祠堂里的灯只剩一盏，光晕落在供桌的边角上。',
    '她没有回头，只把手指按在桌沿，像是在数木纹。',
    '外头的风把门缝吹得很响，谁都没有先开口说话。',
    '他想起白天的那句话，觉得喉咙里堵着一团湿棉花。',
    '雨停在半空里，又被风推着斜斜地落下来。'
  ],
  // 3 柳七：长句，回忆与比喻多。
  [
    '她想起很多年前也是这样的雨夜，父亲坐在灯下，一页一页地翻那本旧账，指节被纸边磨得发白。',
    '屋檐的水连成一条细线，落在青石板上碎开，像谁把一整夜的沉默都摔在了地上。',
    '他忽然明白自己一直站在门外，屋里的人早就把话说完了，只剩下灯芯还在替他们熬着。',
    '风从巷口绕进来，带着潮湿的草木气味，把供桌上的香灰吹成一小片灰白的雾。'
  ],
  // 4 管事：更长的铺陈，带口头禅「说来也怪」。
  [
    '说来也怪，这宅子里的人一到下雨天就都不爱说话，连走路都放轻了脚步，像是怕惊动楼上那位多年不出门的老太爷。',
    '供桌前的烛火烧到一半，烛泪顺着铜台淌下来，凝成一小截歪歪扭扭的白，倒比活人更像个守夜的样子。',
    '他把账本翻到最后一页，又合上，手指在封皮上停了很久，像在等一个不会来的名字自己浮出来。'
  ]
]

const NARRATOR_SENTENCES: readonly string[] = [
  '雨从傍晚下到现在，祠堂的檐角挂着一线水，落在石阶上，溅起很细的白。',
  '供桌上的灯芯烧得低了，光只照见半张桌面，另一半沉在暗里。',
  '门被推开一条缝，风先进来，把香灰吹得往门槛那边散开。',
  '两个人隔着一张桌子坐着，谁也没有先动面前的茶。',
  '巷子深处传来一声犬吠，很快又被雨声压了下去。',
  '窗纸被风顶得鼓起来，又慢慢贴回去，发出一声很轻的响。'
]

function styleIndexFor(name: string): number {
  const fixed = NAME_STYLE[name]
  if (fixed !== undefined) return fixed
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 997
  return hash % STYLE_SENTENCES.length
}

function fillTo(target: number, sentences: readonly string[], seed: number): string {
  let out = ''
  let index = seed % sentences.length
  while ([...out].length < target) {
    out += sentences[index % sentences.length]
    index += 1
  }
  return out
}

/**
 * 长正文：`<意图>（第 N 版）。<风格化正文>`。
 * 前缀保证同一章内每拍唯一；版本号保证重生成换文本。
 */
function longBodyOf(request: ChatRequest, intent: string, attempt: number): string {
  const text = messageText(request)
  const name = CHARACTER_NAME.exec(text)?.[1]?.trim() ?? ''
  const version = `（第 ${attempt + 1} 版）。`
  const prefix = intent.length > 0 ? `${intent}。` : ''
  if (name.length === 0) {
    return `${prefix}${version}${fillTo(NARRATOR_TARGET, NARRATOR_SENTENCES, attempt)}`
  }
  const style = styleIndexFor(name)
  const seed = attempt + style * 3 + name.length
  return `${prefix}${version}${fillTo(LONG_TARGETS[style]!, STYLE_SENTENCES[style]!, seed)}`
}


export interface FakeWriteModelOptions {
  provider?: string
  model?: string
  chunkDelayMs?: number
  /** 模拟供应商报告的缓存命中（PHASE-22 E2E）；省略 = 未报告。 */
  cachedTokens?: number | null
  /** 长文本模式（PHASE-24）：每拍 ≥150 字、按角色分风格。 */
  longMode?: boolean
}

export class FakeWriteModelAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  private readonly chunkDelayMs: number
  private readonly cachedTokens: number | null
  private readonly longMode: boolean
  private readonly attempts = new Map<string, number>()

  constructor(options: FakeWriteModelOptions = {}) {
    this.provider = options.provider ?? 'deepseek'
    this.model = options.model ?? 'deepseek-flash'
    this.chunkDelayMs = options.chunkDelayMs ?? 4
    this.cachedTokens = options.cachedTokens ?? null
    this.longMode = options.longMode ?? false
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

    const body = this.longMode
      ? longBodyOf(request, intent, attempt)
      : `${intent || '继续' }（第 ${attempt + 1} 版）。她把茶盏往他那边推了推，声音压得很低，像是怕被窗外的雨听见。`
    let full = ''
    let firstTokenMs: number | null = null
    for (const chunk of body.match(/[\s\S]{1,4}/g) ?? []) {
      // 与真实适配器同契约：取消（AbortSignal）后立即停止，不再提交结果。
      if (request.signal?.aborted) {
        throw new ModelError('model_error', 'aborted', { aborted: true })
      }
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
      full += chunk
      if (firstTokenMs === null) firstTokenMs = Date.now() - started
      hooks.onText?.(chunk, full)
    }
    if (request.signal?.aborted) {
      throw new ModelError('model_error', 'aborted', { aborted: true })
    }

    return {
      text: JSON.stringify({ body, grounding: [] }),
      reasoning: '',
      toolCalls: [],
      usage: {
        promptTokens: 1_000,
        completionTokens: 90,
        ...(this.cachedTokens === null ? {} : { cachedTokens: this.cachedTokens })
      },
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
