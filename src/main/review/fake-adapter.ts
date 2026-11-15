import type { Capabilities } from '../../shared/schema/model'
import type { ChatAdapter, ChatRequest, ChatResult, ChatToolCall, StreamHooks } from '../model/adapter'

/**
 * 审批台的假模型适配器（E2E-REVIEW / 集成测试）。
 *
 * 确定性脚本，按提示词里的任务标记与初稿块决定输出：
 *   全量审批 → 2 条阻断（知识越界 / 章纲冲突）+ 3 条建议，先调 T35 再给最终 JSON；
 *   复检     → 无阻断的 pass 报告（维度分保留）；
 *   patch    → 一次 T36 提交 3 条 patch（before 取自初稿块，保证逐字一致）；
 *   讨论     → 自然语言，不调用任何写工具。
 *
 * 只在未打包构建 + `NORYTH_REVIEW_FAKE=1` 时使用；生产包不认这个变量。
 */

const DRAFT_LINE = /^\[(bt_[A-Za-z0-9_-]+)\]\s*([^：\n]+)：(.*)$/

interface DraftLine {
  beatId: string
  speaker: string
  body: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function allText(request: ChatRequest): string {
  return request.messages.map((message) => message.content).join('\n')
}

function draftOf(request: ChatRequest): DraftLine[] {
  const lines = allText(request).split('\n')
  const out: DraftLine[] = []
  for (const line of lines) {
    const match = DRAFT_LINE.exec(line.trim())
    if (!match) continue
    out.push({ beatId: match[1]!, speaker: match[2]!.trim(), body: match[3]!.trim() })
  }
  return out
}

/** 已经返回过哪些工具结果（假模型据此决定下一步）。 */
function toolResults(request: ChatRequest): Set<string> {
  const names = new Set<string>()
  for (const message of request.messages) {
    if (message.role !== 'tool') continue
    const match = /<tool_result tool="([^"]+)"/.exec(message.content)
    if (match) names.add(match[1]!)
  }
  return names
}

function revisionOf(text: string): string | null {
  const match = /当前 revision：(\S+)/.exec(text)
  return match?.[1] && match[1] !== '（无）' ? match[1] : null
}

type Mode = 'report' | 'recheck' | 'patch' | 'discuss'

function modeOf(text: string): Mode {
  if (text.includes('这是 G4 全量审批')) return 'report'
  if (text.includes('这是修订后的复检')) return 'recheck'
  if (text.includes('作者已授权修订（G5）')) return 'patch'
  return 'discuss'
}

function snippet(body: string): string {
  const trimmed = body.trim()
  if ([...trimmed].length <= 60) return trimmed
  return [...trimmed].slice(0, 60).join('')
}

function reportJson(beats: DraftLine[], mode: 'report' | 'recheck'): string {
  const dimensions = {
    character_consistency: mode === 'recheck' ? 4 : 3,
    plot_logic: mode === 'recheck' ? 4 : 2,
    outline_alignment: mode === 'recheck' ? 4 : 4,
    prose: 3
  }
  if (mode === 'recheck') {
    return JSON.stringify({
      verdict: 'pass_with_notes',
      blocking: [],
      suggestions: beats[1]
        ? [
            {
              issue_id: 'iss_r1',
              type: 'prose',
              beat_id: beats[1].beatId,
              evidence: '',
              why: '复检范围内没有发现硬问题；这一拍节奏仍偏慢。',
              suggestion: '可以再删一句过渡。'
            }
          ]
        : [],
      dimensions
    })
  }
  const blocking: unknown[] = []
  if (beats[0]) {
    blocking.push({
      issue_id: 'iss_01',
      type: 'knowledge_leak',
      beat_id: beats[0].beatId,
      evidence: snippet(beats[0].body),
      why: '这一拍让角色说出了本章尚未揭示的信息（账本位置）。',
      suggestion: '改成试探性问法，不点明位置。'
    })
  }
  if (beats[2]) {
    blocking.push({
      issue_id: 'iss_02',
      type: 'outline_conflict',
      beat_id: beats[2].beatId,
      evidence: snippet(beats[2].body),
      why: '章纲要求这一拍只铺垫，不与对方正面冲突。',
      suggestion: '把冲突推迟到下一场。'
    })
  }
  const suggestions: unknown[] = []
  if (beats[1]) {
    suggestions.push({
      issue_id: 'iss_03',
      type: 'voice',
      beat_id: beats[1].beatId,
      evidence: '',
      why: '两个角色的句长接近，声音区分度不足。',
      suggestion: '给其中一人固定一个短句口头禅。'
    })
  }
  if (beats[0]) {
    suggestions.push({
      issue_id: 'iss_04',
      type: 'prose',
      beat_id: beats[0].beatId,
      evidence: '',
      why: '「把茶盏推过去」与前文重复。',
      suggestion: '换一个动作细节。'
    })
  }
  if (beats[2]) {
    suggestions.push({
      issue_id: 'iss_05',
      type: 'pacing',
      beat_id: beats[2].beatId,
      evidence: '',
      why: '三拍连续对话，缺少环境描写。',
      suggestion: '插入一句雨声。'
    })
  }
  return JSON.stringify({ verdict: 'fail', blocking, suggestions, dimensions })
}

