import { afterEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../../src/shared/schema/project'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { WriteService } from '../../src/main/scheduler/service'
import { recordTurnMetric } from '../../src/main/model/usage'
import type { PlannerModel } from '../../src/main/plan/model'
import { FakePlannerAdapter } from '../../src/main/plan/fake-adapter'
import { PlanService, type PlanHost } from '../../src/main/plan/service'
import type { ResolvedBinding } from '../../src/main/model/bindings'
import { openWriteWorld, type WriteTestWorld } from '../support/write-world'
import { openReviewWorld, type ReviewTestWorld } from '../support/review-world'
import { openMemoryWorld, type MemoryTestWorld } from '../support/memory-world'
import { openPlanWorld, type PlanTestWorld } from '../support/plan-world'

/**
 * 全链路计量（PHASE-20 §5.3 / M2-5）：写拍、审批、讨论、记忆、规划各写一行
 * `turn_metric`；chapter_id 归属正确；规划为 NULL（项目级）；重试 upsert 不重复；
 * 非写拍 context_json 只存元数据，不存提示词全文或正文。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function metricsOf(repos: { turnMetric: { listByJob(jobId: string): unknown[] } }, jobId: string) {
  return repos.turnMetric.listByJob(jobId) as Array<{
    turnId: string
    agentKey: string
    chapterId: string | null
    beatId: string | null
    tokensIn: number | null
    tokensOut: number | null
    costCny: number | null
    contextJson: string
  }>
}

function countMetrics(db: { prepare(sql: string): { get(): unknown } }, where = '1 = 1'): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM turn_metric WHERE ${where}`).get() as { count: number }
  ).count
}

describe('使用计量（写拍 / 审批 / 记忆 / 讨论 / 规划）', () => {
  it('写拍：一行 turn_metric，chapter_id + beat_id 正确，有计价', async () => {
    const world: WriteTestWorld = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
    cleanups.push(world.cleanup)
    const service = new WriteService({
      host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
      registry,
      settings: () => SettingsSchema.parse({}),
      allowFakeModel: true,
      gateSecret: 'usage-gate',
      send: () => undefined,
      fakeChunkDelayMs: 0,
      env: { NORYTH_WRITE_FAKE: '1' }
    })
    const beat = world.repos.beat.listLiveByChapter(world.chapterId)[0]!
    await service.generate(beat.id)

    const row = world.repos.turnMetric.latestByBeat(beat.id)
    expect(row).not.toBeNull()
    expect(row!.chapterId).toBe(world.chapterId)
    expect(row!.beatId).toBe(beat.id)
    expect(['character', 'narrator']).toContain(row!.agentKey)
    expect(row!.tokensIn).toBeGreaterThan(0)
    expect(row!.costCny).toBeGreaterThan(0)
    // 写拍保留完整 context_json（上下文检查器的数据源）。
    const context = JSON.parse(row!.contextJson) as { blocks?: unknown[]; turn_id?: string }
    expect(Array.isArray(context.blocks)).toBe(true)
    expect(context.turn_id).toBe(row!.turnId)
  })

  it('审批与讨论：agent=reviewer，chapter_id=被审章，beat_id=NULL', async () => {
    const created: ReviewTestWorld = openReviewWorld()
    cleanups.push(() => created.world.cleanup())
    const chapterId = created.world.chapterId
    await created.service.run(chapterId)
    await created.service.send(chapterId, '第 1 条阻断具体是哪句？')

    const rows = created.world.handle.db
      .prepare("SELECT chapter_id, beat_id, context_json FROM turn_metric WHERE agent_key = 'reviewer' ORDER BY created_at")
      .all() as Array<{ chapter_id: string | null; beat_id: string | null; context_json: string }>
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((row) => row.chapter_id === chapterId)).toBe(true)
    expect(rows.every((row) => row.beat_id === null)).toBe(true)
    for (const row of rows) {
      const context = JSON.parse(row.context_json) as Record<string, unknown>
      expect(context.kind).toBe('review')
      expect(typeof context.prompt_version).toBe('string')
      expect(typeof context.toolset_version).toBe('string')
      expect(typeof context.block_tokens).toBe('number')
      // 不存提示词全文 / 正文。
      expect(context.prompt).toBeUndefined()
      expect(context.body).toBeUndefined()
    }
  })

  it('记忆抽取与讨论：agent=memory，chapter_id=来源章', async () => {
    const world: MemoryTestWorld = openMemoryWorld()
    cleanups.push(() => world.cleanup())
    await world.service.extract(world.chapterId)
    await world.service.send({ chapterId: world.chapterId, text: '这条提案为什么重要？' })

    const rows = world.handle.db
      .prepare("SELECT chapter_id, beat_id FROM turn_metric WHERE agent_key = 'memory'")
      .all() as Array<{ chapter_id: string | null; beat_id: string | null }>
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((row) => row.chapter_id === world.chapterId)).toBe(true)
    expect(countMetrics(world.handle.db, "agent_key = 'memory' AND beat_id IS NULL")).toBeGreaterThanOrEqual(2)
  })

  it('规划：agent=planner，chapter_id=NULL（项目级桶）', async () => {
    const w: PlanTestWorld = openPlanWorld()
    cleanups.push(() => w.cleanup())
    const binding: ResolvedBinding = {
      agentKey: 'planner',
      provider: 'deepseek',
      model: 'planner-fake',
      params: {},
      version: 0,
      source: 'preset'
    }
    const model: PlannerModel = {
      binding,
      adapter: new FakePlannerAdapter(0),
      status: { provider: 'deepseek', model: 'planner-fake', label: '假模型', ready: true }
    }
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    const service = new PlanService({
      host: () => host,
      registry,
      settings: () => SettingsSchema.parse({}),
      allowFakeModel: true,
      emit: () => {},
      emitChoice: () => {},
      model: () => model
    })
    const session = service.createSession({})
    const sent = service.send({ sessionId: session.id, text: '写一个民国悬疑' })
    const started = Date.now()
    while (Date.now() - started < 4_000) {
      if (w.repos.planMessage.get(sent.assistantMessageId)!.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const metrics = metricsOf(w.repos, `plan_${session.id}`)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.agentKey).toBe('planner')
    expect(metrics[0]!.chapterId).toBeNull()
    expect(metrics[0]!.beatId).toBeNull()
    const context = JSON.parse(metrics[0]!.contextJson) as Record<string, unknown>
    expect(context.kind).toBe('plan')
  })

  it('重试 upsert：同一 turn_id 只保留一行，数值覆盖', () => {
    const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 1 })
    cleanups.push(world.cleanup)
    const base = {
      repos: world.repos,
      projectId: world.projectId,
      jobId: 'job_retry',
      turnId: 'turn_retry_same',
      agentKey: 'reviewer',
      chapterId: world.chapterId,
      beatId: null,
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 1,
      capabilities: { stream: true, tools: true, jsonMode: true, contextWindow: 64_000, maxOutput: 8_192, pricing: { in: 2, out: 8 } },
      latencyMs: 10,
      contextJson: '{"kind":"review"}'
    }
    recordTurnMetric({ ...base, usage: { tokensIn: 100, tokensOut: 10 } })
    recordTurnMetric({ ...base, usage: { tokensIn: 300, tokensOut: 30 }, latencyMs: 30 })
    expect(countMetrics(world.handle.db, "turn_id = 'turn_retry_same'")).toBe(1)
    const row = world.repos.turnMetric.get('turn_retry_same')!
    expect(row.tokensIn).toBe(300)
    expect(row.tokensOut).toBe(30)
    expect(row.latencyMs).toBe(30)
    expect(row.costCny).toBeCloseTo((300 * 2 + 30 * 8) / 1_000_000, 8)
  })
})
