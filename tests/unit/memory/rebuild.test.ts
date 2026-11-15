import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { rebuildChapter, rebuildCloseAtSeq } from '../../../src/main/memory/rebuild'
import { createHashEmbedder } from '../../../src/main/memory/embed/hash'
import { verifyDatabase } from '../../../src/main/db/verify'
import { openMemoryWorld, type MemoryTestWorld } from '../../support/memory-world'

/**
 * 按章重建（PHASE-14 M1-4 / DEV-PLAN §10.6）。
 *
 * 验收要证明的四件事：
 *   1. 旧条目 `inactive`（不物理删除），新条目 `active`；
 *   2. 旧事实 / 关系边按来源关闭、作者手写事实不受影响；
 *   3. 重放同一任务 → duplicate，不双写；
 *   4. 事务中途失败 → 旧条目仍 active、旧事实未关、令牌可重试。
 */

async function applyInitialMemory(world: MemoryTestWorld): Promise<void> {
  const extracted = await world.service.extract(world.chapterId)
  expect(extracted.state.proposals).toHaveLength(14)
  world.service.decideMany({
    decisions: extracted.state.proposals.map((item) => ({ itemId: item.id, decision: 'accept' as const }))
  })
  const issued = world.service.issueG7Token(world.chapterId)
  await world.service.apply({ chapterId: world.chapterId, token: issued.token })
}

function evidenceOf(world: MemoryTestWorld): { beatId: string; quote: string } {
  const chapter = world.handle.repos.chapter.get(world.chapterId)!
  const member = world.handle.repos.revision.manifest(chapter.finalRevisionId!)[0]!
  return { beatId: member.beatId, quote: member.body.slice(0, 12) }
}

