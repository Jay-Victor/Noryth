import type { ChatAdapter, ChatRequest, ChatResult, ChatToolCall, StreamHooks } from '../model/adapter'
import { ModelError } from '../model/adapter'
import type { Capabilities } from '../../shared/schema/model'

/**
 * E2E / 集成测试用的规划 Agent 假适配器（`NORYTH_PLAN_FAKE=1`，未打包构建）。
 *
 * 行为固定：
 * - 第一轮（历史里没有 tool 结果）发出两个提案：整棵蓝图 + 5 人注册清单；
 * - 第二轮（已有 tool 结果）给出自然语言总结。
 *
 * 它走真实的工具管道与提案表，不是给 UI 塞假数据；CI 不调用真实 API。
 */

const CAPABILITIES: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 4_096,
  pricing: { in: 0, out: 0 }
}

const BLUEPRINT_OPS = [
  {
    op: 'add',
    parent_id: null,
    ref: 'main',
    kind: 'main',
    ord: 0,
    title: '主线：黑漆匣子',
    content: '一封遗书牵出账本，账本牵出祠堂供桌下的黑漆匣子。'
  },
  {
    op: 'add',
    parent_id: null,
    parent_ref: 'main',
    ref: 'vol1',
    kind: 'volume',
    ord: 0,
    title: '第一卷 · 黑漆匣子',
    content: '沈昼替人写遗书，发现父亲留下的账本缺了最后一页。'
  },
  {
    op: 'add',
    parent_id: null,
    parent_ref: 'vol1',
    ref: 'ch1',
    kind: 'chapter',
    ord: 0,
    title: '第一章 祠堂夜谈',
    content: '雨夜，沈昼在祠堂试探沈砚，第一次听见「黑漆匣子」。'
  },
  {
    op: 'add',
    parent_id: null,
    parent_ref: 'vol1',
    ref: 'ch2',
    kind: 'chapter',
    ord: 1,
    title: '第二章 旧账最后一页',
    content: '沈昼从穆掌柜手里拿到旧账最后一页，确认父亲死因另有隐情。'
  }
]

const ROSTER = {
  characters: [
    {
      name: '沈昼',
      card: {
        identity: '替人写遗书的年轻女子，沈家旁支',
        appearance: '常穿灰蓝旗袍，袖口有墨迹',
        voice: {
          sentence_length: '短句为主，追问时更短',
          catchphrase: '「我只问一句。」',
          address_habit: '称长辈用「您」，称沈砚「二叔」',
          banned_words: '「命运」「注定」'
        },
        want: '查清父亲真正的死因',
        fear: '发现自己也是共犯',
        taboo: '不在祠堂提母亲的名字',
        initial_relationships: '沈砚是她唯一愿意求助的长辈',
        initial_known: '父亲留下账本，最后一页缺失',
        initial_unknown: '匣子的第三把钥匙在谁手里'
      }
    },
    {
      name: '沈砚',
      card: {
        identity: '沈家账房，沈昼的二叔',
        appearance: '清瘦，常年穿深色长衫',
        voice: {
          sentence_length: '句子偏长，喜欢绕开正面回答',
          catchphrase: '「账上不是这么写的。」',
          address_habit: '称沈昼「阿昼」，称老太爷「父亲」',
          banned_words: '「匣子」'
        },
        want: '保住沈家的体面',
        fear: '账本落到外人手里',
        taboo: '不谈父亲的死',
        initial_relationships: '对沈昼有愧疚，但更怕家族败落',
        initial_known: '匣子确实存在，钥匙不止一把',
        initial_unknown: '沈昼已经见过旧账最后一页'
      }
    },
    {
      name: '穆掌柜',
      card: {
        identity: '旧书店掌柜，替人保管过账本',
        appearance: '圆脸，手上常年有旧纸的味道',
        voice: {
          sentence_length: '短句，爱用生意人的比喻',
          catchphrase: '「买卖归买卖。」',
          address_habit: '称客人「您」，称沈砚「沈二爷」',
          banned_words: '「官府」'
        },
        want: '把旧账脱手，不再惹麻烦',
        fear: '被沈家灭口',
        taboo: '不提账本最后一页的下落',
        initial_relationships: '欠沈父一个人情',
        initial_known: '账本最后一页被人撕走',
        initial_unknown: '撕页的人是谁'
      }
    },
    {
      name: '沈老太爷',
      card: {
        identity: '沈家家主，沈昼的祖父',
        appearance: '白发，拄乌木拐杖',
        voice: {
          sentence_length: '长句，慢，常停顿',
          catchphrase: '「家里的事，家里了。」',
          address_habit: '直呼晚辈全名',
          banned_words: '「遗书」'
        },
        want: '让沈家安稳过冬',
        fear: '旧事重提',
        taboo: '不提祠堂供桌',
        initial_relationships: '对沈昼既疼爱又防备',
        initial_known: '匣子里不是账本',
        initial_unknown: '沈昼已经开始查账'
      }
    },
    {
      name: '阿棠',
      card: {
        identity: '沈家丫鬟，祠堂的日常看管人',
        appearance: '总系一条洗得发白的头绳',
        voice: {
          sentence_length: '短句，答话前会先看一眼门口',
          catchphrase: '「我什么都没看见。」',
          address_habit: '称沈昼「大小姐」，称沈砚「二老爷」',
          banned_words: '「祠堂」'
        },
        want: '攒够钱赎身回乡下',
        fear: '被赶出沈家',
        taboo: '不说夜里谁进过祠堂',
        initial_relationships: '和沈昼亲近，但不敢多嘴',
        initial_known: '有人在雨夜进过祠堂',
        initial_unknown: '那个人是不是沈砚'
      }
    }
  ],
  initial_facts: [
    { subject: '黑漆匣子', predicate: '位置', object: '祠堂供桌下面', visibility: 'secret' },
    { subject: '黑漆匣子', predicate: '钥匙数', object: '三把', visibility: 'secret' },
    { subject: '沈家', predicate: '所在地', object: '江南临水镇', visibility: 'public' },
    { subject: '沈昼', predicate: '职业', object: '替人写遗书', visibility: 'public' },
    { subject: '沈砚', predicate: '身份', object: '沈家账房', visibility: 'public' },
    { subject: '穆掌柜', predicate: '身份', object: '旧书店掌柜', visibility: 'public' },
    { subject: '账本', predicate: '状态', object: '最后一页被撕走', visibility: 'secret' },
    { subject: '沈父', predicate: '死因', object: '族谱记为病故，实际存疑', visibility: 'secret' }
  ]
}

