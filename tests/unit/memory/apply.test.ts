import { describe, expect, it } from 'vitest'
import { applyMemoryProposals } from '../../../src/main/memory/apply'
import { createHashEmbedder } from '../../../src/main/memory/embed/hash'
import type { Repos } from '../../../src/main/db/repos'
import { issueGate } from '../../../src/main/tools/gates'
import { sha256Hex } from '../../../src/main/crypto'
import { MEMORY_GATE_SECRET, openMemoryWorld, type MemoryTestWorld } from '../../support/memory-world'

/**
 * H3 apply 执行器（DEV-PLAN §10.3）：
 * 单事务、幂等重放、失败全回滚、单值事实 supersede、记忆 supersede。
 */

function token(world: MemoryTestWorld, proposalJobId: string, jobId: string): string {
  return issueGate({
    repos: world.handle.repos,
    secret: MEMORY_GATE_SECRET,
    projectId: world.projectId,
    gateId: 'G7',
    entityType: 'proposal',
    entityId: proposalJobId,
    revision: null,
    jobId,
    actor: 'author'
  }).token
}

async function extractAndAccept(world: MemoryTestWorld): Promise<string> {
  const result = await world.service.extract(world.chapterId)
  const state = result.state
  expect(state.proposals).toHaveLength(14)
  world.service.decideMany({
    decisions: state.proposals.map((item) => ({ itemId: item.id, decision: 'accept' as const }))
  })
  return state.jobId!
}

function countVectors(repos: Repos): number {
  return repos.memoryIndex.countVectors()
}

