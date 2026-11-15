import { describe, expect, it } from 'vitest'
import { reindexProject } from '../../../src/main/memory/reindex'
import { createHashEmbedder } from '../../../src/main/memory/embed/hash'
import type { EmbedKind, Embedder } from '../../../src/main/memory/embed/types'
import { openMemoryWorld, type MemoryTestWorld } from '../../support/memory-world'

/**
 * 索引重建（PHASE-14 M1-20 / DEV-PLAN §10.5）。
 *
 * 验收要证明的四件事：
 *   1. 分批：`embedding_model != 当前模型` 的 active 条目按批重算，改模型名与换向量同事务；
 *   2. 可恢复：中途失败时已提交的批次保留，重试从剩余条目继续；
 *   3. 无半条向量：每一步之后 `memory_vec` 行数与条目数一致；
 *   4. 令牌：成功后消费；pending = 0 时不再签发。
 */

class TestEmbedder implements Embedder {
  readonly dim = 512
  readonly source = 'model' as const
  calls = 0
  constructor(
    readonly model: string,
    private readonly failAtCall: number | null = null
  ) {}

  async embed(texts: readonly string[], _kind: EmbedKind = 'doc'): Promise<Float32Array[]> {
    this.calls += 1
    if (this.failAtCall !== null && this.calls === this.failAtCall) {
      throw new Error('embedding worker died (test)')
    }
    const base = createHashEmbedder()
    return base.embed(texts, 'doc')
  }

  async dispose(): Promise<void> {
    // 无外部资源
  }
}

async function seedAppliedMemory(world: MemoryTestWorld): Promise<void> {
  const extracted = await world.service.extract(world.chapterId)
  world.service.decideMany({
    decisions: extracted.state.proposals.map((item) => ({ itemId: item.id, decision: 'accept' as const }))
  })
  const issued = world.service.issueG7Token(world.chapterId)
  await world.service.apply({ chapterId: world.chapterId, token: issued.token })
}

/** 模拟「换过模型」：条目声称自己是 bge，但向量还是旧的哈希。 */
function relabelAsBge(world: MemoryTestWorld): void {
  world.handle.db.prepare("UPDATE memory_entry SET embedding_model = 'bge-small-zh-v1.5'").run()
}

describe('索引重建（index.rebuild）', () => {
  it('按当前模型分批重算；完成后 pending = 0，向量行数不变', async () => {
    const world = openMemoryWorld()
    try {
      await seedAppliedMemory(world)
      expect(world.handle.repos.memory.listByProject(world.projectId, { status: 'active' })).toHaveLength(8)
      relabelAsBge(world)

      const state = world.service.state(world.chapterId)
      expect(state.embedding.pendingCount).toBe(8)
      expect(state.index.pendingCount).toBe(8)
      expect(state.index.totalCount).toBe(8)
      expect(state.index.allowed).toBe(true)

      const issued = world.service.issueIndexToken()
      expect(issued.preview.pendingCount).toBe(8)
      const result = await world.service.reindex({ token: issued.token })
      expect(result.state.index.pendingCount).toBe(0)
      expect(result.state.embedding.pendingCount).toBe(0)
      expect(result.state.index.rebuiltCount).toBe(8)
      expect(result.state.index.jobStatus).toBe('applied')

      const entries = world.handle.repos.memory.listByProject(world.projectId, { status: 'active' })
      expect(entries.every((entry) => entry.embeddingModel === createHashEmbedder().model)).toBe(true)
      const row = world.handle.db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
      expect(row.count).toBe(entries.length)
    } finally {
      world.cleanup()
    }
  })

  it('中途失败：已提交的批次保留，重试从剩余条目继续（无半条向量）', async () => {
    const world = openMemoryWorld()
    try {
      await seedAppliedMemory(world)
      relabelAsBge(world)
      const job = world.handle.repos.job.insert({
        projectId: world.projectId,
        type: 'index.rebuild',
        status: 'running',
        epoch: 1,
        idempotencyKey: 'index.rebuild:test:1',
        payloadJson: JSON.stringify({ model: 'test-v2' })
      })

      const flaky = new TestEmbedder('test-v2', 2)
      await expect(
        reindexProject(
          world.handle.db,
          world.handle.repos,
          { projectId: world.projectId, jobId: job.id, actor: 'author', gateTokenHash: null, batchSize: 3 },
          flaky
        )
      ).rejects.toThrow('embedding worker died')

      const afterFailure = world.handle.repos.memory.listByProject(world.projectId, { status: 'active' })
      const migrated = afterFailure.filter((entry) => entry.embeddingModel === 'test-v2')
      expect(migrated).toHaveLength(3)
      expect(afterFailure.filter((entry) => entry.embeddingModel === 'bge-small-zh-v1.5')).toHaveLength(5)
      const vecRow = world.handle.db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
      expect(vecRow.count).toBe(afterFailure.length)

      const stored = world.handle.repos.job.get(job.id)!
      const progress = stored.resultJson === null ? {} : (JSON.parse(stored.resultJson) as Record<string, unknown>)
      expect(progress.done).toBe(false)
      expect(progress.rebuilt).toBe(3)

      // 重启后继续：同一 job 从 3 条已完成的进度接着跑
      const resumed = await reindexProject(
        world.handle.db,
        world.handle.repos,
        { projectId: world.projectId, jobId: job.id, actor: 'author', gateTokenHash: null, batchSize: 3 },
        new TestEmbedder('test-v2')
      )
      expect(resumed.rebuiltCount).toBe(8)
      expect(resumed.remaining).toBe(0)
      const finalEntries = world.handle.repos.memory.listByProject(world.projectId, { status: 'active' })
      expect(finalEntries.every((entry) => entry.embeddingModel === 'test-v2')).toBe(true)
      const finalVectors = world.handle.db.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
      expect(finalVectors.count).toBe(finalEntries.length)
    } finally {
      world.cleanup()
    }
  })

  it('pending = 0 时不签发令牌；索引用当前模型后不再重建', async () => {
    const world = openMemoryWorld()
    try {
      await seedAppliedMemory(world)
      const state = world.service.state(world.chapterId)
      expect(state.index.pendingCount).toBe(0)
      expect(state.index.allowed).toBe(false)
      expect(() => world.service.issueIndexToken()).toThrow()
      const result = await world.service.reindex({ token: 'irrelevant' })
      expect(result.detail).toContain('无需重建')
    } finally {
      world.cleanup()
    }
  })
})
