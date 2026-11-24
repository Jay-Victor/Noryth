import { describe, expect, it, afterEach } from 'vitest'
import { sumUsages, recordTurnMetric } from '../../../src/main/model/usage'
import { createOpenAiCompatAdapter } from '../../../src/main/model/openai-compat'
import { buildCostReport } from '../../../src/main/report/cost'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { openTestDb, type TestDb } from '../db/support/db'
import { tempDir } from '../helpers'

/**
 * 缓存指标（PHASE-22 §5.6 / M2-9）。
 *
 * 口径：供应商返回 `prompt_tokens_details.cached_tokens`（OpenAI 兼容）
 * 或 `prompt_cache_hit_tokens`（DeepSeek）时记录；都没返回 → NULL（不是 0）。
 * 缓存命中只用于成本归因，不改变 grounding 或正确性。
 */

const CONFIG = {
  provider: 'deepseek',
  baseUrl: 'https://fake.local/v1',
  model: 'deepseek-flash',
  apiKey: 'test-key'
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function adapterWith(usage: Record<string, unknown>) {
  return createOpenAiCompatAdapter(CONFIG, {
    fetchImpl: (async () =>
      jsonResponse({
        model: 'deepseek-flash',
        choices: [{ message: { content: '{"body":"雨停了","grounding":[]}' }, finish_reason: 'stop' }],
        usage
      })) as unknown as typeof fetch,
    retry: { sleep: async () => undefined, jitter: () => 0 }
  })
}

async function usageOf(usage: Record<string, unknown>) {
  const result = await adapterWith(usage).stream({ messages: [{ role: 'user', content: '写一拍' }], stream: false }, {})
  return result.usage
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function newWorld(): { handle: TestDb; projectId: string; dir: string } {
  const temp = tempDir('noryth-usage-')
  cleanups.push(temp.cleanup)
  const handle = openTestDb(temp.path)
  cleanups.push(() => handle.db.close())
  const project = handle.repos.project.create({
    title: '缓存指标',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 100_000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  return { handle, projectId: project.id, dir: temp.path }
}

describe('cache usage（PHASE-22）', () => {
  it('OpenAI 兼容：prompt_tokens_details.cached_tokens', async () => {
    const usage = await usageOf({
      prompt_tokens: 1200,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 900 }
    })
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 80, cachedTokens: 900 })
  })

  it('DeepSeek：prompt_cache_hit_tokens', async () => {
    const usage = await usageOf({
      prompt_tokens: 1000,
      completion_tokens: 60,
      prompt_cache_hit_tokens: 640
    })
    expect(usage?.cachedTokens).toBe(640)
  })

  it('未报告 → null（不是 0）；没有 usage → null', async () => {
    const none = await usageOf({ prompt_tokens: 500, completion_tokens: 20 })
    expect(none?.cachedTokens).toBeNull()
    const zero = await usageOf({
      prompt_tokens: 500,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0 }
    })
    expect(zero?.cachedTokens).toBe(0)
  })

  it('sumUsages：只累加报告了的轮次；全未报告 → null', () => {
    expect(
      sumUsages([
        { promptTokens: 100, completionTokens: 10, cachedTokens: 60 },
        { promptTokens: 50, completionTokens: 5, cachedTokens: 25 }
      ])
    ).toEqual({ tokensIn: 150, tokensOut: 15, cachedTokens: 85 })
    expect(sumUsages([{ promptTokens: 100, completionTokens: 10 }])).toEqual({
      tokensIn: 100,
      tokensOut: 10,
      cachedTokens: null
    })
    expect(sumUsages([null])).toEqual({ tokensIn: null, tokensOut: null, cachedTokens: null })
  })

  it('recordTurnMetric 写 cached_tokens；报表只统计报告了的调用', () => {
    const { handle, projectId } = newWorld()
    const { repos } = handle
    recordTurnMetric({
      repos,
      projectId,
      jobId: 'job_1',
      turnId: 'turn_1',
      agentKey: 'narrator',
      chapterId: null,
      beatId: null,
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 1,
      usage: { tokensIn: 1000, tokensOut: 100, cachedTokens: 600 },
      capabilities: null,
      latencyMs: 10,
      contextJson: '{}'
    })
    recordTurnMetric({
      repos,
      projectId,
      jobId: 'job_2',
      turnId: 'turn_2',
      agentKey: 'reviewer',
      chapterId: null,
      beatId: null,
      provider: 'openai',
      model: 'gpt-x',
      bindingVersion: 1,
      usage: { tokensIn: 500, tokensOut: 50 },
      capabilities: null,
      latencyMs: 10,
      contextJson: '{}'
    })

    expect(repos.turnMetric.get('turn_1')!.cachedTokens).toBe(600)
    expect(repos.turnMetric.get('turn_2')!.cachedTokens).toBeNull()

    const report = buildCostReport(repos)
    expect(report.cache).toEqual({
      cachedTokens: 600,
      cacheCalls: 1,
      calls: 2,
      hitRate: 0.4
    })
    expect(report.total.cachedTokens).toBe(600)
    expect(report.total.cacheCalls).toBe(1)
    expect(report.byAgent.find((row) => row.agentKey === 'narrator')!.cachedTokens).toBe(600)
    expect(report.byAgent.find((row) => row.agentKey === 'reviewer')!.cacheCalls).toBe(0)
  })
})
