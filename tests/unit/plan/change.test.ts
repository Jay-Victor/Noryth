import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { analyzeChange, applyChange, dismissInvalidation, listChanges, rejectChange } from '../../../src/main/plan/change'
import { applyProposal } from '../../../src/main/plan/proposals'
import { withTransaction } from '../../../src/main/db/tx'
import { openPlanWorld, seedPostG1, type PlanTestWorld } from '../../support/plan-world'

/**
 * 蓝图变更流程（PHASE-15 M1-8 / §5.2）。
 *
 * 三条硬规则：
 * 1. 未跑影响分析 → invalid_args，DB 不变（不能「假装没影响」）。
 * 2. 应用只改 outline / 角色卡 + 标脏，不改正文、不建 revision。
 * 3. 已定稿章同样只标脏；作者可以忽略。
 */

function codeOf(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return error instanceof AppError ? error.code : 'unknown'
  }
}

describe('蓝图变更流程', () => {
  const created: PlanTestWorld[] = []
  const world = (): { world: PlanTestWorld; post: ReturnType<typeof seedPostG1> } => {
    const item = openPlanWorld()
    created.push(item)
    return { world: item, post: seedPostG1(item) }
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }
  const host = (w: PlanTestWorld): { repos: PlanTestWorld['repos'] } => ({ repos: w.repos })

  it('未跑影响分析 → invalid_args，且 outline 与章标记都不动', () => {
    const { world: w, post } = world()
    try {
      const change = w.repos.blueprintChange.insert({
        projectId: w.projectId,
        opsJson: JSON.stringify({ ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷（改）' }] }),
        actor: 'author'
      })
      const before = w.repos.outline.get(post.volumeId)!
      expect(codeOf(() => withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id })))).toBe(
        'invalid_args'
      )
      expect(w.repos.outline.get(post.volumeId)!.title).toBe(before.title)
      expect(w.repos.outline.get(post.volumeId)!.version).toBe(before.version)
      expect(w.repos.chapter.get(post.chapter1Id)!.invalidatedAt).toBeNull()
      expect(w.repos.blueprintChange.get(change.id)!.status).toBe('proposed')
    } finally {
      cleanup()
    }
  })

  it('分析 → 应用：outline 生效、两章标脏、正文与 revision 不变', () => {
    const { world: w, post } = world()
    try {
      const revisionBefore = w.repos.chapter.get(post.chapter1Id)!.currentRevisionId
      const beatBefore = w.repos.beat.listLiveByChapter(post.chapter1Id)[0]!
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷（改）', meta: { character_ids: [post.characterId] } }],
        actor: 'author'
      })
      expect(change.status).toBe('proposed')
      expect(change.impact?.counts.chapters).toBe(2)
      expect(change.impact?.analyzed).toBe(true)

      const applied = withTransaction(w.handle.db, () =>
        applyChange(host(w), { projectId: w.projectId, changeId: change.id })
      )
      expect(applied.blueprintVersion).toBe(2)
      expect(applied.invalidatedChapters.sort()).toEqual([post.chapter1Id, post.chapter2Id].sort())

      const volume = w.repos.outline.get(post.volumeId)!
      expect(volume.title).toBe('第一卷（改）')
      expect(volume.version).toBe(2)
      expect(JSON.parse(volume.metaJson).character_ids).toEqual([post.characterId])

      // 正文与 revision 不动
      expect(w.repos.chapter.get(post.chapter1Id)!.currentRevisionId).toBe(revisionBefore)
      expect(w.repos.beat.listLiveByChapter(post.chapter1Id)[0]!.body).toBe(beatBefore.body)

      // 标脏只写两列
      const chapter = w.repos.chapter.get(post.chapter1Id)!
      expect(chapter.invalidatedAt).not.toBeNull()
      expect(chapter.invalidatedReason).toContain('蓝图变更')
      expect(chapter.status).toBe('planned')

      const stored = w.repos.blueprintChange.get(change.id)!
      expect(stored.status).toBe('applied')
      expect(stored.appliedAt).not.toBeNull()

      // 变更应用同时写一条系统提示（作者可见），不进正文
      const messages = w.repos.writeMessage.listByChapter(post.chapter1Id)
      expect(messages.some((message) => message.role === 'system' && message.body.includes('待重审'))).toBe(true)

      // 重复应用被拒
      expect(
        codeOf(() => withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id })))
      ).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('已定稿章只标脏，final 快照与定稿状态保留', () => {
    const { world: w, post } = world()
    try {
      const finalRevision = w.repos.revision.insert({
        chapterId: post.chapter2Id,
        parentRevisionId: null,
        kind: 'final',
        contentHash: 'hash_final',
        createdBy: 'author'
      })
      w.repos.chapter.markFinalized(post.chapter2Id, finalRevision.id)
      w.repos.chapter.setFinalRevision(post.chapter2Id, finalRevision.id)

      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: post.volumeId, content: '整卷重写' }],
        actor: 'author'
      })
      withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id }))

      const chapter = w.repos.chapter.get(post.chapter2Id)!
      expect(chapter.status).toBe('finalized')
      expect(chapter.finalRevisionId).toBe(finalRevision.id)
      expect(chapter.invalidatedAt).not.toBeNull()
    } finally {
      cleanup()
    }
  })

  it('作者忽略标脏：只清两列，不动正文与状态', () => {
    const { world: w, post } = world()
    try {
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: post.chapter1NodeId, title: '第一章（改）' }],
        actor: 'author'
      })
      withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id }))
      expect(w.repos.chapter.get(post.chapter1Id)!.invalidatedAt).not.toBeNull()

      const dismissed = dismissInvalidation(w.repos, w.projectId, post.chapter1Id)
      expect(dismissed.dismissed).toBe(true)
      const chapter = w.repos.chapter.get(post.chapter1Id)!
      expect(chapter.invalidatedAt).toBeNull()
      expect(chapter.invalidatedReason).toBeNull()
      expect(chapter.currentRevisionId).not.toBeNull()

      expect(dismissInvalidation(w.repos, w.projectId, post.chapter1Id).dismissed).toBe(false)
      expect(codeOf(() => dismissInvalidation(w.repos, w.projectId, 'ch_missing'))).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('拒绝变更：状态 rejected，不动蓝图；已拒绝不能再应用', () => {
    const { world: w, post } = world()
    try {
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷（改）' }],
        actor: 'author'
      })
      const rejected = rejectChange(host(w), w.projectId, change.id)
      expect(rejected.status).toBe('rejected')
      expect(w.repos.outline.get(post.volumeId)!.title).not.toBe('第一卷（改）')
      expect(
        codeOf(() => withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id })))
      ).toBe('invalid_args')
      expect(listChanges(w.repos, w.projectId)[0]!.status).toBe('rejected')
    } finally {
      cleanup()
    }
  })

  it('角色卡变更：卡片生效 + card_version 递增 + 受影响章标脏', () => {
    const { world: w, post } = world()
    try {
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        characterCard: { character_id: post.characterId, card: { identity: '改过的身份', want: '查清真相' } },
        actor: 'author'
      })
      expect(change.summary.characterCards).toBe(1)
      expect(change.impact?.counts.chapters).toBe(1)
      withTransaction(w.handle.db, () =>
        applyChange(host(w), { projectId: w.projectId, changeId: change.id, markChapters: false })
      )
      const planCharacter = w.repos.planCharacter.get(post.characterId)!
      expect(planCharacter.cardVersion).toBe(2)
      expect(JSON.parse(planCharacter.cardJson).identity).toBe('改过的身份')
      // markChapters=false：只改卡不标脏
      expect(w.repos.chapter.get(post.chapter1Id)!.invalidatedAt).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('结构校验：删除有关联章的节点先被拒（不产生变更记录）', () => {
    const { world: w, post } = world()
    try {
      expect(
        codeOf(() =>
          analyzeChange(host(w), {
            projectId: w.projectId,
            ops: [{ op: 'remove', node_id: post.chapter1NodeId }],
            actor: 'author'
          })
        )
      ).toBe('invalid_args')
      expect(w.repos.blueprintChange.listByProject(w.projectId)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('G1 前不能应用变更；G1 后提案应用直接拒绝（必须走变更流程）', () => {
    const w = openPlanWorld()
    created.push(w)
    try {
      const node = w.repos.outline.insert({
        projectId: w.projectId,
        parentId: null,
        kind: 'main',
        ord: 0,
        title: '主线'
      })
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: node.id, title: '主线（改）' }],
        actor: 'author'
      })
      expect(
        codeOf(() => withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id })))
      ).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('G1 后 applyProposal 拒绝蓝图提案（变更只能走 change）', () => {
    const { world: w, post } = world()
    try {
      const proposal = w.repos.proposal.insert({
        projectId: w.projectId,
        kind: 'blueprint_patch',
        jobId: 'job_after_g1',
        turnId: 'turn_after_g1',
        payloadJson: JSON.stringify({ ops: [{ op: 'update', node_id: post.volumeId, title: '改' }] })
      })
      expect(codeOf(() => applyProposal(w.handle.db, w.repos, proposal.id))).toBe('invalid_args')

      // 同一条提案可以走影响分析 → 应用
      const change = analyzeChange(host(w), {
        projectId: w.projectId,
        ops: [{ op: 'update', node_id: post.volumeId, title: '改' }],
        proposalId: proposal.id,
        actor: 'author'
      })
      withTransaction(w.handle.db, () => applyChange(host(w), { projectId: w.projectId, changeId: change.id }))
      expect(w.repos.proposal.get(proposal.id)!.status).toBe('applied')
      expect(w.repos.outline.get(post.volumeId)!.title).toBe('改')
    } finally {
      cleanup()
    }
  })
})
