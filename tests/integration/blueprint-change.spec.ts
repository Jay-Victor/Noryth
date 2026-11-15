import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/shared/domain/app-error'
import { PlanService, type PlanHost } from '../../src/main/plan/service'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { SettingsSchema } from '../../src/shared/schema/project'
import { openPlanWorld, seedPostG1, type PlanTestWorld } from '../support/plan-world'

/**
 * 阶段 15 集成（M1-8 / M1-11）：规划台服务层的变更流程。
 *
 * 走真实 SQLite + 真实 service（只把模型换成不可用：本轮不发消息）。
 * 断言的是网关顺序：覆盖检查 → 提案 → 影响分析 → 应用 → 标脏 → 忽略。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const worlds: PlanTestWorld[] = []

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function setup(): { world: PlanTestWorld; post: ReturnType<typeof seedPostG1>; service: PlanService; host: PlanHost } {
  const world = openPlanWorld()
  worlds.push(world)
  const post = seedPostG1(world)
  const host: PlanHost = { dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }
  const service = new PlanService({
    host: () => host,
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    emit: () => {},
    emitChoice: () => {}
  })
  return { world, post, service, host }
}

function codeOf(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return error instanceof AppError ? error.code : 'unknown'
  }
}

describe('阶段 15 蓝图变更流程（服务层）', () => {
  it('覆盖检查：G1 前后都可查；G1 后开关被拒（不再影响 G1）', () => {
    const { service } = setup()
    const coverage = service.coverage()
    expect(coverage.locked).toBe(true)
    expect(coverage.gate).toBe(true)
    // meta 全空 → 只有「未标注」建议
    expect(coverage.errorCount).toBe(0)
    expect(coverage.warnCount).toBeGreaterThan(0)
    expect(codeOf(() => service.setCoverageGate({ enabled: false }))).toBe('invalid_args')
  })

  it('G1 后提案 → 影响分析 → 应用：蓝图 +1、章标脏、正文不变', () => {
    const { world, post, service } = setup()
    const proposal = world.repos.proposal.insert({
      projectId: world.projectId,
      kind: 'blueprint_patch',
      jobId: 'job_change',
      turnId: 'turn_change',
      payloadJson: JSON.stringify({ ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷 · 改' }] }),
      summaryJson: JSON.stringify({ added: 0, updated: 1, removed: 0, requires_change: true })
    })

    // 未分析直接应用 → invalid_args，DB 不变
    const raw = world.repos.blueprintChange.insert({
      projectId: world.projectId,
      opsJson: JSON.stringify({ ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷 · 改' }] }),
      actor: 'author'
    })
    expect(codeOf(() => service.applyChange({ changeId: raw.id }))).toBe('invalid_args')
    expect(world.repos.outline.get(post.volumeId)!.title).not.toBe('第一卷 · 改')

    const change = service.analyzeImpact({ proposalId: proposal.id })
    expect(change.status).toBe('proposed')
    expect(change.impact?.counts.chapters).toBe(2)
    expect(change.impact?.counts.memory_entries).toBe(1)

    const before = world.repos.beat.listLiveByChapter(post.chapter1Id)[0]!
    const applied = service.applyChange({ changeId: change.id })
    expect(applied.blueprintVersion).toBe(2)
    expect(applied.invalidatedChapters).toHaveLength(2)
    expect(world.repos.outline.get(post.volumeId)!.title).toBe('第一卷 · 改')
    expect(world.repos.proposal.get(proposal.id)!.status).toBe('applied')
    expect(world.repos.beat.listLiveByChapter(post.chapter1Id)[0]!.body).toBe(before.body)
    expect(world.repos.chapter.get(post.chapter1Id)!.invalidatedAt).not.toBeNull()

    const state = service.getState()
    expect(state.changes[0]!.id).toBe(change.id)
    expect(state.changes[0]!.status).toBe('applied')
    expect(service.listChanges()).toHaveLength(2)
  })

  it('角色卡提案走同一条变更流程（受影响章 / 卡版本 / 标脏）', () => {
    const { world, post, service } = setup()
    const proposal = world.repos.proposal.insert({
      projectId: world.projectId,
      kind: 'character_card',
      jobId: 'job_card',
      turnId: 'turn_card',
      payloadJson: JSON.stringify({
        character_id: post.characterId,
        target: 'plan',
        card: { identity: '新身份', want: '新动机' }
      }),
      summaryJson: JSON.stringify({ character_name: '沈昼' })
    })
    const change = service.analyzeImpact({ proposalId: proposal.id })
    expect(change.summary.characterCards).toBe(1)
    expect(change.impact?.counts.chapters).toBe(1)
    service.applyChange({ changeId: change.id })
    expect(world.repos.planCharacter.get(post.characterId)!.cardVersion).toBe(2)
    expect(world.repos.chapter.get(post.chapter1Id)!.invalidatedAt).not.toBeNull()
  })

  it('拒绝变更与忽略标脏：都不改正文、不改章状态', () => {
    const { world, post, service } = setup()
    const change = service.analyzeImpact({
      ops: [{ op: 'update', node_id: post.chapter1NodeId, title: '第一章 · 改' }]
    })
    const rejected = service.rejectChange({ changeId: change.id })
    expect(rejected.status).toBe('rejected')
    expect(world.repos.outline.get(post.chapter1NodeId)!.title).not.toBe('第一章 · 改')

    const applied = service.analyzeImpact({ ops: [{ op: 'update', node_id: post.chapter1NodeId, title: '第一章 · 改' }] })
    service.applyChange({ changeId: applied.id })
    const beforeStatus = world.repos.chapter.get(post.chapter1Id)!.status
    expect(service.dismissInvalidation({ chapterId: post.chapter1Id })).toEqual({ dismissed: true })
    const after = world.repos.chapter.get(post.chapter1Id)!
    expect(after.invalidatedAt).toBeNull()
    expect(after.status).toBe(beforeStatus)
    expect(after.currentRevisionId).not.toBeNull()
  })

  it('注册清单提案不能做影响分析；未知提案一律 invalid_args', () => {
    const { world, service } = setup()
    const roster = world.repos.proposal.insert({
      projectId: world.projectId,
      kind: 'roster',
      jobId: 'job_roster',
      turnId: 'turn_roster',
      payloadJson: JSON.stringify({ roster: { characters: [], initial_facts: [] } })
    })
    expect(codeOf(() => service.analyzeImpact({ proposalId: roster.id }))).toBe('invalid_args')
    expect(codeOf(() => service.analyzeImpact({ proposalId: 'ap_missing' }))).toBe('invalid_args')
    expect(codeOf(() => service.analyzeImpact({}))).toBe('invalid_args')
  })
})
