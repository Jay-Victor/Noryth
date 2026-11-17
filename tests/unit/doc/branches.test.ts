import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../../../src/shared/domain/app-error'
import { isAppError } from '../../../src/shared/domain/app-error'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { createBranch, listBranches, switchBranch } from '../../../src/main/doc/branches'
import { compareRevisions } from '../../../src/main/review/diff'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { issueAuthorGate } from '../../../src/main/review/gates'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { verifyDatabase } from '../../../src/main/db/verify'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 分支（PHASE-16 §5.2 / M1-21）：
 * - 开新分支 = 复制当前清单 → 新 draft + 新 branch；
 * - 提交写在分支上：新 revision 继承 branch_id，分支 head 跟随移动；
 * - 切回主线不删分支，切回分支回到它的 head；
 * - 对比任意两版按槽位对齐；verify 校验 head 与 current 关系。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): WriteTestWorld {
  return register(openWriteWorld({ sceneCount: 1, beatsPerScene: 2 }))
}

function register(created: WriteTestWorld): WriteTestWorld {
  worlds.push(created)
  return created
}

function seedBeats(w: WriteTestWorld): string[] {
  const project = w.repos.project.get()!
  const live = w.repos.beat.listLiveByChapter(w.chapterId)
  const ids: string[] = []
  for (const [index, beat] of live.entries()) {
    const chapter = w.repos.chapter.get(w.chapterId)!
    const result = commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: index === 0 ? '她把茶盏往他那边推了推。' : '他没有立刻回答。',
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'confirmed',
      createdBy: 'doc_controller'
    })
    ids.push(result.beatId)
  }
  markChapterComplete(w.handle.db, w.repos, w.repos.chapter.get(w.chapterId)!)
  return ids
}

describe('branches', () => {
  it('开分支复制清单；分支上提交移动 head；切回主线不丢分支', () => {
    const w = world()
    seedBeats(w)
    const before = w.repos.chapter.get(w.chapterId)!
    const mainlineHead = before.currentRevisionId!
    const mainlineManifest = w.repos.revision.manifest(mainlineHead)

    const created = createBranch(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      name: '改写线',
      actor: 'author'
    })
    expect(created.branch.headRevisionId).toBe(created.revisionId)
    expect(created.branch.isCurrent).toBe(true)
    const branchDraft = w.repos.revision.get(created.revisionId)!
    expect(branchDraft.parentRevisionId).toBe(mainlineHead)
    expect(branchDraft.branchId).toBe(created.branch.id)
    expect(branchDraft.contentHash).toBe(w.repos.revision.get(mainlineHead)!.contentHash)
    expect(w.repos.revision.countMembers(created.revisionId)).toBe(mainlineManifest.length)
    expect(w.repos.chapter.get(w.chapterId)!.currentRevisionId).toBe(created.revisionId)

    const beat = w.repos.beat.listLiveByChapter(w.chapterId)[0]!
    const committed = commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: created.revisionId,
      epoch: w.repos.project.get()!.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: '分支上的改法：她把茶盏收了回去。',
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'author_edited',
      createdBy: 'author'
    })
    expect(w.repos.revision.get(committed.revisionId)!.branchId).toBe(created.branch.id)
    expect(w.repos.branch.get(created.branch.id)!.headRevisionId).toBe(committed.revisionId)

    const overview = listBranches(w.repos, w.repos.chapter.get(w.chapterId)!)
    expect(overview.currentBranchId).toBe(created.branch.id)
    expect(overview.mainlineCurrent).toBe(false)
    expect(overview.mainlineHeadId).toBe(mainlineHead)
    expect(overview.branches.find((branch) => branch.id === created.branch.id)?.isCurrent).toBe(true)

    const switched = switchBranch(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      branchId: null,
      actor: 'author'
    })
    expect(switched.revisionId).toBe(mainlineHead)
    expect(w.repos.chapter.get(w.chapterId)!.currentRevisionId).toBe(mainlineHead)
    // 分支还在，且 head 仍是分支上最后一次提交。
    expect(w.repos.branch.get(created.branch.id)!.headRevisionId).toBe(committed.revisionId)
    const back = switchBranch(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      branchId: created.branch.id,
      actor: 'author'
    })
    expect(back.revisionId).toBe(committed.revisionId)
    expect(w.repos.chapter.get(w.chapterId)!.currentRevisionId).toBe(committed.revisionId)

    const diff = compareRevisions(w.repos, {
      chapterId: w.chapterId,
      leftRevisionId: mainlineHead,
      rightRevisionId: committed.revisionId
    })
    expect(diff.changedBeats).toBe(1)
    expect(diff.hunks.some((hunk) => hunk.status === 'changed' && hunk.sceneOrd === 1 && hunk.beatOrd === 1)).toBe(true)

    const report = verifyDatabase(w.handle.db, { checkMirror: false })
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('同名分支 / 已定稿章 / 未知分支都被拒绝', () => {
    const w = world()
    seedBeats(w)
    createBranch(w.handle.db, w.repos, { chapterId: w.chapterId, name: '细修', actor: 'author' })
    let error: AppError | null = null
    try {
      createBranch(w.handle.db, w.repos, { chapterId: w.chapterId, name: ' 细修 ', actor: 'author' })
    } catch (caught) {
      error = isAppError(caught) ? caught : null
    }
    expect(error?.code).toBe('invalid_args')

    expect(() =>
      switchBranch(w.handle.db, w.repos, { chapterId: w.chapterId, branchId: 'brn_missing', actor: 'author' })
    ).toThrowError(/不属于本章/)

    // 定稿后不能再开分支，要先把章重新打开。
    const issued = issueAuthorGate({
      repos: w.repos,
      secret: 'unit-gate',
      projectId: w.projectId,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: w.chapterId,
      revision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
      jobId: 'author_g6_branch_test',
      actor: 'author'
    })
    finalizeChapter(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      gateRecordId: issued.gateRecordId,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })
    expect(() =>
      createBranch(w.handle.db, w.repos, { chapterId: w.chapterId, name: '定稿后', actor: 'author' })
    ).toThrowError(/已定稿/)
  })

  it('verify 发现坏分支 head / current 不在分支 head 时报告 error', () => {
    const w = world()
    seedBeats(w)
    const created = createBranch(w.handle.db, w.repos, { chapterId: w.chapterId, name: '坏分支', actor: 'author' })
    // 人为把分支 head 指到主线的一个 draft（合法 revision，但不是分支 head 的 current）。
    const mainline = w.repos.revision.latestMainlineDraft(w.chapterId)!
    w.repos.branch.setHead(created.branch.id, mainline.id)
    const report = verifyDatabase(w.handle.db, { checkMirror: false })
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain('current_revision_not_in_branch')

    // head 指到 final → branch_head_invalid。
    const final = w.repos.revision.insert({
      chapterId: w.chapterId,
      kind: 'final',
      contentHash: w.repos.revision.get(mainline.id)!.contentHash,
      createdBy: 'author'
    })
    w.repos.revision.insertMembers(
      final.id,
      w.repos.revision.listMembers(mainline.id).map((member) => ({
        revisionId: final.id,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )
    w.repos.branch.setHead(created.branch.id, final.id)
    const second = verifyDatabase(w.handle.db, { checkMirror: false })
    expect(second.issues.map((issue) => issue.code)).toContain('branch_head_invalid')
  })
})
