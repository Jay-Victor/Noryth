import { afterEach, describe, expect, it } from 'vitest'
import { createTurnJob } from '../../src/main/agents/job'
import { runTurn } from '../../src/main/agents/turn'
import { setBinding } from '../../src/main/model/bindings'
import { createOpenAiCompatAdapter } from '../../src/main/model/openai-compat'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { openContractWorld, type ContractWorld } from '../contract/support/world'
import { startFakeLlm, type FakeLlmServer } from './support/fake-llm'

/**
 * 阶段 04 的硬验收：假模型跑通「装配 → 生成 → 校验」，产出一拍合法信封；
 * grounding 伪造与 quote 改写被拒绝；job 内绑定不漂移。
 * 落盘（commitBeat）留给阶段 05，这里只断言没有写正文。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const GATE_SECRET = 'integration-secret'
const FINAL_TEXT = '「匣子不在书房，在祠堂的供桌下面。」'
function goodGrounding(world: ContractWorld) {
  const memory = world.repos.memory
    .listByCharacter(world.characterLin)
    .find((entry) => entry.text.includes('黑漆匣子'))!
  return { type: 'memory' as const, id: memory.id, quote: memory.text }
}

const worlds: ContractWorld[] = []
const servers: FakeLlmServer[] = []

function newWorld(): ContractWorld {
  const world = openContractWorld()
  worlds.push(world)
  return world
}

async function newServer(
  reply: Parameters<typeof startFakeLlm>[0],
  model = 'deepseek-flash'
): Promise<FakeLlmServer> {
  const server = await startFakeLlm(reply, model)
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const world of worlds.splice(0)) world.cleanup()
})

function adapterFor(server: FakeLlmServer, provider = 'deepseek', model = 'deepseek-flash') {
  return createOpenAiCompatAdapter(
    { provider, baseUrl: server.baseUrl, model },
    {
      retry: { sleep: async () => undefined, jitter: () => 0 },
      totalTimeoutMs: 5_000,
      firstTokenTimeoutMs: 5_000
    }
  )
}

function jobFor(
  world: ContractWorld,
  id: string,
  beatId = world.beatDraftId,
  actor: 'character:chr_lin' | 'narrator' = 'character:chr_lin'
) {
  return createTurnJob(world.repos, registry, {
    id,
    chapterId: world.chapterDraftId,
    beatId,
    actor,
    mode: 'interactive',
    at: '2026-01-01T00:00:00.000Z'
  })
}

describe('runTurn 一拍端到端（假模型）', () => {
  it('原生工具调用 → 取材 → 合法信封；不写正文', async () => {
    const world = newWorld()
    const before = world.repos.beat.get(world.beatDraftId)!
    const server = await newServer((_body, index) => {
      if (index === 0) {
        return {
          reasoning: '先查一下她记得什么。',
          toolCalls: [{ id: 'call_1', name: 'memory.retrieve_own', args: { query: '匣子' } }],
          usage: { in: 800, out: 20 }
        }
      }
      return {
        text: JSON.stringify({ body: FINAL_TEXT, grounding: [goodGrounding(world)] }),
        usage: { in: 1200, out: 60 }
      }
    })
    const { job } = jobFor(world, 'job_turn_native')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )

    expect(result.status, JSON.stringify(result.rejection)).toBe('validated')
    expect(result.rejection).toBeNull()
    expect(result.envelope?.speaker).toEqual({ type: 'character', id: 'chr_lin' })
    expect(result.envelope?.body).toBe(FINAL_TEXT)
    expect(result.envelope?.grounding).toEqual([goodGrounding(world)])
    expect(result.envelope?.meta.model).toBe('deepseek-flash')
    expect(result.usage).toEqual({ tokensIn: 2000, tokensOut: 80 })
    expect(result.toolCalls).toBe(1)
    expect(result.attempts).toBe(1)

    const trace = result.envelope!.trace
    const toolTrace = trace.find((item) => item.type === 'tool_call')
    expect(toolTrace && toolTrace.type === 'tool_call' ? toolTrace.tool : '').toBe('memory.retrieve_own')
    expect(toolTrace && toolTrace.type === 'tool_call' ? toolTrace.result_ids : []).toContain(
      `memory:${goodGrounding(world).id}`
    )
    expect(trace.some((item) => item.type === 'thought' && item.text.includes('先查一下'))).toBe(true)

    // 工具结果作为材料回传，第二轮请求里必须有 tool 消息
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(true)

    expect(world.repos.job.get(job.id)?.status).toBe('succeeded')
    const metric = world.repos.turnMetric.get(result.turnId)
    expect(metric).not.toBeNull()
    expect(metric?.bindingVersion).toBe(0)
    expect(JSON.parse(metric!.contextJson).blocks.length).toBeGreaterThan(0)
    expect(world.repos.toolCall.listByTurn(result.turnId)).toHaveLength(1)

    // 阶段 04 不落盘：beat 正文与状态不变
    const after = world.repos.beat.get(world.beatDraftId)!
    expect(after.body).toBe(before.body)
    expect(after.status).toBe(before.status)
  })

  it('伪造 grounding ID → 重试一次仍失败 → rejected，不产出信封', async () => {
    const world = newWorld()
    const bad = JSON.stringify({
      body: FINAL_TEXT,
      grounding: [{ type: 'memory', id: 'mem_forged', quote: '不存在的记忆' }]
    })
    const server = await newServer((_body, index) =>
      index === 0
        ? { toolCalls: [{ id: 'call_1', name: 'memory.retrieve_own', args: { query: '匣子' } }] }
        : { text: bad }
    )
    const { job } = jobFor(world, 'job_turn_forged')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )

    expect(result.status).toBe('rejected')
    expect(result.envelope).toBeNull()
    expect(result.rejection?.code).toBe('grounding_not_returned')
    expect(result.attempts).toBe(2)
    expect(world.repos.job.get(job.id)?.status).toBe('failed')
    expect(world.repos.job.get(job.id)?.errorCode).toBe('grounding_not_returned')
    expect(world.repos.turnMetric.get(result.turnId)).toBeNull()
    // 第二次是「不许调工具」的重问
    expect(server.requests).toHaveLength(3)
    expect(server.requests[2]?.tools).toBeUndefined()
  })

  it('改写 quote → grounding_quote_mismatch；提示里只列允许的 ref', async () => {
    const world = newWorld()
    const rewritten = JSON.stringify({
      body: FINAL_TEXT,
      grounding: [{ type: 'memory', id: goodGrounding(world).id, quote: '父亲书房有一只黑漆匣子' }]
    })
    const server = await newServer((_body, index) => (index === 0 ? { text: rewritten } : { text: rewritten }))
    const { job } = jobFor(world, 'job_turn_quote')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )
    expect(result.status).toBe('rejected')
    expect(result.rejection?.code).toBe('grounding_quote_mismatch')
    const retryMessage = server.requests[1]?.messages.at(-1)?.content ?? ''
    expect(retryMessage).toContain(`memory:${goodGrounding(world).id}`)
    expect(retryMessage).not.toContain('mem_forged')
  })

  it('JSON 回退：无 tool calling 的模型走一轮工具后给 final', async () => {
    const world = newWorld()
    setBinding(
      world.repos,
      {
        projectId: world.projectId,
        agentKey: 'character:chr_lin',
        provider: 'deepseek',
        model: 'deepseek-flash',
        params: {
          capabilities: {
            stream: true,
            tools: false,
            jsonMode: true,
            contextWindow: 64_000,
            maxOutput: 8_192,
            pricing: { in: 0, out: 0 }
          }
        }
      },
      'author'
    )
    const server = await newServer((_body, index) =>
      index === 0
        ? {
            text: JSON.stringify({
              tool_calls: [{ tool: 'memory.retrieve_own', args: { query: '匣子' } }],
              final: null
            })
          }
        : {
            text: JSON.stringify({
              tool_calls: [],
              final: { body: FINAL_TEXT, grounding: [goodGrounding(world)] }
            })
          }
    )
    const { job } = jobFor(world, 'job_turn_fallback')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )

    expect(result.status, JSON.stringify(result.rejection)).toBe('validated')
    expect(result.envelope?.body).toBe(FINAL_TEXT)
    expect(result.toolCalls).toBe(1)
    expect(server.requests[0]?.response_format).toEqual({ type: 'json_object' })
    expect(server.requests[1]?.messages.some((message) => message.content.includes('<tool_result'))).toBe(true)
  })

  it('JSON 回退连续 2 次解析失败 → tool_protocol_error，不产生裸答正文', async () => {
    const world = newWorld()
    setBinding(
      world.repos,
      {
        projectId: world.projectId,
        agentKey: 'character:chr_lin',
        provider: 'deepseek',
        model: 'deepseek-flash',
        params: {
          capabilities: {
            stream: true,
            tools: false,
            jsonMode: true,
            contextWindow: 64_000,
            maxOutput: 8_192,
            pricing: { in: 0, out: 0 }
          }
        }
      },
      'author'
    )
    const server = await newServer(() => ({ text: '她把茶盏推了过去，没有输出 JSON。' }))
    const { job } = jobFor(world, 'job_turn_bad_json')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )
    expect(result.status).toBe('rejected')
    expect(result.rejection?.code).toBe('tool_protocol_error')
    expect(result.envelope).toBeNull()
    expect(server.requests).toHaveLength(2)
    expect(world.repos.turnMetric.get(result.turnId)).toBeNull()
  })

  it('旁白拍：无角色卡，speaker=narrator，L0 只给一句话目标与场景序列', async () => {
    const world = newWorld()
    const narratorBeat = world.repos.beat
      .listByChapter(world.chapterDraftId)
      .find((item) => item.speakerType === 'narrator')!
    const server = await newServer(() => ({
      text: JSON.stringify({ body: '她把茶盏推过去，窗外的雨还没有停。', grounding: [] })
    }))
    const { job } = jobFor(world, 'job_turn_narrator', narratorBeat.id, 'narrator')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )
    expect(result.status, JSON.stringify(result.rejection)).toBe('validated')
    expect(result.envelope?.speaker).toEqual({ type: 'narrator', id: 'narrator' })
    expect(result.context.bundle.blocks.some((block) => block.role === 'card')).toBe(false)
    const l0 = result.context.bundle.blocks.find((block) => block.id === 'L0:chapter')!
    expect(l0.text).toContain('本章目标')
    expect(l0.text).toContain('场景序列')
  })

  it('探测能力随 job 冻结：tools=false 时走 JSON 回退', async () => {
    const world = newWorld()
    const server = await newServer(() => ({
      text: JSON.stringify({ tool_calls: [], final: { body: FINAL_TEXT, grounding: [goodGrounding(world)] } })
    }))
    const { job } = createTurnJob(
      world.repos,
      registry,
      {
        chapterId: world.chapterDraftId,
        beatId: world.beatDraftId,
        actor: 'character:chr_lin',
        mode: 'interactive',
        at: '2026-01-01T00:00:00.000Z'
      },
      {
        capabilitiesLookup: () => ({
          stream: true,
          tools: false,
          jsonMode: true,
          contextWindow: 64_000,
          maxOutput: 8_192,
          pricing: { in: 0, out: 0 }
        })
      }
    )
    expect(job.payloadJson).toContain('"tools":false')

    const result = await runTurn(
      { repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET },
      { job }
    )
    expect(result.status, JSON.stringify(result.rejection)).toBe('validated')
    expect(server.requests[0]?.response_format).toEqual({ type: 'json_object' })
  })

  it('供应商 5xx 重试 2 次后暂停，job 标 failed', async () => {
    const world = newWorld()
    const server = await newServer(() => ({ httpStatus: 500, httpBody: '{"error":{"message":"boom"}}' }))
    const { job } = jobFor(world, 'job_turn_500')

    await expect(
      runTurn({ repos: world.repos, registry, adapter: adapterFor(server), gateSecret: GATE_SECRET }, { job })
    ).rejects.toMatchObject({ code: 'model_error' })

    expect(server.requests).toHaveLength(3)
    expect(world.repos.job.get(job.id)?.status).toBe('failed')
    expect(world.repos.job.get(job.id)?.errorCode).toBe('model_error')
  })

  it('job 内绑定不漂移：运行中改绑定，当前 job 仍用旧绑定', async () => {
    const world = newWorld()
    const server = await newServer(() => ({ text: JSON.stringify({ body: FINAL_TEXT, grounding: [] }) }))
    const first = jobFor(world, 'job_turn_stable')
    expect(first.payload.bindings.bindings['character:chr_lin']?.model).toBe('deepseek-flash')

    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'character:chr_lin', provider: 'tongyi', model: 'qwen-plus' },
      'author'
    )

    const result = await runTurn(
      {
        repos: world.repos,
        registry,
        adapter: adapterFor(server, 'deepseek', 'deepseek-flash'),
        gateSecret: GATE_SECRET
      },
      { job: first.job }
    )
    expect(result.status, JSON.stringify(result.rejection)).toBe('validated')
    expect(result.binding).toEqual({ provider: 'deepseek', model: 'deepseek-flash', version: 0 })

    const second = jobFor(world, 'job_turn_next')
    expect(second.payload.bindings.bindings['character:chr_lin']?.provider).toBe('tongyi')
    expect(second.payload.bindings.bindings['character:chr_lin']?.model).toBe('qwen-plus')
    expect(second.payload.bindings.hash).not.toBe(first.payload.bindings.hash)
  })
})
