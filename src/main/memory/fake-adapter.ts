import type { Capabilities } from '../../shared/schema/model'
import type { ChatAdapter, ChatRequest, ChatResult, ChatToolCall, StreamHooks } from '../model/adapter'

/**
 * 记忆台的假模型（E2E-MEMORY / 集成测试）。
 *
 * 抽取模式一次给出 14 条确定性提案（含一条「台词写成 objective」用来验证
 * 服务端降级为 claim），quote 全部取自提示词里的定稿原文，保证证据校验通过；
 * 讨论模式只解释，不调用任何写工具。
 *
 * 只在未打包构建 + `NORYTH_MEMORY_FAKE=1` 时使用；生产包不认这个变量。
 */

const BEAT_LINE = /^\[(bt_[A-Za-z0-9_-]+)\]\s*([^：\n]+)：(.*)$/
const CHARACTER_LINE = /^- ([A-Za-z][A-Za-z0-9_-]*)「([^」]+)」卡：/

interface BeatLine {
  beatId: string
  speaker: string
  body: string
}

interface CharacterLine {
  id: string
  name: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function allText(request: ChatRequest): string {
  return request.messages.map((message) => message.content).join('\n')
}

function beatsOf(text: string): BeatLine[] {
  const out: BeatLine[] = []
  for (const line of text.split('\n')) {
    const match = BEAT_LINE.exec(line.trim())
    if (match) out.push({ beatId: match[1]!, speaker: match[2]!.trim(), body: match[3]!.trim() })
  }
  return out
}

function charactersOf(text: string): CharacterLine[] {
  const out: CharacterLine[] = []
  for (const line of text.split('\n')) {
    const match = CHARACTER_LINE.exec(line.trim())
    if (match) out.push({ id: match[1]!, name: match[2]!.trim() })
  }
  return out
}

function toolResults(request: ChatRequest): Set<string> {
  const names = new Set<string>()
  for (const message of request.messages) {
    if (message.role !== 'tool') continue
    const match = /<tool_result tool="([^"]+)"/.exec(message.content)
    if (match) names.add(match[1]!)
  }
  return names
}

function pick(beats: BeatLine[], index: number): BeatLine | null {
  if (beats.length === 0) return null
  return beats[index % beats.length] ?? null
}

interface ProposalItem {
  kind: 'experience' | 'fact' | 'relationship' | 'cognition' | 'belief' | 'world_fact'
  character_id?: string
  text: string
  source_beat_id: string
  evidence_quote: string
  importance: number
  pinned?: boolean
  payload?: Record<string, unknown>
}

/**
 * 14 条固定提案：2 条会被作者拒绝、1 条会被编辑，最终 apply 12 条。
 * 顺序固定，UI 与 E2E 都按插入顺序查找。
 */
export function buildFakeProposals(beats: BeatLine[], characters: CharacterLine[]): ProposalItem[] {
  const first = characters[0]?.id ?? null
  const second = characters[1]?.id ?? first
  const b = (index: number): BeatLine | null => pick(beats, index)
  const items: ProposalItem[] = []
  const push = (item: ProposalItem): void => {
    items.push(item)
  }

  const beat0 = b(0)
  const beat1 = b(1)
  const beat2 = b(2)
  const beat3 = b(3)
  const beat4 = b(4)
  const beat5 = b(5)
  if (!beat0 || !beat1 || !beat2 || !beat3 || !beat4 || !beat5 || first === null) return items

  push({
    kind: 'experience',
    character_id: first,
    text: '在祠堂夜谈里把茶盏推过去，试探对方对黑漆匣子的反应',
    source_beat_id: beat0.beatId,
    evidence_quote: beat0.body,
    importance: 0.6
  })
  push({
    kind: 'belief',
    character_id: first,
    text: '相信账本在祠堂',
    source_beat_id: beat2.beatId,
    evidence_quote: beat2.body,
    importance: 0.9,
    payload: { confidence: 0.7 }
  })
  // 台词写成 objective：服务端必须降级为 claim（台词不是事实）。
  push({
    kind: 'world_fact',
    text: '账本在祠堂（来自角色台词，只能算声称）',
    source_beat_id: beat2.beatId,
    evidence_quote: beat2.body,
    importance: 0.8,
    payload: {
      subject: '账本',
      predicate: '位置',
      object: '祠堂',
      truth: 'objective',
      visibility: 'secret',
      known_by: [first]
    }
  })
  push({
    kind: 'world_fact',
    text: '窗外的雨忽然大了',
    source_beat_id: beat3.beatId,
    evidence_quote: beat3.body,
    importance: 0.3,
    payload: {
      subject: '雨',
      predicate: '强度',
      object: '大了',
      truth: 'objective',
      visibility: 'public',
      known_by: []
    }
  })
  push({
    kind: 'relationship',
    character_id: first,
    text: '对沈昼的信任略有上升：对方没有立刻否认',
    source_beat_id: beat4.beatId,
    evidence_quote: beat4.body,
    importance: 0.7,
    payload: { to_id: second, axis: 'trust', value: 0.45 }
  })
  push({
    kind: 'fact',
    character_id: first,
    text: '知道黑漆匣子里装着什么，却选择不说',
    source_beat_id: beat1.beatId,
    evidence_quote: beat1.body,
    importance: 0.8
  })
  push({
    kind: 'cognition',
    character_id: first,
    text: '意识到对方在回避「匣子里有什么」这个问题',
    source_beat_id: beat3.beatId,
    evidence_quote: beat3.body,
    importance: 0.5
  })
  push({
    kind: 'experience',
    character_id: second!,
    text: '被追问父亲书房里的黑漆匣子',
    source_beat_id: beat0.beatId,
    evidence_quote: beat0.body,
    importance: 0.5
  })
  push({
    kind: 'belief',
    character_id: second!,
    text: '怀疑对方早就知道匣子的下落',
    source_beat_id: beat1.beatId,
    evidence_quote: beat1.body,
    importance: 0.6,
    payload: { confidence: 0.55 }
  })
  push({
    kind: 'fact',
    character_id: second!,
    text: '记得父亲书房里那只黑漆匣子',
    source_beat_id: beat0.beatId,
    evidence_quote: beat0.body,
    importance: 0.6
  })
  push({
    kind: 'cognition',
    character_id: first,
    text: '决定不再追问，先把话压住',
    source_beat_id: beat5.beatId,
    evidence_quote: beat5.body,
    importance: 0.4
  })
  push({
    kind: 'experience',
    character_id: first,
    // 同一条氛围经历被重复抽取（真实模型常见的噪声：标点宽度不同）。
    // 原文不同 → 抽取去重不会合并；NFKC 归一化后相同 → 归档候选。
    text: '在祠堂夜谈里把茶盏推过去,试探对方对黑漆匣子的反应',
    source_beat_id: beat1.beatId,
    evidence_quote: beat1.body,
    importance: 0.2
  })
  push({
    kind: 'world_fact',
    text: '账本的持有人是父亲',
    source_beat_id: beat3.beatId,
    evidence_quote: beat3.body,
    importance: 0.7,
    payload: {
      subject: '账本',
      predicate: '持有人',
      object: '父亲',
      truth: 'objective',
      visibility: 'secret',
      known_by: [second!]
    }
  })
  push({
    kind: 'belief',
    character_id: first,
    text: '怀疑账本被父亲藏在祠堂',
    source_beat_id: beat2.beatId,
    evidence_quote: beat2.body,
    importance: 1,
    pinned: true,
    payload: { confidence: 0.85 }
  })
  return items
}

