import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeLlm, type ChatRequestBody, type FakeReply, type FakeLlmServer } from '../integration/support/fake-llm'

/**
 * 假 LLM 服务器 + fixture（PHASE-10 J1 / DEV-PLAN §13.2）。
 *
 * 与 `tests/integration/support/fake-llm.ts` 的分工：
 * - 那个是「按请求序列脚本化」的底层服务器，单元/集成测试直接传函数；
 * - 这个是「按 agent + beat 匹配 fixture」的上层封装，E2E 与黄金路径用。
 *
 * fixture 用 JSON 而不是 YAML：项目没有 YAML 解析依赖，JSON 能表达同样的字段，
 * 且可以带类型校验。格式见 `tests/fake-llm/fixtures/README.md`：
 *
 * ```json
 * {
 *   "match": { "agent": "planner", "beat": "plan.blueprint", "model": "deepseek-flash" },
 *   "response": {
 *     "stream": ["第一段", "第二段"],
 *     "tool_calls": [{ "tool": "blueprint.propose_patch", "args": { "ops": [] } }],
 *     "usage": { "in": 1800, "out": 420 },
 *     "delay_ms": 5,
 *     "error": { "status": 500, "body": "{\"error\":\"boom\"}" }
 *   }
 * }
 * ```
 */

export interface FakeFixtureToolCall {
  tool: string
  args: Record<string, unknown>
  id?: string
}

export interface FakeFixtureError {
  status: number
  body?: string
}

export interface FakeFixture {
  /** 文件名（不含 .json），仅用于报错与调试。 */
  name?: string
  match: {
    /** 请求里出现 `agent:<name>` 或 `[AGENT:<name>]` 标记时匹配。 */
    agent?: string
    /** 请求里出现 `[BEAT:<beat>]` 标记时匹配。 */
    beat?: string
    model?: string
    /** 任意消息包含该子串时匹配（用于提示词里的固定锚点）。 */
    contains?: string
  }
  response: {
    /** 文本按顺序切片流出；不写则返回空文本。 */
    stream?: string[]
    tool_calls?: FakeFixtureToolCall[]
    /** cached 可选（PHASE-22）：OpenAI/DeepSeek 两种字段形状都能注入。 */
    usage?: { in: number; out: number; cached?: number; cacheField?: 'openai' | 'deepseek' }
    finish_reason?: string
    delay_ms?: number
    error?: FakeFixtureError
  }
  /** 同一 fixture 可重复使用（默认 true）；false 时只匹配一次。 */
  repeat?: boolean
}

export interface FixtureLlmServer extends FakeLlmServer {
  /** 每个请求命中的 fixture 名（未命中为 null）。 */
  matched: Array<string | null>
  /** 未命中的请求体；E2E 断言「没有脚本漏配」。 */
  unmatched: ChatRequestBody[]
}

function textOf(request: ChatRequestBody): string {
  return request.messages.map((message) => message.content).join('\n')
}

export function fixtureMatches(fixture: FakeFixture, request: ChatRequestBody): boolean {
  const text = textOf(request)
  const { match } = fixture
  if (match.model !== undefined && request.model !== match.model) return false
  if (match.agent !== undefined && !text.includes(`agent:${match.agent}`) && !text.includes(`[AGENT:${match.agent}]`)) {
    return false
  }
  if (match.beat !== undefined && !text.includes(`[BEAT:${match.beat}]`)) return false
  if (match.contains !== undefined && !text.includes(match.contains)) return false
  return true
}

function toReply(fixture: FakeFixture): FakeReply {
  const { response } = fixture
  const reply: FakeReply = {}
  if (response.stream !== undefined) reply.text = response.stream.join('')
  if (response.tool_calls !== undefined) {
    reply.toolCalls = response.tool_calls.map((call, index) => ({
      id: call.id ?? `call_${fixture.name ?? 'fixture'}_${index}`,
      name: call.tool,
      args: call.args
    }))
  }
  if (response.usage !== undefined) reply.usage = response.usage
  if (response.finish_reason !== undefined) reply.finishReason = response.finish_reason
  if (response.error !== undefined) {
    reply.httpStatus = response.error.status
    if (response.error.body !== undefined) reply.httpBody = response.error.body
  }
  return reply
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 按 fixture 顺序匹配；第一个命中的赢，同一 fixture 默认可重复。 */
export async function startFixtureLlm(
  fixtures: readonly FakeFixture[],
  options: { model?: string; fallback?: FakeReply } = {}
): Promise<FixtureLlmServer> {
  const matched: Array<string | null> = []
  const unmatched: ChatRequestBody[] = []
  const used = new Set<number>()

  const server = await startFakeLlm(async (request: ChatRequestBody): Promise<FakeReply> => {
    const index = fixtures.findIndex(
      (fixture, candidate) => !used.has(candidate) && fixtureMatches(fixture, request)
    )
    if (index === -1) {
      matched.push(null)
      unmatched.push(request)
      return options.fallback ?? { text: '', usage: { in: 0, out: 0 } }
    }
    const fixture = fixtures[index]!
    const name = fixture.name ?? `fixture_${index}`
    if (fixture.repeat === false) used.add(index)
    matched.push(name)
    if (fixture.response.delay_ms !== undefined && fixture.response.delay_ms > 0) {
      await sleep(fixture.response.delay_ms)
    }
    return toReply(fixture)
  }, options.model ?? 'deepseek-flash')

  return { ...server, matched, unmatched }
}

/** 从目录读 `*.json`（按文件名排序，保证确定性）。 */
export function loadFixtures(dir: string): FakeFixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as FakeFixture
      return { ...raw, name: raw.name ?? name.replace(/\.json$/, '') }
    })
}

/**
 * 能通过 `probe()` 的最小回复：/models 已有；流式回 ok；工具探测回 probe_echo；
 * JSON mode 回 {"ok":true}；其余请求返回一拍合法信封。
 * 设置页「测试连接」的 E2E 与集成测试共用，避免各写一份探测脚本。
 */
export function probeCompatibleReply(request: ChatRequestBody): FakeReply {
  const hasProbeTool = (request.tools ?? []).some((tool) => tool.function.name === 'probe_echo')
  if (hasProbeTool) {
    return { toolCalls: [{ id: 'call_probe', name: 'probe_echo', args: { text: 'ok' } }], usage: { in: 10, out: 4 } }
  }
  if (request.response_format) return { text: '{"ok":true}', usage: { in: 8, out: 4 } }
  const first = request.messages[0]?.content ?? ''
  if (first.trim() === '只回复 ok') return { text: 'ok', usage: { in: 6, out: 2 } }
  return {
    text: JSON.stringify({ body: '雨声压下来，她把账本推过桌面，纸角在灯下泛黄。', grounding: [] }),
    usage: { in: 900, out: 60 }
  }
}

export { startFakeLlm }
export type { ChatRequestBody, FakeLlmServer, FakeReply }
