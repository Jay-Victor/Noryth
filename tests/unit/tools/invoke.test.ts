import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from '../../../src/shared/domain/app-error'
import { invokeTool, type InvokeDeps, type TurnContext } from '../../../src/main/tools/invoke'
import { MemoryAuditSink, type AuditEntry, type AuditSink } from '../../../src/main/tools/audit'
import { TurnBudget } from '../../../src/main/tools/budget'
import type { IdempotencyStore } from '../../../src/main/tools/idempotency'
import { issueGate, consumeGate } from '../../../src/main/tools/gates'
import { buildRegistry } from '../../../src/main/tools/registry'
import { resolveToolset } from '../../../src/main/tools/resolve'
import { TurnRefRegistry } from '../../../src/main/tools/turn-refs'
import type { ToolResult } from '../../../src/main/tools/types'
import { closeTestDb, openTestDb } from '../db/support/db'
import { tempDir } from '../helpers'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { makeTool } from './support'

const SECRET = 'invoke-secret'
const temp = tempDir('noryth-invoke-')
let handle: ReturnType<typeof openTestDb>
let projectId: string

const readTool = makeTool('demo.read', {
  input: z.strictObject({ query: z.string().min(1) }),
  output: z.strictObject({ value: z.number() }),
  handler: () => ({
    data: { value: 1 },
    refs: [{ type: 'memory', id: 'mem_1', quote: '父亲书房有一只上锁的黑漆匣子', seq: 1 }]
  })
})

const probeTool = makeTool('demo.probe', {
  input: z.strictObject({ n: z.number().int() }),
  output: z.strictObject({ n: z.number() }),
  handler: (args) => ({ data: { n: args.n }, degraded: 'empty', refs: [] })
})

const keyTool = makeTool('demo.propose', {
  sideEffect: 'propose',
  idempotency: 'key_required',
  input: z.strictObject({ text: z.string().min(1) }),
  output: z.strictObject({ proposal_id: z.string() }),
  limits: { timeoutMs: 5000, maxResultTokens: 2000, maxCallsPerTurn: 1 },
  handler: () => ({ data: { proposal_id: 'prop_1' } })
})

const gatedTool = makeTool('demo.gate', {
  actors: ['memory'],
  sideEffect: 'execute',
  requiresGate: 'G7',
  idempotency: 'key_required',
  input: z.strictObject({ value: z.number().int() }),
  output: z.strictObject({ value: z.number() }),
  limits: { timeoutMs: 800, maxResultTokens: 2000, maxCallsPerTurn: 5 },
  handler: (args) => ({ data: { value: args.value } })
})

const slowTool = makeTool('demo.slow', {
  input: z.strictObject({}),
  limits: { timeoutMs: 5, maxResultTokens: 2000, maxCallsPerTurn: 2 },
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { data: { value: 1 } }
  }
})

const explodingTool = makeTool('demo.explode', {
  input: z.strictObject({}),
  handler: () => {
    throw new AppError('patch_conflict', 'original text changed')
  }
})

const brokenTool = makeTool('demo.broken', {
  input: z.strictObject({}),
  handler: () => {
    throw new Error('boom')
  }
})

const registry = buildRegistry(
  [readTool, probeTool, keyTool, gatedTool, slowTool, explodingTool, brokenTool],
  { at: '2026-01-01T00:00:00.000Z' }
)

/** 内存版审计 + 幂等：record 时按 key 存 result_json，与生产行为一致。 */
class MemoryReplayStore implements AuditSink, IdempotencyStore {
  readonly entries: AuditEntry[] = []
  private readonly replay = new Map<string, ToolResult>()

  record(entry: AuditEntry): void {
    this.entries.push(entry)
    if (entry.idempotencyKey && entry.resultJson) {
      this.replay.set(`${entry.projectId}:${entry.idempotencyKey}`, JSON.parse(entry.resultJson) as ToolResult)
    }
  }

  find(projectId: string, key: string): ToolResult | null {
    return this.replay.get(`${projectId}:${key}`) ?? null
  }
}

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    projectId: 'prj_1',
    jobId: 'job_1',
    turnId: 'turn_1',
    actorId: 'planner',
    characterId: null,
    asOf: 10,
    epoch: 1,
    expectedRevision: null,
    gateToken: null,
    chapterId: null,
    beatId: null,
    mode: 'interactive',
    ...overrides
  }
}