const FINAL_TEXT = [
  '我先给出了一版可执行的蓝图与角色清单，都放在右侧提案里。',
  '主线只保留一条：黑漆匣子；第一卷拆两章，第一章负责「听见」，第二章负责「拿到」。',
  '角色卡里我把 voice 四项都写满了；你可以直接改动机，再确认 G1。',
  '如果第一章太快，我可以把穆掌柜提前，但那样第二章的「旧账」就要换一个来源。'
].join('\n')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function hasToolResult(request: ChatRequest): boolean {
  return request.messages.some((message) => message.role === 'tool')
}

export class FakePlannerAdapter implements ChatAdapter {
  readonly provider = 'deepseek'
  readonly model = 'planner-fake'

  constructor(private readonly chunkDelayMs = 4) {}

  async probe(): Promise<Capabilities> {
    return CAPABILITIES
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const started = Date.now()
    if (request.signal?.aborted) {
      throw new ModelError('model_error', 'aborted', { aborted: true })
    }

    if (!hasToolResult(request)) {
      const calls: ChatToolCall[] = [
        { id: 'call_bp_1', name: 'blueprint.propose_patch', arguments: JSON.stringify({ ops: BLUEPRINT_OPS }) },
        { id: 'call_roster_1', name: 'roster.propose', arguments: JSON.stringify({ roster: ROSTER }) }
      ]
      for (const call of calls) {
        hooks.onToolCallDelta?.(call, calls.indexOf(call))
      }
      return {
        text: '',
        reasoning: '先把结构落到提案里，等作者应用后再讨论细节。',
        toolCalls: calls,
        usage: { promptTokens: 900, completionTokens: 180 },
        finishReason: 'tool_calls',
        model: this.model,
        latencyMs: Date.now() - started,
        firstTokenMs: 1,
        retries: 0
      }
    }

    let full = ''
    for (const chunk of FINAL_TEXT.match(/.{1,12}/gs) ?? [FINAL_TEXT]) {
      if (request.signal?.aborted) {
        throw new ModelError('model_error', 'aborted', { aborted: true })
      }
      full += chunk
      hooks.onText?.(chunk, full)
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
    }
    return {
      text: full,
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 1200, completionTokens: 220 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: Date.now() - started,
      firstTokenMs: 1,
      retries: 0
    }
  }
}