export interface FakeReviewModelOptions {
  provider?: string
  model?: string
  chunkDelayMs?: number
}

export class FakeReviewModelAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  private readonly chunkDelayMs: number

  constructor(options: FakeReviewModelOptions = {}) {
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

  private toolCall(name: string, args: unknown): ChatResult['toolCalls'] {
    return [{ id: `call_${name}_${Date.now().toString(36)}`, name, arguments: JSON.stringify(args) }]
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const started = Date.now()
    const text = allText(request)
    const mode = modeOf(text)
    const beats = draftOf(request)
    const results = toolResults(request)
    const revisionId = revisionOf(text)
    const tools = (request.tools ?? []).map((tool) => tool.function.name)
    const canCall = (name: string): boolean => tools.length === 0 || tools.includes(name)

    // 审批/复检：先跑确定性检查，再提交报告，最后给同一份 JSON（PRD §5.3 不允许跳过检查直接 pass）。
    if ((mode === 'report' || mode === 'recheck') && beats.length >= 3) {
      if (!results.has('report.submit')) {
        if (revisionId && canCall('consistency.check') && !results.has('consistency.check')) {
          const call: ChatToolCall = this.toolCall('consistency.check', { revision_id: revisionId })[0]!
          hooks.onToolCallDelta?.(call, 0)
          return {
            text: '',
            reasoning: '先做确定性检查，再给报告。',
            toolCalls: [call],
            usage: { promptTokens: 2_000, completionTokens: 80 },
            finishReason: 'tool_calls',
            model: this.model,
            latencyMs: Date.now() - started,
            firstTokenMs: null,
            retries: 0
          }
        }
        if (canCall('report.submit')) {
          const call: ChatToolCall = this.toolCall('report.submit', {
            report: JSON.parse(reportJson(beats, mode)) as unknown
          })[0]!
          hooks.onToolCallDelta?.(call, 0)
          return {
            text: '',
            reasoning: '按契约提交报告，再给出同一份 JSON。',
            toolCalls: [call],
            usage: { promptTokens: 2_000, completionTokens: 120 },
            finishReason: 'tool_calls',
            model: this.model,
            latencyMs: Date.now() - started,
            firstTokenMs: null,
            retries: 0
          }
        }
      }
      return this.streamText(reportJson(beats, mode), hooks, started)
    }

    if (mode === 'patch' && beats.length >= 3) {
      if (!results.has('patch.propose') && canCall('patch.propose')) {
        const patches = beats.slice(0, 3).map((beat, index) => ({
          beat_id: beat.beatId,
          before: beat.body,
          after: `${beat.body}（改：把话说得更含糊，不点明账本）`,
          reason: `第 ${index + 1} 条按报告修订：避开越界与章纲冲突`,
          issue_ref: index === 0 ? 'iss_01' : index === 1 ? 'iss_02' : 'iss_03'
        }))
        const call: ChatToolCall = this.toolCall('patch.propose', { patches })[0]!
        hooks.onToolCallDelta?.(call, 0)
        return {
          text: '',
          reasoning: '按报告给 3 条可逐条接受的 patch。',
          toolCalls: [call],
          usage: { promptTokens: 2_000, completionTokens: 160 },
          finishReason: 'tool_calls',
          model: this.model,
          latencyMs: Date.now() - started,
          firstTokenMs: null,
          retries: 0
        }
      }
      return this.streamText('已按报告提交 3 条 patch 提案，请逐条接受或拒绝。', hooks, started)
    }

    return this.streamText(
      [
        '第 1 条阻断是知识越界：那一拍把账本位置说破了，建议改成试探。',
        '第 2 条是章纲冲突：这一场只需要铺垫，不需要摊牌。',
        '第 3–5 条是建议，可以不改；如果要动，先授权修订我出 patch。'
      ].join(''),
      hooks,
      started
    )
  }
}

export function createFakeReviewAdapter(options: FakeReviewModelOptions = {}): FakeReviewModelAdapter {
  return new FakeReviewModelAdapter(options)
}
