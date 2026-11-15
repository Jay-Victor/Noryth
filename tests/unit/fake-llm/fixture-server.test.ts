import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureMatches, loadFixtures, startFixtureLlm, type FakeFixture } from '../../fake-llm/server'

const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close()
})

const FIXTURES: FakeFixture[] = [
  {
    name: 'planner',
    match: { agent: 'planner', beat: 'plan.blueprint' },
    response: {
      stream: ['第一段\n', '第二段\n'],
      tool_calls: [{ tool: 'blueprint.propose_patch', args: { ops: [] } }],
      usage: { in: 1800, out: 420 }
    }
  },
  {
    name: 'once',
    match: { model: 'qwen-plus' },
    response: { error: { status: 429, body: '{"error":"limited"}' } },
    repeat: false
  }
]

/** 把 SSE 文本还原成拼接后的正文与工具名，避免被 1–3 字切片干扰。 */
function parseSse(raw: string): { text: string; tools: string[]; usage: { in: number; out: number } | null } {
  let text = ''
  const tools: string[] = []
  let usage: { in: number; out: number } | null = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
    const payload = JSON.parse(line.slice(6)) as {
      choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> } }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    const delta = payload.choices?.[0]?.delta
    if (delta?.content) text += delta.content
    for (const call of delta?.tool_calls ?? []) {
      if (call.function?.name) tools.push(call.function.name)
    }
    if (payload.usage) usage = { in: payload.usage.prompt_tokens, out: payload.usage.completion_tokens }
  }
  return { text, tools, usage }
}

async function chat(baseUrl: string, model: string, content: string, stream = true): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content }] })
  })
  return response.text()
}

describe('假 LLM fixture（J1）', () => {
  it('按 agent + beat 匹配，流出文本、工具调用与 usage', async () => {
    const server = await startFixtureLlm(FIXTURES)
    servers.push(server)
    const parsed = parseSse(await chat(server.baseUrl, 'deepseek-flash', 'agent:planner [BEAT:plan.blueprint]'))
    expect(parsed.text).toBe('第一段\n第二段\n')
    expect(parsed.tools).toEqual(['blueprint.propose_patch'])
    expect(parsed.usage).toEqual({ in: 1800, out: 420 })
    expect(server.matched).toEqual(['planner'])
    expect(server.unmatched).toHaveLength(0)
    expect(server.authorizations[0]).toBe('Bearer sk-test')
  })

  it('条件不满足时不命中，未命中记在 unmatched', async () => {
    const server = await startFixtureLlm(FIXTURES)
    servers.push(server)
    await chat(server.baseUrl, 'deepseek-flash', 'agent:reviewer [BEAT:plan.blueprint]')
    expect(server.matched).toEqual([null])
    expect(server.unmatched).toHaveLength(1)
  })

  it('错误注入按 HTTP 状态返回；repeat:false 只命中一次', async () => {
    const server = await startFixtureLlm(FIXTURES)
    servers.push(server)
    const first = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-plus', stream: true, messages: [{ role: 'user', content: 'x' }] })
    })
    expect(first.status).toBe(429)
    await first.text()

    await chat(server.baseUrl, 'qwen-plus', 'x')
    expect(server.matched).toEqual(['once', null])
  })

  it('目录加载按文件名排序，名字写进 matched', async () => {
    const fixtures = loadFixtures(join(__dirname, '../../fake-llm/fixtures/m0-a'))
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      '01-planner-blueprint',
      '02-narrator-beat',
      '03-reviewer-rate-limit'
    ])
    const server = await startFixtureLlm(fixtures)
    servers.push(server)
    await chat(server.baseUrl, 'deepseek-flash', '本拍意图：写一句')
    expect(server.matched).toEqual(['02-narrator-beat'])
  })

  it('match 条件是与关系', () => {
    const request = {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '[AGENT:planner] [BEAT:b1] 蓝图' }]
    }
    expect(fixtureMatches({ match: { agent: 'planner' }, response: {} }, request)).toBe(true)
    expect(fixtureMatches({ match: { agent: 'planner', beat: 'b1' }, response: {} }, request)).toBe(true)
    expect(fixtureMatches({ match: { agent: 'planner', beat: 'b2' }, response: {} }, request)).toBe(false)
    expect(fixtureMatches({ match: { model: 'qwen-plus' }, response: {} }, request)).toBe(false)
    expect(fixtureMatches({ match: { contains: '蓝图' }, response: {} }, request)).toBe(true)
  })
})