describe('memory apply', () => {
  it('一次应用：文本/事实/信念/边/向量/审计一起落；重放不双写', async () => {
    const world = openMemoryWorld()
    try {
      const proposalJobId = await extractAndAccept(world)
      const issued = world.service.issueG7Token(world.chapterId)
      const applied = await world.service.apply({ chapterId: world.chapterId, token: issued.token })

      // 8 条记忆 + 3 条信念 + 3 条世界事实（初始 1 条作者事实 + 3）
      expect(applied.state.entries).toHaveLength(8)
      expect(applied.state.beliefs).toHaveLength(3)
      expect(applied.state.worldFacts).toHaveLength(4)
      expect(applied.state.relationships).toHaveLength(1)
      expect(countVectors(world.handle.repos)).toBe(8)

      // 台词写成 objective 的那条被降级为 claim
      const ledger = applied.state.worldFacts.filter((fact) => fact.subject === '账本')
      expect(ledger.some((fact) => fact.truth === 'claim')).toBe(true)

      // 审计：每条记忆都有 apply 记录
      expect(applied.state.audit.filter((row) => row.action === 'apply').length).toBeGreaterThanOrEqual(11)
      // 提案条目都写成了 accept
      expect(applied.state.proposals.every((item) => item.decision === 'accept')).toBe(true)

      // 执行器层重放：同一提案 job 再跑一次 → duplicate，不双写
      const before = {
        entries: world.handle.repos.memory.listByProject(world.projectId).length,
        vectors: countVectors(world.handle.repos)
      }
      const replay = await applyMemoryProposals(
        world.handle.db,
        world.handle.repos,
        {
          projectId: world.projectId,
          proposalJobId,
          applyJobId: 'job_apply_replay',
          actor: 'author',
          decisions: [{ itemId: applied.state.proposals[0]!.id, decision: 'accept' }],
          gateTokenHash: null
        },
        createHashEmbedder()
      )
      expect(replay.duplicate).toBe(true)
      expect(world.handle.repos.memory.listByProject(world.projectId)).toHaveLength(before.entries)
      expect(countVectors(world.handle.repos)).toBe(before.vectors)
    } finally {
      world.cleanup()
    }
  })

  it('中途失败 → 文本、事实、边、向量全部回滚', async () => {
    const world = openMemoryWorld()
    try {
      const proposalJobId = await extractAndAccept(world)
      const issued = token(world, proposalJobId, 'job_apply_fail')
      const failing = failingRepos(world.handle.repos)
      const decisions = world.state().proposals.map((item) => ({ itemId: item.id, decision: 'accept' as const }))

      await expect(
        applyMemoryProposals(
          world.handle.db,
          failing,
          {
            projectId: world.projectId,
            proposalJobId,
            applyJobId: 'job_apply_fail',
            actor: 'author',
            decisions,
            gateTokenHash: sha256Hex(issued)
          },
          createHashEmbedder()
        )
      ).rejects.toThrow('boom')

      expect(world.handle.repos.memory.listByProject(world.projectId)).toHaveLength(0)
      expect(countVectors(world.handle.repos)).toBe(0)
      expect(world.handle.repos.belief.listByProject(world.projectId)).toHaveLength(0)
      expect(world.handle.repos.relationship.listActiveAll()).toHaveLength(0)
      // 初始作者事实 1 条，没有被应用批次改过
      expect(world.handle.repos.world.listByProject(world.projectId)).toHaveLength(1)
      // 决策是作者在 apply 之前就记录的，回滚不回退决策；只回滚 apply 写入
      expect(
        world.handle.repos.memoryProposal
          .listByJob(world.projectId, proposalJobId)
          .every((item) => item.decision === 'accept')
      ).toBe(true)
      // 令牌未被消费（同一事务回滚）：可以再次使用
      expect(world.handle.repos.gate.findByTokenHash(sha256Hex(issued))?.consumedAt).toBeNull()
    } finally {
      world.cleanup()
    }
  })

  it('单值事实与记忆 supersede：旧值关闭，新条目指向旧条目', async () => {
    const world = openMemoryWorld()
    try {
      await extractAndAccept(world)
      const issued = world.service.issueG7Token(world.chapterId)
      const applied = await world.service.apply({ chapterId: world.chapterId, token: issued.token })
      const repos = world.handle.repos

      const oldMemory = applied.state.entries.find((entry) => entry.kind === 'experience')!
      const oldFact = repos.world.current('雨', '强度')!
      expect(oldFact.truth).toBe('objective')

      const finalBeatId = repos.revision
        .manifest(repos.chapter.get(world.chapterId)!.finalRevisionId!)
        .find((row) => row.speakerType === 'narrator')!.beatId
      const secondJob = repos.job.insert({
        projectId: world.projectId,
        type: 'memory.extract',
        status: 'succeeded',
        expectedRevision: repos.chapter.get(world.chapterId)!.finalRevisionId,
        epoch: repos.project.get()!.writeEpoch,
        idempotencyKey: `craft:${Math.random().toString(36).slice(2)}`,
        payloadJson: JSON.stringify({ chapterId: world.chapterId })
      })
      const memoryItem = repos.memoryProposal.insert({
        projectId: world.projectId,
        jobId: secondJob.id,
        kind: 'experience',
        characterId: oldMemory.characterId,
        text: '雨停之后，她又回到祠堂',
        payloadJson: JSON.stringify({ supersedes_id: oldMemory.id }),
        sourceChapterId: oldMemory.sourceChapterId,
        sourceRevisionId: oldMemory.sourceRevisionId,
        sourceBeatId: finalBeatId
      })
      const factItem = repos.memoryProposal.insert({
        projectId: world.projectId,
        jobId: secondJob.id,
        kind: 'world_fact',
        text: '雨小了',
        payloadJson: JSON.stringify({
          subject: '雨',
          predicate: '强度',
          object: '小了',
          truth: 'objective',
          visibility: 'public',
          single_value: 1
        }),
        sourceChapterId: oldMemory.sourceChapterId,
        sourceRevisionId: oldMemory.sourceRevisionId,
        sourceBeatId: finalBeatId
      })

      const result = await applyMemoryProposals(
        world.handle.db,
        repos,
        {
          projectId: world.projectId,
          proposalJobId: secondJob.id,
          applyJobId: 'job_apply_supersede',
          actor: 'author',
          decisions: [
            { itemId: memoryItem.id, decision: 'accept' },
            { itemId: factItem.id, decision: 'accept' }
          ],
          gateTokenHash: null
        },
        createHashEmbedder()
      )

      expect(result.superseded).toContain(oldMemory.id)
      expect(result.superseded).toContain(oldFact.id)
      expect(repos.memory.get(oldMemory.id)?.status).toBe('superseded')
      expect(repos.world.get(oldFact.id)?.validToSeq).not.toBeNull()
      const fresh = repos.world.current('雨', '强度')
      expect(fresh?.object).toBe('小了')
      expect(repos.memory.listByCharacter(oldMemory.characterId).some((entry) => entry.supersedesId === oldMemory.id)).toBe(true)
    } finally {
      world.cleanup()
    }
  })

  it('同一客观三元组重复提案：不插第二行，也不报唯一索引错', async () => {
    const world = openMemoryWorld()
    try {
      const repos = world.handle.repos
      const chapter = repos.chapter.get(world.chapterId)!
      const finalBeat = repos.revision
        .manifest(chapter.finalRevisionId!)
        .find((row) => row.speakerType === 'narrator')!
      const job = repos.job.insert({
        projectId: world.projectId,
        type: 'memory.extract',
        status: 'succeeded',
        expectedRevision: chapter.finalRevisionId,
        epoch: repos.project.get()!.writeEpoch,
        idempotencyKey: 'craft:dedupe',
        payloadJson: JSON.stringify({ chapterId: chapter.id })
      })
      const item = repos.memoryProposal.insert({
        projectId: world.projectId,
        jobId: job.id,
        kind: 'world_fact',
        text: '黑漆匣子在祠堂供桌下面（重复）',
        payloadJson: JSON.stringify({
          subject: '黑漆匣子',
          predicate: '位置',
          object: '祠堂供桌下面',
          truth: 'objective',
          visibility: 'secret',
          single_value: 1
        }),
        sourceChapterId: chapter.id,
        sourceRevisionId: chapter.finalRevisionId!,
        sourceBeatId: finalBeat.beatId
      })

      const before = repos.world.listByProject(world.projectId).length
      const result = await applyMemoryProposals(
        world.handle.db,
        repos,
        {
          projectId: world.projectId,
          proposalJobId: job.id,
          applyJobId: 'job_apply_dedupe',
          actor: 'author',
          decisions: [{ itemId: item.id, decision: 'accept' }],
          gateTokenHash: null
        },
        createHashEmbedder()
      )
      expect(result.appliedCount).toBe(1)
      expect(repos.world.listByProject(world.projectId)).toHaveLength(before)
      expect(repos.memoryAudit.listByProject(world.projectId).some((row) => row.detailJson.includes('deduplicated'))).toBe(true)
    } finally {
      world.cleanup()
    }
  })
})

/** 只在 world.insert 上抛错，验证事务回滚（其它调用保持原样）。 */
function failingRepos(repos: Repos): Repos {
  return new Proxy(repos, {
    get(target, prop, receiver) {
      if (prop === 'world') {
        return new Proxy(target.world, {
          get(worldTarget, worldProp) {
            if (worldProp === 'insert') {
              return () => {
                throw new Error('boom')
              }
            }
            const value = Reflect.get(worldTarget, worldProp, worldTarget) as unknown
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(worldTarget) : value
          }
        })
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
  }) as Repos
}
