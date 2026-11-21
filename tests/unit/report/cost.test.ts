import { afterEach, describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { confirmBeat } from '../../../src/main/doc/beats'
import { buildCostReport, percentile } from '../../../src/main/report/cost'
import type { WriteTestWorld } from '../../support/write-world'
import { openWriteWorld } from '../../support/write-world'

/**
 * 成本/耗时报表（PHASE-20 §5.5 / M2-5，COST-M2-01）：
 * - 合计 = turn_metric 直接汇总；
 * - byChapter + projectLevel = total；
 * - 每万字与字数口径一致（revision 清单）；
 * - 项目级规划费用单列；
 * - 每拍确认耗时只统计作者确认；
 * - 无 N+1（查询计数）。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): WriteTestWorld {
  const created = openWriteWorld({ sceneCount: 1, beatsPerScene: 3 })
  worlds.push(created)
  return created
}

/** 生产路径等价：commitBeat（唯一正文写入者）+ 作者确认。 */
function writeAndConfirm(w: WriteTestWorld, beatId: string, body: string): void {
  const beat = w.repos.beat.get(beatId)!
  const chapter = w.repos.chapter.get(w.chapterId)!
  const project = w.repos.project.get()!
  const committed = commitBeat(w.handle.db, w.repos, {
    chapterId: w.chapterId,
    expectedRevision: chapter.currentRevisionId,
    epoch: project.writeEpoch,
    sceneId: beat.sceneId,
    ord: beat.ord,
    speakerType: beat.speakerType,
    speakerId: beat.speakerId,
    body,
    intent: beat.intent,
    supersedesId: beat.id,
    status: 'draft',
    maxWords: beat.maxWords
  })
  confirmBeat(w.handle.db, w.repos, committed.beatId)
}

function seed(w: WriteTestWorld): void {
  w.beatIds.forEach((beatId, index) => writeAndConfirm(w, beatId, `一二三四${'五六七八九十'[index]}`))

  const insert = (input: {
    turnId: string
    chapterId: string | null
    agentKey: string
    tokensIn: number
    tokensOut: number
    costCny: number | null
    latencyMs: number
    createdAt: string
  }): void => {
    w.repos.turnMetric.insert({
      turnId: input.turnId,
      projectId: w.projectId,
      jobId: `job_${input.turnId}`,
      beatId: null,
      chapterId: input.chapterId,
      agentKey: input.agentKey,
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 1,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costCny: input.costCny,
      latencyMs: input.latencyMs,
      firstTokenMs: null,
      contextJson: '{}',
      createdAt: input.createdAt
    })
  }

  // 写拍 3 行：0.03 元 / 3000 tokens。
  insert({ turnId: 't1', chapterId: w.chapterId, agentKey: 'narrator', tokensIn: 700, tokensOut: 300, costCny: 0.01, latencyMs: 100, createdAt: '2026-01-01T00:00:01.000Z' })
  insert({ turnId: 't2', chapterId: w.chapterId, agentKey: 'narrator', tokensIn: 700, tokensOut: 300, costCny: 0.01, latencyMs: 200, createdAt: '2026-01-01T00:00:02.000Z' })
  insert({ turnId: 't3', chapterId: w.chapterId, agentKey: 'narrator', tokensIn: 700, tokensOut: 300, costCny: 0.01, latencyMs: 300, createdAt: '2026-01-01T00:00:03.000Z' })
  // 审批 1 行：有计价。
  insert({ turnId: 'r1', chapterId: w.chapterId, agentKey: 'reviewer', tokensIn: 200, tokensOut: 100, costCny: 0.002, latencyMs: 400, createdAt: '2026-01-01T00:00:04.000Z' })
  // 记忆 1 行：无计价 → unpricedCalls=1，费用是下限。
  insert({ turnId: 'm1', chapterId: w.chapterId, agentKey: 'memory', tokensIn: 100, tokensOut: 50, costCny: null, latencyMs: 500, createdAt: '2026-01-01T00:00:05.000Z' })
  // 规划 1 行：项目级（chapter_id = NULL）。
  insert({ turnId: 'p1', chapterId: null, agentKey: 'planner', tokensIn: 500, tokensOut: 250, costCny: 0.005, latencyMs: 600, createdAt: '2026-01-01T00:00:06.000Z' })

  // 每拍确认耗时：t1 500ms、t2 缺失（自动确认）、t3 300ms。
  const event = (kind: 'beat_committed' | 'beat_confirmed', beatId: string, at: string): void => {
    w.repos.schedulerEvent.insert({
      projectId: w.projectId,
      chapterId: w.chapterId,
      jobId: null,
      kind,
      reason: null,
      payloadJson: JSON.stringify({ beatId }),
      createdAt: at
    })
  }
  const beats = w.repos.beat.listLiveByChapter(w.chapterId)
  event('beat_committed', beats[0]!.id, '2026-01-01T00:01:00.000Z')
  event('beat_confirmed', beats[0]!.id, '2026-01-01T00:01:00.500Z')
  event('beat_committed', beats[1]!.id, '2026-01-01T00:02:00.000Z')
  event('beat_committed', beats[2]!.id, '2026-01-01T00:03:00.000Z')
  event('beat_confirmed', beats[2]!.id, '2026-01-01T00:03:00.300Z')
}

describe('buildCostReport', () => {
  it('合计 = 直接汇总；byChapter + projectLevel = total；每万字口径一致', () => {
    const w = world()
    seed(w)
    const report = buildCostReport(w.repos)

    expect(report.total.tokensIn).toBe(700 * 3 + 200 + 100 + 500)
    expect(report.total.tokensOut).toBe(300 * 3 + 100 + 50 + 250)
    expect(report.total.costCny).toBeCloseTo(0.037, 6)
    expect(report.total.pricedCalls).toBe(5)
    expect(report.total.unpricedCalls).toBe(1)

    const chapterCost = report.byChapter.reduce((sum, row) => sum + row.costCny, 0)
    expect(chapterCost + report.projectLevel.costCny).toBeCloseTo(report.total.costCny, 6)
    const chapterTokens = report.byChapter.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0)
    expect(chapterTokens + report.projectLevel.tokensIn + report.projectLevel.tokensOut).toBe(
      report.total.tokensIn + report.total.tokensOut
    )

    // 3 拍 × 5 字 = 15 字（只读 revision 清单，不读 live 拍）。
    expect(report.total.words).toBe(15)
    const row = report.byChapter.find((entry) => entry.chapterId === w.chapterId)!
    expect(row.words).toBe(15)
    expect(row.costPer10k).toBeCloseTo((0.032 / 15) * 10_000, 3)
    expect(report.total.costPer10k).toBeCloseTo((0.037 / 15) * 10_000, 3)

    // 项目级单列，不摊到章。
    expect(report.projectLevel).toEqual({ tokensIn: 500, tokensOut: 250, costCny: 0.005, calls: 1 })
    expect(report.shareBasis).toBe('cost')
    const shareSum = report.byAgent.reduce((sum, agent) => sum + agent.share, 0)
    expect(shareSum).toBeCloseTo(1, 3)
    expect(report.byAgent.map((agent) => agent.agentKey)).toEqual([
      'narrator',
      'planner',
      'reviewer',
      'memory'
    ])
    expect(report.byAgent.find((agent) => agent.agentKey === 'memory')!.unpricedCalls).toBe(1)
  })

  it('每拍确认耗时来自 scheduler_event（自动确认缺失不补 0）', () => {
    const w = world()
    seed(w)
    const report = buildCostReport(w.repos)
    expect(report.confirm.samples).toBe(2)
    expect(report.confirm.p50).toBe(400)
    expect(report.confirm.p95).toBeNull() // 样本 <5
    expect(report.confirm.missingBeats).toBe(1)
  })

  it('本章范围：项目级归零，只有该章的行；删除章显示「已删除章」', () => {
    const w = world()
    seed(w)
    w.repos.turnMetric.insert({
      turnId: 'gone',
      projectId: w.projectId,
      jobId: 'job_gone',
      beatId: null,
      chapterId: 'ch_deleted',
      agentKey: 'reviewer',
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 1,
      tokensIn: 10,
      tokensOut: 10,
      costCny: 0.001,
      latencyMs: 10,
      firstTokenMs: null,
      contextJson: '{}',
      createdAt: '2026-01-01T00:00:07.000Z'
    })

    const book = buildCostReport(w.repos)
    const deleted = book.byChapter.find((row) => row.chapterId === 'ch_deleted')!
    expect(deleted.title).toBe('已删除章')
    expect(deleted.ord).toBe(0)
    expect(deleted.words).toBe(0)
    expect(deleted.costPer10k).toBeNull()

    const chapter = buildCostReport(w.repos, { chapterId: w.chapterId })
    expect(chapter.byChapter).toHaveLength(1)
    expect(chapter.projectLevel).toEqual({ tokensIn: 0, tokensOut: 0, costCny: 0, calls: 0 })
    expect(chapter.total.costCny).toBeCloseTo(0.032, 6)
    expect(chapter.confirm.missingBeats).toBe(1)
  })

  it('空项目：全 0、空态、无假数字', () => {
    const w = world()
    const report = buildCostReport(w.repos)
    expect(report.total).toMatchObject({ tokensIn: 0, tokensOut: 0, costCny: 0, words: 0, costPer10k: null })
    expect(report.byChapter.map((row) => row.chapterId)).toEqual([w.chapterId])
    expect(report.byChapter[0]!.costPer10k).toBeNull()
    expect(report.byAgent).toEqual([])
    expect(report.shareBasis).toBe('tokens')
    expect(report.confirm).toEqual({ samples: 0, p50: null, p95: null, missingBeats: 0 })
  })

  it('COST-M2-01：一次聚合，无 N+1（查询计数 ≤ 8）', () => {
    const w = world()
    seed(w)
    const original = w.handle.db.prepare.bind(w.handle.db)
    let queries = 0
    ;(w.handle.db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
      queries += 1
      return original(sql)
    }) as typeof original
    try {
      buildCostReport(w.repos)
    } finally {
      ;(w.handle.db as unknown as { prepare: typeof original }).prepare = original
    }
    expect(queries).toBeLessThanOrEqual(8)
  })

  it('百分位：线性插值，单样本 P95 = null', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([10], 0.95)).toBe(10)
    expect(percentile([10, 20], 0.5)).toBe(15)
    expect(percentile([100, 200, 300, 400, 500], 0.95)).toBe(480)
  })

  it('非法输入：from 晚于 to / 未知章', () => {
    const w = world()
    expect(() => buildCostReport(w.repos, { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' })).toThrow()
    expect(() => buildCostReport(w.repos, { chapterId: 'ch_missing' })).toThrow()
    expect(() => buildCostReport(w.repos, { from: 'not-a-date' })).toThrow()
  })
})
