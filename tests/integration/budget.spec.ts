import { afterEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../../src/shared/schema/project'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { WriteService } from '../../src/main/scheduler/service'
import { verifyDatabase } from '../../src/main/db/verify'
import { openWriteWorld, type WriteWorldOptions, type WriteTestWorld } from '../support/write-world'

/**
 * 预算化自动模式（PHASE-20 §5.1 / §6，M2-3）：
 * - token 与费用双预算，任一超限都暂停，reason 正确；
 * - 出口优先：预算刚好到线但出口满足 → closed，不是 paused；
 * - 暂停/恢复不丢已确认拍（正文逐字不变）；
 * - 手动逐拍不受预算阻断；
 * - job.result_json.budget 有两套 limit/used/reason。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const worlds: WriteTestWorld[] = []
const GATE_SECRET = 'integration-budget-gate'

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function harness(options: WriteWorldOptions = {}): { world: WriteTestWorld; service: WriteService } {
  const world = openWriteWorld(options)
  worlds.push(world)
  const service = new WriteService({
    host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    gateSecret: GATE_SECRET,
    send: () => undefined,
    fakeChunkDelayMs: 0,
    env: { NORYTH_WRITE_FAKE: '1' }
  })
  return { world, service }
}

function confirmedBodies(world: WriteTestWorld): Record<string, string> {
  const out: Record<string, string> = {}
  for (const beat of world.repos.beat.listLiveByChapter(world.chapterId)) {
    if (beat.status === 'confirmed' || beat.status === 'author_edited') out[beat.id] = beat.body
  }
  return out
}

function budgetJobs(world: WriteTestWorld): Array<{ status: string; result_json: string | null }> {
  return world.handle.db
    .prepare(
      "SELECT status, result_json FROM job WHERE type = 'beat.generate' AND payload_json LIKE '%auto_budget_pause%' ORDER BY created_at"
    )
    .all() as Array<{ status: string; result_json: string | null }>
}

describe('E2E-M2-BUDGET-01（集成）：双预算暂停 / 恢复', () => {
  it('费用超限：自动模式暂停，reason=cost，job.result_json 有两套数字', async () => {
    const { world, service } = harness({
      sceneCount: 1,
      beatsPerScene: 6,
      exit: 'all(fact("black_box","location"), beats(6))'
    })
    world.repos.chapter.setBudgetCny(world.chapterId, 0.004)

    const result = await service.autoStart(world.chapterId)
    expect(result.state.pauseReason).toBe('budget_exceeded')
    expect(result.state.budget.reason).toBe('cost')
    expect(result.state.budget.exceeded).toBe(true)
    expect(result.state.budget.costUsed).toBeGreaterThanOrEqual(0.004)
    expect(result.state.budget.tokensLimit).toBe(120_000)

    const confirmed = Object.keys(confirmedBodies(world)).length
    expect(confirmed).toBeGreaterThan(0)
    expect(confirmed).toBeLessThan(6)

    const paused = world.repos.schedulerEvent.listByChapter(world.chapterId).filter((event) => event.reason === 'budget_exceeded')
    expect(paused.length).toBeGreaterThanOrEqual(1)
    const payload = JSON.parse(paused[0]!.payloadJson) as {
      budget: { tokensLimit: number; costLimit: number; reason: string }
    }
    expect(payload.budget.reason).toBe('cost')
    expect(payload.budget.costLimit).toBe(0.004)

    const jobs = budgetJobs(world)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.status).toBe('paused')
    const jobBudget = (JSON.parse(jobs[0]!.result_json!) as {
      budget: {
        tokens_limit: number
        tokens_used: number
        cost_limit: number
        cost_used: number
        reason: string
      }
    }).budget
    expect(jobBudget.tokens_limit).toBe(120_000)
    expect(jobBudget.tokens_used).toBeGreaterThan(0)
    expect(jobBudget.cost_limit).toBe(0.004)
    expect(jobBudget.cost_used).toBeGreaterThanOrEqual(0.004)
    expect(jobBudget.reason).toBe('cost')

    const report = verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
    expect(report.ok, JSON.stringify(report.issues)).toBe(true)
  })

  it('token 超限：reason=tokens；提高预算后恢复，已确认拍逐字不变', async () => {
    const { world, service } = harness({
      sceneCount: 1,
      beatsPerScene: 6,
      exit: 'all(fact("black_box","location"), beats(6))'
    })
    world.repos.chapter.setBudgetTokens(world.chapterId, 1_000)

    const paused = await service.autoStart(world.chapterId)
    expect(paused.state.pauseReason).toBe('budget_exceeded')
    expect(paused.state.budget.reason).toBe('tokens')
    expect(paused.state.budget.tokensUsed).toBeGreaterThanOrEqual(1_000)
    const before = confirmedBodies(world)
    expect(Object.keys(before).length).toBeGreaterThan(0)

    // 作者提高预算 → resume 续跑；已确认拍不重生成、正文逐字不变。
    const raised = service.setBudget({ chapterId: world.chapterId, budgetTokens: 10_000_000, budgetCny: 100 })
    expect(raised.state.budget.exceeded).toBe(false)
    const resumed = await service.resume(world.chapterId)
    expect(resumed.state.chapterStatus).toBe('draft_complete')
    expect(resumed.state.pauseReason).toBeNull()

    const after = confirmedBodies(world)
    for (const [beatId, body] of Object.entries(before)) {
      expect(after[beatId]).toBe(body)
    }
    // 恢复后没有重复的预算暂停记录。
    expect(budgetJobs(world)).toHaveLength(1)
  })

  it('出口优先：预算刚好到线但出口满足 → closed，不暂停', async () => {
    const { world, service } = harness({
      sceneCount: 1,
      beatsPerScene: 3,
      exit: 'all(fact("black_box","location"), beats(1))'
    })
    // 1 拍的实际 token 已超过这个上限：出口应先生效。
    world.repos.chapter.setBudgetTokens(world.chapterId, 500)
    const result = await service.autoStart(world.chapterId)
    expect(result.state.chapterStatus).toBe('draft_complete')
    expect(result.state.pauseReason).toBeNull()
    expect(result.state.budget.exceeded).toBe(true)
    const paused = world.repos.schedulerEvent.listByChapter(world.chapterId).filter((event) => event.kind === 'paused')
    expect(paused).toHaveLength(0)
    const closed = world.repos.schedulerEvent.listByChapter(world.chapterId).filter((event) => event.kind === 'scene_closed')
    expect(closed.length).toBeGreaterThanOrEqual(1)
    expect(closed[0]!.reason).toBe('exit_satisfied')
  })

  it('手动逐拍超预算只提示、不阻断', async () => {
    const { world, service } = harness({
      sceneCount: 1,
      beatsPerScene: 3,
      exit: 'all(fact("black_box","location"), beats(3))'
    })
    world.repos.chapter.setBudgetTokens(world.chapterId, 0)
    const beat = world.repos.beat.listLiveByChapter(world.chapterId)[0]!
    const generated = await service.generate(beat.id)
    expect(generated.state.pauseReason).toBeNull()
    expect(generated.state.budget.exceeded).toBe(true)
    expect(world.repos.beat.listLiveByChapter(world.chapterId).some((entry) => entry.body.length > 0)).toBe(true)
  })

  it('预检：费用是区间，无计价时只给 token', async () => {
    const { world, service } = harness({ sceneCount: 1, beatsPerScene: 4 })
    const preflight = service.preflight(world.chapterId)
    expect(preflight.estimatedTokens.low).toBeLessThan(preflight.estimatedTokens.mid)
    expect(preflight.estimatedTokens.mid).toBeLessThan(preflight.estimatedTokens.high)
    expect(preflight.forecastBasis).toBe('default') // 还没生成过
    expect(preflight.estimatedCostCny).toBeNull() // 没有计价样本 → 不显示假费用
  })
})
