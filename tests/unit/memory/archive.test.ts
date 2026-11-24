import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { archiveBatchId, buildArchiveCandidates, ARCHIVE_BATCH_LIMIT } from '../../../src/main/memory/archive'
import { createHashEmbedder, hashEmbedding } from '../../../src/main/memory/embed/hash'
import { retrieveOwn } from '../../../src/main/memory/retrieve'
import { verifyDatabase } from '../../../src/main/db/verify'
import { openMemoryWorld, type MemoryTestWorld } from '../../support/memory-world'

/**
 * 非事实类记忆归档（PHASE-22 M2-7）。
 *
 * 验收要证明：
 *   1. 只碰 experience、低重要度、未被引用、有 keeper 的重复条目；
 *   2. 归档是软失效：`archived_at` 有值、`status` 不变、行与向量仍保留、审计可追；
 *   3. 令牌错误零写入；签发后候选变化 → skipped，不半写；重放不双写；
 *   4. 检索（SQL + 管线）排除归档；恢复后重新可见；审计有 archive/restore。
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

function seedEntry(
  world: MemoryTestWorld,
  input: { characterId: string; text: string; importance: number; learnedSeq?: number; pinned?: boolean }
): string {
  const repos = world.handle.repos
  const chapter = repos.chapter.get(world.chapterId)!
  const record = repos.memory.insert({
    projectId: world.projectId,
    characterId: input.characterId,
    kind: 'experience',
    text: input.text,
    learnedSeq: input.learnedSeq ?? 1,
    sourceChapterId: chapter.id,
    sourceRevisionId: chapter.finalRevisionId!,
    importance: input.importance,
    pinned: input.pinned ? 1 : 0,
    embeddingModel: 'hash-bigram-v1'
  })
  repos.memoryIndex.writeVector(record.id, Array.from(hashEmbedding(input.text)))
  repos.memoryIndex.writeBigrams(record.id, input.characterId, input.text)
  return record.id
}

describe('归档候选（memory/archive）', () => {
  it('只返回低重要度、未被引用、有 keeper 的重复经历；确定性排序', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const candidates = buildArchiveCandidates(world.handle.repos, world.projectId)
      expect(candidates).toHaveLength(1)
      const [candidate] = candidates
      expect(candidate!.reason).toBe('duplicate_experience')
      expect(candidate!.similarity).toBe(1)
      expect(candidate!.importance).toBeLessThanOrEqual(0.3)
      expect(candidate!.keeperId).not.toBe(candidate!.id)
      // 文本按 NFKC 归一化后相同（标点宽度差异也算重复）。
      expect(candidate!.keeperText.normalize('NFKC')).toBe(candidate!.text.normalize('NFKC'))

      // 两次输出逐字一致（纯函数 + 固定排序）。
      expect(buildArchiveCandidates(world.handle.repos, world.projectId)).toEqual(candidates)

      const entries = world.handle.repos.memory.listByProject(world.projectId, { includeArchived: true })
      const entry = entries.find((row) => row.id === candidate!.id)!
      expect(entry.kind).toBe('experience')
      expect(entry.pinned).toBe(0)

      // fact / relationship / cognition / 高重要度条目都不在候选里。
      for (const other of entries) {
        if (other.id === candidate!.id) continue
        expect(candidates.some((item) => item.id === other.id)).toBe(false)
      }
    } finally {
      world.cleanup()
    }
  })

  it('被有效事实/边引用、仍有待决策提案、pin、超过重要度门槛都不进入候选', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const repos = world.handle.repos
      const [candidate] = buildArchiveCandidates(repos, world.projectId)
      expect(candidate).toBeDefined()
      const entry = repos.memory.get(candidate!.id)!

      // 1) pin 不归档
      const pinnedEntry = repos.memory.insert({
        projectId: world.projectId,
        characterId: entry.characterId,
        kind: 'experience',
        text: entry.text,
        learnedSeq: 2,
        sourceChapterId: entry.sourceChapterId,
        sourceRevisionId: entry.sourceRevisionId,
        importance: 0.1,
        pinned: 1,
        embeddingModel: 'hash-bigram-v1'
      })
      const withPinned = buildArchiveCandidates(repos, world.projectId)
      expect(withPinned.some((item) => item.id === pinnedEntry.id)).toBe(false)
      expect(withPinned.some((item) => item.id === candidate!.id)).toBe(true)

      // 2) 待决策提案保护来源拍
      const proposal = repos.memoryProposal.insert({
        projectId: world.projectId,
        jobId: repos.memoryProposal.listBySource(world.chapterId)[0]!.jobId,
        kind: 'experience',
        characterId: entry.characterId,
        text: '待决策的来源拍',
        sourceChapterId: entry.sourceChapterId,
        sourceRevisionId: entry.sourceRevisionId,
        sourceBeatId: entry.sourceBeatId,
        importance: 0.1
      })
      expect(buildArchiveCandidates(repos, world.projectId).some((item) => item.id === candidate!.id)).toBe(false)
      repos.memoryProposal.decide(proposal.id, 'reject')
      expect(buildArchiveCandidates(repos, world.projectId).some((item) => item.id === candidate!.id)).toBe(true)

      // 3) 被有效事实按来源引用
      world.handle.db
        .prepare("UPDATE world_fact SET source_type = 'memory', source_id = ? WHERE id = (SELECT id FROM world_fact LIMIT 1)")
        .run(candidate!.id)
      expect(buildArchiveCandidates(repos, world.projectId).some((item) => item.id === candidate!.id)).toBe(false)

      // 4) 重要度门槛：独有文本、低重要度但没有 keeper → 不是候选。
      world.handle.db.prepare('UPDATE world_fact SET source_type = ? WHERE source_id = ?').run('author', candidate!.id)
      const uniqueId = seedEntry(world, {
        characterId: entry.characterId,
        text: '只有一条的独特经历',
        importance: 0.1,
        learnedSeq: 3
      })
      const ids = buildArchiveCandidates(repos, world.projectId).map((item) => item.id)
      expect(ids).not.toContain(uniqueId)
      expect(ids.length).toBeLessThanOrEqual(ARCHIVE_BATCH_LIMIT)
    } finally {
      world.cleanup()
    }
  })
})

describe('归档执行与恢复（memory.archive.*）', () => {
  it('author_confirm → 单事务归档 + 审计；status 不变、向量仍在；恢复重新可见', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const repos = world.handle.repos
      const [candidate] = buildArchiveCandidates(repos, world.projectId)
      expect(candidate).toBeDefined()
      const before = repos.memory.get(candidate!.id)!
      expect(before.archivedAt).toBeNull()
      const vectorCount = repos.memoryIndex.countVectors()

      const issued = world.service.issueArchiveToken([candidate!.id])
      expect(issued.preview.count).toBe(1)
      expect(issued.preview.batchId).toBe(archiveBatchId([candidate!.id]))

      const result = world.service.archiveApply({ ids: [candidate!.id], token: issued.token })
      expect(result.archived).toEqual([candidate!.id])
      expect(result.skipped).toEqual([])

      const after = repos.memory.get(candidate!.id)!
      expect(after.archivedAt).not.toBeNull()
      expect(after.archiveReason).toBe('redundant')
      expect(after.status).toBe('active') // 归档不改 status
      expect(repos.memoryIndex.countVectors()).toBe(vectorCount) // 向量行仍在
      expect(repos.memoryIndex.hasVector(candidate!.id)).toBe(true)

      const audits = repos.memoryAudit.listByEntity(candidate!.id).filter((row) => row.action === 'archive')
      expect(audits).toHaveLength(1)
      const detail = JSON.parse(audits[0]!.detailJson) as Record<string, unknown>
      expect(detail.batchId).toBe(issued.preview.batchId)
      expect(detail.keeperId).toBe(candidate!.keeperId)
      expect(detail.similarity).toBe(1)

      // 摘要审计行（重放依据）
      const summary = repos.memoryAudit.listByEntity(issued.preview.batchId)
      expect(summary.some((row) => row.action === 'archive' && row.entityType === 'proposal')).toBe(true)

      // 检索：SQL 与管线都排除；keeper 仍能命中。
      const filter = { characterId: before.characterId, asOf: 999 }
      expect(repos.memory.listByCharacter(before.characterId).some((row) => row.id === candidate!.id)).toBe(false)
      expect(repos.memoryIndex.searchBigrams(before.text, filter, 30).some((hit) => hit.memoryId === candidate!.id)).toBe(false)
      const retrieved = await retrieveOwn(
        repos,
        createHashEmbedder(),
        { text: before.text, topK: 8 },
        { projectId: world.projectId, actorId: `character:${before.characterId}`, characterId: before.characterId, asOf: 999 }
      )
      const ids = [...retrieved.items, ...retrieved.pinned].map((item) => item.entry.id)
      expect(ids).not.toContain(candidate!.id)
      expect(ids).toContain(candidate!.keeperId)

      // 状态计数：active 减 1，archived 为 1。
      const state = world.service.state(world.chapterId)
      expect(state.counts.archived).toBe(1)
      expect(state.entries.find((entry) => entry.id === candidate!.id)?.archivedAt).not.toBeNull()

      // 恢复：清两列、写 restore 审计、重新进入检索。
      const restored = world.service.restoreArchive(candidate!.id)
      expect(restored.detail).toContain('已恢复')
      const back = repos.memory.get(candidate!.id)!
      expect(back.archivedAt).toBeNull()
      expect(back.archiveReason).toBeNull()
      expect(repos.memory.listByCharacter(before.characterId).some((row) => row.id === candidate!.id)).toBe(true)
      expect(
        repos.memoryAudit.listByEntity(candidate!.id).filter((row) => row.action === 'restore')
      ).toHaveLength(1)
      expect(world.service.state(world.chapterId).counts.archived).toBe(0)

      const report = verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    } finally {
      world.cleanup()
    }
  })

  it('坏令牌零写入；重放返回首次结果、不双写、不重复消费', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const repos = world.handle.repos
      const [candidate] = buildArchiveCandidates(repos, world.projectId)
      const before = repos.memory.get(candidate!.id)!
      expect(before.archivedAt).toBeNull()

      expect(() => world.service.archiveApply({ ids: [candidate!.id], token: 'not-a-token' })).toThrow(AppError)
      expect(repos.memory.get(candidate!.id)!.archivedAt).toBeNull()
      expect(repos.memoryAudit.listByProject(world.projectId, 500).filter((row) => row.action === 'archive')).toHaveLength(0)

      const issued = world.service.issueArchiveToken([candidate!.id])
      const first = world.service.archiveApply({ ids: [candidate!.id], token: issued.token })
      expect(first.archived).toEqual([candidate!.id])
      const auditCount = repos.memoryAudit.listByProject(world.projectId, 500).filter((row) => row.action === 'archive').length

      // 同一批 id（顺序无关）→ batchId 相同；重放不双写。
      const replayBatch = archiveBatchId([candidate!.id])
      expect(replayBatch).toBe(issued.preview.batchId)
      const replay = world.service.archiveApply({ ids: [candidate!.id], token: issued.token })
      expect(replay.detail).toContain('重放')
      expect(repos.memoryAudit.listByProject(world.projectId, 500).filter((row) => row.action === 'archive')).toHaveLength(
        auditCount
      )
    } finally {
      world.cleanup()
    }
  })

  it('签发后候选失效：skipped 不半写，有效项照常归档且令牌只消费一次', async () => {
    const world = openMemoryWorld()
    try {
      await applyInitialMemory(world)
      const repos = world.handle.repos
      const first = world.characterIds[0]!
      // 再造一对重复，得到第二个候选（顺序确定：低重要度先归档）。
      seedEntry(world, { characterId: first, text: '窗外又是雨声', importance: 0.1, learnedSeq: 5 })
      seedEntry(world, { characterId: first, text: '窗外又是雨声', importance: 0.2, learnedSeq: 6 })
      const candidates = buildArchiveCandidates(repos, world.projectId)
      expect(candidates.length).toBeGreaterThanOrEqual(2)
      const chosen = candidates.slice(0, 2).map((item) => item.id)

      const issued = world.service.issueArchiveToken(chosen)
      // 签发后让其中一条失效：执行时必须是 skipped，而不是半写。
      repos.memory.markInvalid(chosen[0]!, 'inactive')

      const result = world.service.archiveApply({ ids: chosen, token: issued.token })
      expect(result.archived).toEqual([chosen[1]])
      expect(result.skipped).toEqual([{ id: chosen[0], reason: 'not_active' }])
      expect(repos.memory.get(chosen[0]!)!.archivedAt).toBeNull()
      expect(repos.memory.get(chosen[1]!)!.archivedAt).not.toBeNull()
    } finally {
      world.cleanup()
    }
  })
})