describe('按章重建（memory.rebuild / T40）', () => {
  it('旧条目 inactive、新条目 active，事实/边按来源关闭，审计有 rebuild', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const before = world.service.state(world.chapterId)
      expect(before.entries).toHaveLength(8)
      const beforeIds = before.entries.map((entry) => entry.id)
      expect(before.rebuild.allowed).toBe(true)
      expect(before.rebuild.entryCount).toBe(8)

      const issued = world.service.issueRebuildToken(world.chapterId)
      expect(issued.preview.entryCount).toBe(8)
      expect(issued.preview.factCount).toBe(3)
      expect(issued.preview.edgeCount).toBe(1)

      const rebuilt = await world.service.rebuild({ chapterId: world.chapterId, token: issued.token })
      const state = rebuilt.state

      // 1) 旧条目还在（inactive），新条目 active，且 id 不重叠
      const rows = world.handle.repos.memory.listBySource(world.chapterId)
      const inactive = rows.filter((row) => row.status === 'inactive').map((row) => row.id)
      expect(inactive.sort()).toEqual([...beforeIds].sort())
      expect(rows.length).toBe(16)
      // 记忆浏览是全状态列表：旧条目以 inactive 出现，新条目 active
      expect(state.entries).toHaveLength(16)
      const active = state.entries.filter((entry) => entry.status === 'active')
      expect(active).toHaveLength(8)
      expect(active.some((entry) => beforeIds.includes(entry.id))).toBe(false)

      // 2) 事实：作者手写优先，不因重建失效；旧记忆事实关闭，新事实有效
      const facts = world.handle.repos.world.listByProject(world.projectId)
      expect(facts.filter((fact) => fact.sourceType === 'author').every((fact) => fact.validToSeq === null)).toBe(true)
      const memoryFacts = facts.filter((fact) => fact.sourceType === 'memory')
      expect(memoryFacts.filter((fact) => fact.validToSeq !== null)).toHaveLength(3)
      expect(memoryFacts.filter((fact) => fact.validToSeq === null)).toHaveLength(3)

      // 关系边：旧边关闭、新边有效；旧边的 supersedes 链保留
      const edges = world.handle.repos.relationship.listByProject(world.projectId)
      expect(edges.filter((edge) => edge.validToSeq === null)).toHaveLength(1)
      expect(edges.filter((edge) => edge.validToSeq !== null)).toHaveLength(1)

      // 信念：旧信念软失效，新信念生效
      const beliefs = world.handle.repos.belief.listByProject(world.projectId)
      expect(beliefs.filter((belief) => belief.status === 'inactive')).toHaveLength(3)
      expect(beliefs.filter((belief) => belief.status === 'active')).toHaveLength(3)

      // 3) 审计：一条 rebuild 汇总 + 每条旧物的 invalidate
      const audit = world.handle.repos.memoryAudit.listByProject(world.projectId, 500)
      const rebuildRows = audit.filter((row) => row.action === 'rebuild')
      expect(rebuildRows).toHaveLength(1)
      const detail = JSON.parse(rebuildRows[0]!.detailJson) as Record<string, unknown>
      expect(detail.chapterId).toBe(world.chapterId)
      expect(detail.inactive).toBe(8)
      expect(detail.rebuilt).toBe(8)
      expect(audit.filter((row) => row.action === 'invalidate' && JSON.parse(row.detailJson).reason === 'rebuild').length).toBeGreaterThanOrEqual(8 + 3 + 3 + 1)

      expect(state.rebuild.jobStatus).toBe('applied')
      expect(state.rebuild.inactiveCount).toBe(8)
      expect(state.rebuild.rebuiltCount).toBe(8)

      // 4) db.verify 仍全绿；版本计数符合预期
      const report = verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    } finally {
      world.cleanup()
    }
  })

  it('重放同一章同一份定稿：duplicate，不双写', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const first = world.service.issueRebuildToken(world.chapterId)
      const rebuilt = await world.service.rebuild({ chapterId: world.chapterId, token: first.token })
      expect(rebuilt.state.entries.filter((entry) => entry.status === 'active')).toHaveLength(8)

      const counts = {
        entries: world.handle.repos.memory.listBySource(world.chapterId).length,
        facts: world.handle.repos.world.listByProject(world.projectId).length,
        edges: world.handle.repos.relationship.listByProject(world.projectId).length
      }
      const second = world.service.issueRebuildToken(world.chapterId)
      const replay = await world.service.rebuild({ chapterId: world.chapterId, token: second.token })
      expect(replay.detail).toContain('重放')
      expect(world.handle.repos.memory.listBySource(world.chapterId).length).toBe(counts.entries)
      expect(world.handle.repos.world.listByProject(world.projectId).length).toBe(counts.facts)
      expect(world.handle.repos.relationship.listByProject(world.projectId).length).toBe(counts.edges)
    } finally {
      world.cleanup()
    }
  })

  it('没有 author_confirm：gate_required / stale_revision，且零写入', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const before = world.handle.repos.memory.listBySource(world.chapterId).map((row) => row.status)
      await expect(
        world.service.rebuild({ chapterId: world.chapterId, token: 'not-a-token' })
      ).rejects.toBeInstanceOf(AppError)
      const after = world.handle.repos.memory.listBySource(world.chapterId)
      expect(after.map((row) => row.status)).toEqual(before)
      expect(world.handle.repos.job.findByIdempotency(world.projectId, 'memory.rebuild:' + world.projectId + ':' + world.chapterId + ':' + world.handle.repos.chapter.get(world.chapterId)!.finalRevisionId)).toBeNull()
    } finally {
      world.cleanup()
    }
  })

  it('事务中途失败：旧条目仍 active、旧事实未关、可重试', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const chapter = world.handle.repos.chapter.get(world.chapterId)!
      const beforeEntries = world.service.state(world.chapterId).entries
      const beforeLiveFacts = world.handle.repos.world
        .listByProject(world.projectId)
        .filter((fact) => fact.validToSeq === null).length

      // 一个「会炸」的重建提案：关系边 from == to 触发 CHECK(from_id <> to_id)。
      const proposalJob = world.handle.repos.job.insert({
        projectId: world.projectId,
        type: 'memory.extract',
        status: 'running',
        expectedRevision: chapter.finalRevisionId,
        epoch: 1,
        idempotencyKey: 'test-rebuild-extract',
        payloadJson: JSON.stringify({ chapterId: chapter.id, revisionId: chapter.finalRevisionId })
      })
      const evidence = evidenceOf(world)
      world.handle.repos.memoryProposal.insert({
        projectId: world.projectId,
        jobId: proposalJob.id,
        kind: 'relationship',
        characterId: world.characterIds[0]!,
        text: '自反关系（测试用）',
        payloadJson: JSON.stringify({ to_id: world.characterIds[0]!, axis: 'trust', value: 0.5 }),
        sourceChapterId: chapter.id,
        sourceRevisionId: chapter.finalRevisionId!,
        sourceBeatId: evidence.beatId,
        evidenceQuote: evidence.quote,
        importance: 0.5
      })
      const rebuildJob = world.handle.repos.job.insert({
        projectId: world.projectId,
        type: 'memory.rebuild',
        status: 'running',
        expectedRevision: chapter.finalRevisionId,
        epoch: 1,
        idempotencyKey: `memory.rebuild:${world.projectId}:${chapter.id}:${chapter.finalRevisionId}`,
        payloadJson: JSON.stringify({ chapterId: chapter.id })
      })

      await expect(
        rebuildChapter(
          world.handle.db,
          world.handle.repos,
          {
            projectId: world.projectId,
            chapterId: chapter.id,
            rebuildJobId: rebuildJob.id,
            proposalJobId: proposalJob.id,
            actor: 'author',
            gateTokenHash: null,
            decisions: [{ itemId: world.handle.repos.memoryProposal.listByJob(world.projectId, proposalJob.id)[0]!.id, decision: 'accept' }]
          },
          createHashEmbedder()
        )
      ).rejects.toThrow(/CHECK constraint/)

      // 整批回滚：旧条目仍 active、没有新条目、旧事实/边没有新增关闭
      const entries = world.handle.repos.memory.listBySource(world.chapterId)
      expect(entries.map((row) => row.id).sort()).toEqual(beforeEntries.map((entry) => entry.id).sort())
      expect(entries.every((row) => row.status === 'active')).toBe(true)
      expect(world.handle.repos.world.listByProject(world.projectId).filter((fact) => fact.validToSeq === null)).toHaveLength(beforeLiveFacts)
      expect(
        world.handle.repos.memoryAudit.listByProject(world.projectId, 500).filter((row) => row.action === 'rebuild')
      ).toHaveLength(0)
    } finally {
      world.cleanup()
    }
  })

  it('重建水位取本章 covered_until_seq', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const chapter = world.handle.repos.chapter.get(world.chapterId)!
      expect(rebuildCloseAtSeq(world.handle.repos, world.chapterId)).toBe(chapter.coveredUntilSeq)
      expect(chapter.coveredUntilSeq).toBeGreaterThan(0)
    } finally {
      world.cleanup()
    }
  })
})
