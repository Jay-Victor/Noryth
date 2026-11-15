import { describe, expect, it } from 'vitest'
import { buildExtractionInput, submitProposalItems } from '../../src/main/memory/extract'
import { openWriteWorld } from '../support/write-world'
import { openMemoryWorld } from '../support/memory-world'

/**
 * PHASE-09 集成：E2E-MEMORY-01 的链路版。
 *
 * 定稿 → 14 条提案 → 删 2 改 1 → G7 应用 12 条 → 第 2 章召回 ≥1 条；
 * 外加「初稿不进记忆」「篡改 quote 被丢弃并记审计」两条硬规则。
 */

describe('memory integration', () => {
  it('E2E-MEMORY-01：定稿 → 14 提案 → 删2改1 → 应用12 → 第2章召回', async () => {
    const world = openMemoryWorld()
    try {
      const extracted = await world.service.extract(world.chapterId)
      const state = extracted.state
      expect(state.proposals).toHaveLength(14)

      const second = world.state()
      expect(second.proposals).toHaveLength(14)

      // 「账本在祠堂」来自台词：提案 truth 必须是 claim（不能被写成客观事实）
      const ledgerClaim = second.proposals.find(
        (item) => item.kind === 'world_fact' && item.text.includes('账本在祠堂')
      )
      expect(ledgerClaim?.truth).toBe('claim')
      expect(ledgerClaim?.downgrades ?? []).toContain('dialogue_objective_to_claim')

      const rejectA = second.proposals[6]!
      const rejectB = second.proposals[11]!
      const edited = second.proposals[0]!
      world.service.decideMany({
        decisions: [
          { itemId: rejectA.id, decision: 'reject' },
          { itemId: rejectB.id, decision: 'reject' },
          { itemId: edited.id, decision: 'edit', editedText: '她试探黑漆匣子，但没有点破账本' }
        ]
      })
      const pending = world
        .state()
        .proposals.filter((item) => item.decision === 'pending')
        .map((item) => ({ itemId: item.id, decision: 'accept' as const }))
      world.service.decideMany({ decisions: pending })

      const issued = world.service.issueG7Token(world.chapterId)
      const applied = await world.service.apply({ chapterId: world.chapterId, token: issued.token })

      // 12 条应用：6 条记忆 + 3 条信念 + 3 条世界事实
      expect(applied.state.entries).toHaveLength(6)
      expect(applied.state.beliefs).toHaveLength(3)
      expect(applied.state.worldFacts).toHaveLength(4)
      expect(applied.state.jobStatus).toBe('applied')
      expect(applied.state.entries.some((entry) => entry.text === '她试探黑漆匣子，但没有点破账本')).toBe(true)

      // 每条记忆都带来源章 / revision / learned_seq
      for (const entry of applied.state.entries) {
        expect(entry.sourceChapterId).toBe(world.chapterId)
        expect(entry.sourceRevisionId).toMatch(/^rev_/)
        expect(entry.learnedSeq).toBeGreaterThan(0)
      }

      // 第 2 章：用真实检索管线召回第 1 章记忆
      const first = world.characterIds[0]!
      const recall = await world.service.recall({ characterId: first, query: '账本 祠堂 匣子' })
      expect(recall.items.length).toBeGreaterThanOrEqual(1)
      expect(recall.items.every((item) => item.text.length > 0)).toBe(true)
      expect(recall.asOf).toBeGreaterThan(0)

      // 隔离回归：写向量后再测一次，跨角色 0 命中
      const isolation = await world.service.isolationReport()
      expect(isolation.verified).toBe(true)
      expect(isolation.probes.every((probe) => probe.foreign === 0)).toBe(true)

      // 审计可追溯：应用 + 抽取都有记录
      expect(applied.state.audit.some((row) => row.action === 'apply')).toBe(true)
      expect(applied.state.audit.some((row) => row.action === 'extract')).toBe(true)
    } finally {
      world.cleanup()
    }
  })

  it('初稿/未定稿章不进记忆：抽取直接拒绝', async () => {
    const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
    try {
      expect(() => buildExtractionInput(world.repos, world.chapterId)).toThrowError(/只有定稿/)
      const chapter = world.repos.chapter.get(world.chapterId)!
      const job = world.repos.job.insert({
        projectId: world.projectId,
        type: 'memory.extract',
        status: 'queued',
        expectedRevision: chapter.currentRevisionId,
        epoch: world.repos.project.get()!.writeEpoch,
        idempotencyKey: 'draft-extract-attempt',
        payloadJson: JSON.stringify({ chapterId: chapter.id })
      })
      const beat = world.repos.beat.listLiveByChapter(world.chapterId)[0]!
      expect(() =>
        submitProposalItems(world.repos, {
          projectId: world.projectId,
          jobId: job.id,
          chapterId: chapter.id,
          revisionId: chapter.currentRevisionId!,
          actor: 'memory',
          items: [
            {
              kind: 'experience',
              characterId: world.characterIds[0]!,
              text: '草稿里的内容',
              payload: {},
              sourceBeatId: beat.id,
              evidenceQuote: beat.body,
              importance: 0.5,
              pinned: false
            }
          ]
        })
      ).toThrowError(/only finalized/)
    } finally {
      world.cleanup()
    }
  })

  it('篡改 evidence quote → 丢弃该条并记 evidence_mismatch', () => {
    const world = openMemoryWorld()
    try {
      const repos = world.handle.repos
      const chapter = repos.chapter.get(world.chapterId)!
      const members = repos.revision.manifest(chapter.finalRevisionId!)
      const job = repos.job.insert({
        projectId: world.projectId,
        type: 'memory.extract',
        status: 'running',
        expectedRevision: chapter.finalRevisionId,
        epoch: repos.project.get()!.writeEpoch,
        idempotencyKey: 'tamper-evidence',
        payloadJson: JSON.stringify({ chapterId: chapter.id })
      })
      const result = submitProposalItems(repos, {
        projectId: world.projectId,
        jobId: job.id,
        chapterId: chapter.id,
        revisionId: chapter.finalRevisionId!,
        actor: 'memory',
        items: [
          {
            kind: 'experience',
            characterId: world.characterIds[0]!,
            text: '她确认账本在祠堂',
            payload: {},
            sourceBeatId: members[0]!.beatId,
            evidenceQuote: '这句话在正文里根本不存在',
            importance: 0.7,
            pinned: false
          },
          {
            kind: 'experience',
            characterId: world.characterIds[0]!,
            text: '她记得那晚的雨',
            payload: {},
            sourceBeatId: members[0]!.beatId,
            evidenceQuote: members[0]!.body,
            importance: 0.4,
            pinned: false
          }
        ]
      })
      expect(result.mismatches).toBe(1)
      expect(result.inserted).toHaveLength(1)
      expect(result.dropped[0]?.reason).toBe('quote_not_substring')
      expect(
        repos.memoryAudit.listByProject(world.projectId).some((row) => row.action === 'evidence_mismatch')
      ).toBe(true)
      expect(repos.memory.listByProject(world.projectId)).toHaveLength(0)
    } finally {
      world.cleanup()
    }
  })
})