function deps(store: MemoryReplayStore, overrides: Partial<InvokeDeps> = {}): InvokeDeps {
  return {
    toolset: resolveToolset('planner', {}, registry),
    budget: new TurnBudget('planner'),
    audit: store,
    idempotency: store,
    gateSecret: SECRET,
    nowMs: () => 100,
    ...overrides
  }
}

const services = {
  repos: null as never,
  now: () => 100
}

beforeAll(() => {
  handle = openTestDb(temp.path)
  projectId = handle.repos.project.create({
    title: '流水线测试',
    pov: 'third_limited',
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  }).id
  services.repos = handle.repos as never
})

afterAll(() => {
  closeTestDb(handle)
  temp.cleanup()
})

describe('invokeTool pipeline', () => {
  it('1) 未授权先于参数：垃圾参数也返回 tool_not_found 并记审计', async () => {
    const store = new MemoryReplayStore()
    const result = await invokeTool(
      { callId: 'c1', tool: 'doc.commit_beat', args: { a: undefined } },
      context(),
      deps(store),
      services
    )
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('tool_not_found')
    expect(store.entries).toHaveLength(1)
    expect(JSON.parse(store.entries[0]!.scopeJson).unauthorized).toBe(true)
    expect(store.entries[0]!.argsHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('2) strict 参数：多余字段/越界值 → invalid_args 且字段可定位', async () => {
    const store = new MemoryReplayStore()
    const result = await invokeTool(
      { callId: 'c2', tool: 'demo.read', args: { query: '', extra: 1 } },
      context(),
      deps(store),
      services
    )
    expect(result.error?.code).toBe('invalid_args')
    expect(result.error?.fields?.length ?? 0).toBeGreaterThan(0)
    expect(store.entries[0]?.status).toBe('error')
  })

  it('3) 幂等先于预算：重放不耗额度，不同参数才受单工具上限约束', async () => {
    const store = new MemoryReplayStore()
    const ctx = context({ jobId: 'job_key', turnId: 'turn_key' })
    const budget = new TurnBudget('planner')
    const pipeline = deps(store, { budget, toolset: resolveToolset('planner', {}, registry) })
    const first = await invokeTool({ callId: 'k1', tool: 'demo.propose', args: { text: 'a' } }, ctx, pipeline, services)
    expect(first.ok).toBe(true)

    const replay = await invokeTool({ callId: 'k2', tool: 'demo.propose', args: { text: 'a' } }, ctx, pipeline, services)
    expect(replay.duplicate).toBe(true)
    expect(budget.usedFor('demo.propose')).toBe(1)

    const other = await invokeTool({ callId: 'k3', tool: 'demo.propose', args: { text: 'b' } }, ctx, pipeline, services)
    expect(other.error?.code).toBe('tool_budget_exceeded')
    expect(budget.usedFor('demo.propose')).toBe(1)
  })

  it('4) 闸门：缺令牌 gate_required、成功不自动消费、消费后 gate_consumed', async () => {
    const store = new MemoryReplayStore()
    let calls = 0
    const toolset = resolveToolset('memory', {}, buildRegistry([{ ...gatedTool, handler: (args) => {
      calls += 1
      return { data: { value: args.value } }
    } }], { at: registry.at }))
    const ctx = context({ actorId: 'memory', jobId: 'job_gate', turnId: 'turn_gate' })
    const pipeline = deps(store, { toolset, audit: store, budget: new TurnBudget('memory') })

    const missing = await invokeTool({ callId: 'g1', tool: 'demo.gate', args: { value: 1 } }, ctx, pipeline, services)
    expect(missing.error?.code).toBe('gate_required')
    expect(calls).toBe(0)

    const issued = issueGate({
      repos: handle.repos,
      secret: SECRET,
      projectId,
      gateId: 'G7',
      entityType: 'proposal',
      entityId: 'prop_1',
      revision: null,
      jobId: ctx.jobId,
      actor: 'author'
    })
    const withGate = { ...ctx, projectId, gateToken: issued.token, asOf: 10 }
    const ok = await invokeTool({ callId: 'g2', tool: 'demo.gate', args: { value: 2 } }, withGate, pipeline, services)
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true)
    expect(calls).toBe(1)
    expect(issued.record.consumedAt).toBeNull()

    consumeGate(handle.repos, issued.token)
    const afterConsume = await invokeTool(
      { callId: 'g3', tool: 'demo.gate', args: { value: 3 } },
      withGate,
      pipeline,
      services
    )
    expect(afterConsume.error?.code).toBe('gate_consumed')
    expect(calls).toBe(1)
  })

  it('5) 超时无部分结果 → timeout；有部分结果 → degraded summary', async () => {
    const store = new MemoryReplayStore()
    const timeout = await invokeTool({ callId: 't1', tool: 'demo.slow', args: {} }, context(), deps(store), services)
    expect(timeout.error?.code).toBe('timeout')
    expect(store.entries.at(-1)?.errorCode).toBe('timeout')

    const partialTool = { ...slowTool, handler: async (_args: Record<string, unknown>, ctx: { reportPartial: (payload: never) => void }) => {
      ctx.reportPartial({ data: { value: 7 } } as never)
      await new Promise((resolve) => setTimeout(resolve, 40))
      return { data: { value: 8 } }
    } }
    const partialSet = resolveToolset('planner', {}, buildRegistry([partialTool], { at: registry.at }))
    const partial = await invokeTool(
      { callId: 't2', tool: 'demo.slow', args: {} },
      context({ turnId: 'turn_partial' }),
      deps(store, { toolset: partialSet }),
      services
    )
    expect(partial.ok).toBe(true)
    expect(partial.degraded).toBe('summary')
    expect(partial.data).toEqual({ value: 7 })
  })

  it('6) AppError 保留错误码；未知异常统一 internal_error', async () => {
    const store = new MemoryReplayStore()
    const thrown = await invokeTool({ callId: 'e1', tool: 'demo.explode', args: {} }, context(), deps(store), services)
    expect(thrown.error?.code).toBe('patch_conflict')

    const broken = await invokeTool({ callId: 'e2', tool: 'demo.broken', args: {} }, context(), deps(store), services)
    expect(broken.error?.code).toBe('internal_error')
    expect(broken.error).not.toHaveProperty('details')
  })

  it('7) 空结果 ok:true + degraded empty；refs 登记到 turnRefs', async () => {
    const store = new MemoryReplayStore()
    const refs = new TurnRefRegistry()
    const result = await invokeTool(
      { callId: 'r1', tool: 'demo.probe', args: { n: 1 } },
      context(),
      deps(store, { turnRefs: refs }),
      services
    )
    expect(result.ok).toBe(true)
    expect(result.degraded).toBe('empty')
    expect(refs.list()).toEqual([])

    const withRefs = await invokeTool({ callId: 'r2', tool: 'demo.read', args: { query: '匣子' } }, context({ turnId: 'turn_refs' }), deps(store, { turnRefs: refs }), services)
    expect(withRefs.ok).toBe(true)
    expect(refs.has('memory', 'mem_1')).toBe(true)
  })

  it('8) 审计只存 hash 与 ref ids；只读工具不写 result_json', async () => {
    const store = new MemoryReplayStore()
    await invokeTool({ callId: 'a1', tool: 'demo.read', args: { query: '账本' } }, context({ turnId: 'turn_audit' }), deps(store), services)
    const entry = store.entries.at(-1)!
    expect(entry.argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(entry.scopeJson).not.toContain('账本')
    expect(entry.resultJson).toBeNull()
    expect(entry.resultIdsJson).toBe('["memory:mem_1"]')
    expect(entry.status).toBe('ok')
  })

  it('9) Agent 单轮合计上限生效（旁白 4 次）', async () => {
    const store = new MemoryReplayStore()
    const narratorTool = makeTool('demo.narrator', {
      actors: ['narrator'],
      input: z.strictObject({ n: z.number().int() }),
      limits: { timeoutMs: 800, maxResultTokens: 2000, maxCallsPerTurn: 10 }
    })
    const toolset = resolveToolset('narrator', {}, buildRegistry([narratorTool], { at: registry.at }))
    const budget = new TurnBudget('narrator')
    const pipeline = deps(store, { toolset, budget })
    let last: ToolResult | null = null
    for (let index = 0; index < 5; index += 1) {
      last = await invokeTool(
        { callId: `n${index}`, tool: 'demo.narrator', args: { n: index } },
        context({ actorId: 'narrator', turnId: 'turn_narrator' }),
        pipeline,
        services
      )
    }
    expect(last?.error?.code).toBe('tool_budget_exceeded')
    expect(budget.used).toBe(4)
  })
})

describe('MemoryAuditSink', () => {
  it('记录每次调用，不吞错误', () => {
    const sink = new MemoryAuditSink()
    sink.record({
      projectId: 'p',
      jobId: 'j',
      turnId: 't',
      tool: 'x',
      toolVersion: '1.0.0',
      actorId: 'planner',
      scopeJson: '{}',
      argsHash: 'h',
      status: 'ok',
      latencyMs: 1
    })
    expect(sink.entries).toHaveLength(1)
  })
})