export interface FakeMemoryModelOptions {
  provider?: string
  model?: string
  chunkDelayMs?: number
}

export class FakeMemoryModelAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  private readonly chunkDelayMs: number

  constructor(options: FakeMemoryModelOptions = {}) {
    this.provider = options.provider ?? 'deepseek'
    this.model = options.model ?? 'deepseek-flash'
    this.chunkDelayMs = options.chunkDelayMs ?? 2
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

  private async streamText(text: string, hooks: StreamHooks, started: number): Promise<ChatResult> {
    let full = ''
    let firstTokenMs: number | null = null
    for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
      full += chunk
      if (firstTokenMs === null) firstTokenMs = Date.now() - started
      hooks.onText?.(chunk, full)
    }
    return {
      text,
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 2_000, completionTokens: 200 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: Date.now() - started,
      firstTokenMs,
      retries: 0
    }
  }

  private toolCall(name: string, args: unknown): ChatToolCall[] {
    return [{ id: `call_${name}_${Date.now().toString(36)}`, name, arguments: JSON.stringify(args) }]
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const started = Date.now()
    const text = allText(request)
    const beats = beatsOf(text)
    const characters = charactersOf(text)
    const results = toolResults(request)
    const tools = (request.tools ?? []).map((tool) => tool.function.name)
    const canCall = (name: string): boolean => tools.length === 0 || tools.includes(name)
    const extracting = text.includes('【本轮任务】记忆固化抽取')

    if (!extracting) {
      return this.streamText(
        [
          '这几条里，「账本在祠堂」来自角色台词，所以只记为她的信念与声称，不能当客观事实。',
          '客观事实只有旁白确认的那条（雨变大了）。',
          '如果你认为某条记错了，可以在角色记忆里标错失效；重建会按定稿重跑。'
        ].join(''),
        hooks,
        started
      )
    }

    if (beats.length < 3 || characters.length === 0) {
      return this.streamText('{"proposals":[]}', hooks, started)
    }

    const items = buildFakeProposals(beats, characters)
    if (!results.has('memory.proposal.submit') && canCall('memory.proposal.submit')) {
      const calls = this.toolCall('memory.proposal.submit', { proposal: { items } })
      hooks.onToolCallDelta?.(calls[0]!, 0)
      return {
        text: '',
        reasoning: '按契约一次提交 14 条固化提案。',
        toolCalls: calls,
        usage: { promptTokens: 2_000, completionTokens: 400 },
        finishReason: 'tool_calls',
        model: this.model,
        latencyMs: Date.now() - started,
        firstTokenMs: null,
        retries: 0
      }
    }

    return this.streamText(JSON.stringify({ proposals: items }), hooks, started)
  }
}

export function createFakeMemoryAdapter(options: FakeMemoryModelOptions = {}): FakeMemoryModelAdapter {
  return new FakeMemoryModelAdapter(options)
}
