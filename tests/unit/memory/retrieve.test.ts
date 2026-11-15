import { describe, expect, it } from 'vitest'
import { createHashEmbedder, hashEmbedding } from '../../../src/main/memory/embed/hash'
import { retrieveOwn } from '../../../src/main/memory/retrieve'
import { openMemoryWorld, type MemoryTestWorld } from '../../support/memory-world'

/**
 * H3/H5 检索管线（DEV-PLAN §10.4）：
 * 可见性在 SQL、跨角色 0 命中、as_of 不越界、valid_to 过滤、pinned 独立成段。
 */

interface SeedEntry {
  characterId: string
  text: string
  learnedSeq: number
  validToSeq?: number | null
  pinned?: boolean
  importance?: number
}

function seed(world: MemoryTestWorld, entries: SeedEntry[]): string[] {
  const repos = world.handle.repos
  const chapter = repos.chapter.get(world.chapterId)!
  return entries.map((entry) => {
    const record = repos.memory.insert({
      projectId: world.projectId,
      characterId: entry.characterId,
      kind: 'experience',
      text: entry.text,
      learnedSeq: entry.learnedSeq,
      sourceChapterId: chapter.id,
      sourceRevisionId: chapter.finalRevisionId!,
      importance: entry.importance ?? 0.5,
      pinned: entry.pinned ? 1 : 0,
      validFromSeq: entry.learnedSeq,
      validToSeq: entry.validToSeq ?? null,
      embeddingModel: 'hash-bigram-v1'
    })
    repos.memoryIndex.writeVector(record.id, Array.from(hashEmbedding(entry.text)))
    repos.memoryIndex.writeBigrams(record.id, entry.characterId, entry.text)
    return record.id
  })
}

describe('memory retrieve', () => {
  it('只召回本人记忆；as_of 与 valid_to 在 SQL 过滤；pinned 独立', async () => {
    const world = openMemoryWorld()
    try {
      const [first, second] = world.characterIds
      const seqHead = world.handle.repos.project.get()!.seqHead
      const [own, future, expired, pinnedOwn] = seed(world, [
        { characterId: first!, text: '账本在祠堂的供桌下面', learnedSeq: 1, importance: 0.9 },
        { characterId: first!, text: '账本明天会出现在码头', learnedSeq: seqHead + 5 },
        { characterId: first!, text: '账本已经被烧掉了', learnedSeq: 1, validToSeq: seqHead },
        { characterId: first!, text: '母亲留下的银锁', learnedSeq: 1, pinned: true }
      ])
      seed(world, [{ characterId: second!, text: '账本在祠堂，她也知道', learnedSeq: 1 }])

      const result = await retrieveOwn(
        world.handle.repos,
        createHashEmbedder(),
        { text: '账本 祠堂', topK: 5 },
        {
          projectId: world.projectId,
          actorId: `character:${first}`,
          characterId: first!,
          asOf: seqHead
        }
      )

      const ids = [...result.items, ...result.pinned].map((item) => item.entry.id)
      expect(ids).toContain(own)
      expect(ids).toContain(pinnedOwn)
      expect(ids).not.toContain(future)
      expect(ids).not.toContain(expired)
      // 跨角色：无论查询词多像，别人的条目一条都不出现
      for (const item of [...result.items, ...result.pinned]) {
        expect(item.entry.characterId).toBe(first)
      }
      expect(result.pinned.some((item) => item.entry.id === pinnedOwn)).toBe(true)
      expect(result.empty).toBe(false)
    } finally {
      world.cleanup()
    }
  })

  it('跨角色查询对方原文 → 0 命中', async () => {
    const world = openMemoryWorld()
    try {
      const [first, second] = world.characterIds
      seed(world, [{ characterId: second!, text: '只有她知道的黑漆匣子秘密', learnedSeq: 1 }])
      const result = await retrieveOwn(
        world.handle.repos,
        createHashEmbedder(),
        { text: '黑漆匣子秘密', topK: 5 },
        {
          projectId: world.projectId,
          actorId: `character:${first}`,
          characterId: first!,
          asOf: 10
        }
      )
      expect(result.items).toHaveLength(0)
      expect(result.pinned).toHaveLength(0)
      expect(result.empty).toBe(true)
      expect(result.degraded).toBe('empty')
    } finally {
      world.cleanup()
    }
  })

  it('没有嵌入器时降级为关键词通道，仍能命中', async () => {
    const world = openMemoryWorld()
    try {
      const first = world.characterIds[0]!
      const [id] = seed(world, [{ characterId: first, text: '账本在祠堂的供桌下面', learnedSeq: 1 }])
      const result = await retrieveOwn(
        world.handle.repos,
        null,
        { text: '账本祠堂', topK: 5 },
        { projectId: world.projectId, actorId: `character:${first}`, characterId: first, asOf: 10 }
      )
      expect(result.items.map((item) => item.entry.id)).toContain(id)
      expect(result.stats.vectorHits).toBe(0)
      expect(result.stats.keywordHits).toBeGreaterThan(0)
    } finally {
      world.cleanup()
    }
  })
})
