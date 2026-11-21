import { afterEach, describe, expect, it } from 'vitest'
import { WriteService } from '../../../src/main/scheduler/service'
import { ALL_MANIFESTS } from '../../../src/main/tools/manifests'
import { buildRegistry } from '../../../src/main/tools/registry'
import { SettingsSchema } from '../../../src/shared/schema/project'
import { WriteContextInspectionSchema } from '../../../src/shared/schema/write'
import { chapterBudget } from '../../../src/main/scheduler/loop'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 上下文检查器（PHASE-13 M1-17）：数据源是 turn_metric.context_json。
 * - 没有指标 → found=false（UI 显示「这一拍还没有生成过」）；
 * - 有指标 → 块、裁剪、prefix hash、as_of、估算 vs 实际全部对齐；
 * - 输出必须通过 IPC 契约 schema。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const worlds: WriteTestWorld[] = []

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function setup(): { world: WriteTestWorld; service: WriteService } {
  const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
  worlds.push(world)
  const service = new WriteService({
    host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    gateSecret: 'unit-context-gate',
    send: () => undefined
  })
  return { world, service }
}

const CONTEXT_JSON = JSON.stringify({
  blocks: [
    { id: 'L0:chapter', layer: 'L0', stable: true, priority: 10, tokens: 120, role: 'stable', order: null, ref_type: null },
    { id: 'L2:recent:bt_1', layer: 'L2', stable: false, priority: 40, tokens: 300, role: 'recent', order: 1, ref_type: null },
    { id: 'L2:ref:memory:mem_1', layer: 'L2', stable: false, priority: 30, tokens: 80, role: 'refs', order: null, ref_type: 'memory' }
  ],
  total_tokens: 500,
  trimmed: ['L2:ref:memory:mem_2'],
  degraded: ['context_trimmed'],
  prefix_hash: 'abc123def456',
  as_of: 7,
  turn_id: 'turn_ctx_1'
})

describe('WriteService.inspectContext', () => {
  it('没有 turn_metric → found=false，仍返回本章预算', () => {
    const { world, service } = setup()
    const payload = service.inspectContext(world.beatIds[0]!)
    expect(payload.found).toBe(false)
    expect(payload.blocks).toEqual([])
    expect(payload.budget).toEqual(
      chapterBudget(world.repos, world.repos.chapter.get(world.chapterId)!)
    )
    expect(WriteContextInspectionSchema.safeParse(payload).success).toBe(true)
  })

  it('有 turn_metric → 块 / 裁剪 / as_of / ratio 与 context_json 对齐', () => {
    const { world, service } = setup()
    const beatId = world.beatIds[0]!
    world.repos.turnMetric.upsert({
      turnId: 'turn_ctx_1',
      projectId: world.projectId,
      jobId: 'job_ctx',
      beatId,
      chapterId: world.chapterId,
      agentKey: 'character',
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 2,
      tokensIn: 600,
      tokensOut: 120,
      costCny: 0.0042,
      latencyMs: 1_800,
      firstTokenMs: 320,
      contextJson: CONTEXT_JSON,
      degradedJson: '["context_trimmed"]',
      createdAt: '2026-01-01T00:00:01.000Z'
    })

    const payload = service.inspectContext(beatId)
    expect(payload.found).toBe(true)
    expect(payload.turnId).toBe('turn_ctx_1')
    expect(payload.asOf).toBe(7)
    expect(payload.totalTokens).toBe(500)
    expect(payload.blocks.map((block) => block.layer)).toEqual(['L0', 'L2', 'L2'])
    expect(payload.blocks.find((block) => block.id === 'L2:ref:memory:mem_1')!.refType).toBe('memory')
    expect(payload.prefixHash).toBe('abc123def456')
    expect(payload.trimmed).toEqual(['L2:ref:memory:mem_2'])
    expect(payload.degraded).toEqual(['context_trimmed'])
    expect(payload.usage).toMatchObject({ tokensIn: 600, tokensOut: 120, firstTokenMs: 320 })
    // 估算 500 vs 实际 prompt 600 → ratio 1.2；不显示假精确值，只给这个比例。
    expect(payload.estimate).toEqual({ totalTokens: 500, actualPromptTokens: 600, ratio: 1.2 })
    expect(WriteContextInspectionSchema.safeParse(payload).success).toBe(true)
  })

  it('context_json 损坏时不崩：found=true 但块为空', () => {
    const { world, service } = setup()
    const beatId = world.beatIds[0]!
    world.repos.turnMetric.upsert({
      turnId: 'turn_ctx_bad',
      projectId: world.projectId,
      jobId: 'job_ctx_bad',
      beatId,
      chapterId: world.chapterId,
      agentKey: 'character',
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 0,
      tokensIn: null,
      tokensOut: null,
      costCny: null,
      latencyMs: null,
      firstTokenMs: null,
      contextJson: '{"blocks": "not-an-array"}',
      createdAt: '2026-01-01T00:00:02.000Z'
    })
    const payload = service.inspectContext(beatId)
    expect(payload.found).toBe(true)
    expect(payload.blocks).toEqual([])
    expect(payload.estimate.ratio).toBeNull()
    expect(WriteContextInspectionSchema.safeParse(payload).success).toBe(true)
  })
})
