import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../../../src/shared/domain/app-error'
import { isAppError } from '../../../src/shared/domain/app-error'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { reopenChapter } from '../../../src/main/doc/reopen'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { issueAuthorGate } from '../../../src/main/review/gates'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { verifyDatabase } from '../../../src/main/db/verify'
import { hashManifestRows } from '../../../src/main/db/hash'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 重新打开定稿（PHASE-16 §5.1 / DEV-PLAN §9.6 / M1-21）：
 * - `finalized → revising`：新 draft（parent = 旧 final，复制清单），旧 final 永久可读；
 * - `write_epoch + 1`：旧窗口的在跑任务被 epoch 校验挡掉；
 * - 再次定稿生成新 final；首次定稿入队 memory.extract，重开再定稿入队 memory.rebuild；
 * - 摘要与 final 同事务（旧 final 摘要保留，新 final 一份新摘要）。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): WriteTestWorld {
  const created = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
  worlds.push(created)
  return created
}

const LINES = ['她把茶盏往他那边推了推。', '他没有立刻回答。']

function seedFinal(w: WriteTestWorld): {
  finalRevisionId: string
  memoryJobId: string
  beatIds: string[]
} {
  const project = w.repos.project.get()!
  const beatIds: string[] = []
  for (const [index, beat] of w.repos.beat.listLiveByChapter(w.chapterId).entries()) {
    const chapter = w.repos.chapter.get(w.chapterId)!
    const result = commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: LINES[index % LINES.length]!,
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'confirmed',
      createdBy: 'doc_controller'
    })
    beatIds.push(result.beatId)
  }
  markChapterComplete(w.handle.db, w.repos, w.repos.chapter.get(w.chapterId)!)
  const issued = issueAuthorGate({
    repos: w.repos,
    secret: 'unit-gate',
    projectId: w.projectId,
    gateId: 'G6',
    entityType: 'chapter',
    entityId: w.chapterId,
    revision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
    jobId: 'author_g6_reopen_test',
    actor: 'author'
  })
  const finalized = finalizeChapter(w.handle.db, w.repos, {
    chapterId: w.chapterId,
    gateRecordId: issued.gateRecordId,
    actor: 'author',
    ackBlocking: true,
    ackUnreviewed: true,
    blocking: [],
    unreviewed: []
  })
  return { finalRevisionId: finalized.finalRevisionId, memoryJobId: finalized.memoryJobId!, beatIds }
}

function finalizeAgain(w: WriteTestWorld): ReturnType<typeof finalizeChapter> {
  const issued = issueAuthorGate({
    repos: w.repos,
    secret: 'unit-gate',
    projectId: w.projectId,
    gateId: 'G6',
    entityType: 'chapter',
    entityId: w.chapterId,
    revision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
    jobId: 'author_g6_reopen_test_2',
    actor: 'author'
  })
  return finalizeChapter(w.handle.db, w.repos, {
    chapterId: w.chapterId,
    gateRecordId: issued.gateRecordId,
    actor: 'author',
    ackBlocking: true,
    ackUnreviewed: true,
    blocking: [],
    unreviewed: []
  })
}

describe('reopenChapter', () => {
  it('重开：新 draft（parent=final）、旧 final 保留、epoch+1、正文可写、verify 绿', () => {
    const w = world()
    const first = seedFinal(w)
    const beforeEpoch = w.repos.project.get()!.writeEpoch
    const finalManifest = w.repos.revision.manifest(first.finalRevisionId)
    const finalHash = w.repos.revision.get(first.finalRevisionId)!.contentHash
    const chapter = w.repos.chapter.get(w.chapterId)!

    const reopened = reopenChapter(w.handle.db, w.repos, { chapterId: w.chapterId, actor: 'author' })

    const after = w.repos.chapter.get(w.chapterId)!
    expect(after.status).toBe('revising')
    expect(after.currentRevisionId).toBe(reopened.draftRevisionId)
    expect(after.finalRevisionId).toBe(first.finalRevisionId)
    const draft = w.repos.revision.get(reopened.draftRevisionId)!
    expect(draft.kind).toBe('draft')
    expect(draft.parentRevisionId).toBe(first.finalRevisionId)
    expect(draft.contentHash).toBe(finalHash)
    expect(w.repos.revision.countMembers(draft.id)).toBe(finalManifest.length)
    expect(w.repos.project.get()!.writeEpoch).toBe(beforeEpoch + 1)
    expect(reopened.epoch).toBe(beforeEpoch + 1)

    // 旧 final 永久可读：清单与 hash 都不变。
    expect(w.repos.revision.get(first.finalRevisionId)!.kind).toBe('final')
    expect(hashManifestRows(w.repos.revision.manifest(first.finalRevisionId))).toBe(finalHash)

    // 重开后可编辑：旧 epoch 被拒，新 epoch 通过。
    const beat = w.repos.beat.listLiveByChapter(w.chapterId)[0]!
    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: after.currentRevisionId,
        epoch: beforeEpoch,
        sceneId: beat.sceneId,
        ord: beat.ord,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        body: '旧 epoch 的写入',
        intent: beat.intent,
        supersedesId: beat.id,
        status: 'author_edited',
        createdBy: 'author'
      })
    ).toThrowError(/epoch/)
    const edited = commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: after.currentRevisionId,
      epoch: reopened.epoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: '重开后的第一处修改。',
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'author_edited',
      createdBy: 'author'
    })
    expect(edited.revisionId).toBe(w.repos.chapter.get(w.chapterId)!.currentRevisionId)
    expect(w.repos.revision.get(edited.revisionId)!.parentRevisionId).toBe(reopened.draftRevisionId)

    const report = verifyDatabase(w.handle.db, { checkMirror: false })
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(report.ok).toBe(true)
    // 原章对象是事务前快照，重开后必须重新读。
    expect(chapter.status).toBe('finalized')
  })

  it('非定稿章重开 → invalid_args，零写入', () => {
    const w = world()
    const revisions = w.repos.revision.listByChapter(w.chapterId).length
    const status = w.repos.chapter.get(w.chapterId)!.status
    let error: AppError | null = null
    try {
      reopenChapter(w.handle.db, w.repos, { chapterId: w.chapterId, actor: 'author' })
    } catch (caught) {
      error = isAppError(caught) ? caught : null
    }
    expect(error?.code).toBe('invalid_args')
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisions)
    expect(w.repos.chapter.get(w.chapterId)!.status).toBe(status)
  })

  it('重开再定稿：新 final 指向新 revision，旧 final 可读，入队 rebuild 而不是 extract', () => {
    const w = world()
    const first = seedFinal(w)
    const firstJob = w.repos.job.get(first.memoryJobId)!
    expect(firstJob.type).toBe('memory.extract')

    const reopened = reopenChapter(w.handle.db, w.repos, { chapterId: w.chapterId, actor: 'author' })
    const beat = w.repos.beat.listLiveByChapter(w.chapterId)[0]!
    commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: reopened.draftRevisionId,
      epoch: reopened.epoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: '她把茶盏收了回去。',
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'author_edited',
      createdBy: 'author'
    })

    const second = finalizeAgain(w)
    expect(second.alreadyFinalized).toBe(false)
    expect(second.finalRevisionId).not.toBe(first.finalRevisionId)
    expect(second.previousFinalRevisionId).toBe(first.finalRevisionId)
    expect(second.memoryJobType).toBe('memory.rebuild')
    const chapter = w.repos.chapter.get(w.chapterId)!
    expect(chapter.status).toBe('finalized')
    expect(chapter.finalRevisionId).toBe(second.finalRevisionId)

    const finals = w.repos.revision.listByChapter(w.chapterId).filter((revision) => revision.kind === 'final')
    expect(finals).toHaveLength(2)
    expect(w.repos.revision.get(first.finalRevisionId)!.kind).toBe('final')

    const jobs = w.repos.job.listRecent(w.projectId, 50).filter((job) => job.type === 'memory.extract')
    expect(jobs).toHaveLength(1)
    const rebuild = w.repos.job.get(second.memoryJobId!)!
    expect(rebuild.type).toBe('memory.rebuild')
    expect(rebuild.status).toBe('queued')
    expect(rebuild.expectedRevision).toBe(second.finalRevisionId)
    const payload = JSON.parse(rebuild.payloadJson) as {
      previousFinalRevisionId: string
      gateRecordId: string
      auto: boolean
    }
    expect(payload.previousFinalRevisionId).toBe(first.finalRevisionId)
    expect(payload.auto).toBe(true)

    // 摘要：两次定稿各一份，旧 final 的摘要不丢。
    const summaries = w.repos.chapterSummary.listByChapter(w.chapterId)
    expect(summaries.map((row) => row.revisionId).sort()).toEqual(
      [first.finalRevisionId, second.finalRevisionId].sort()
    )
    expect(summaries.every((row) => row.tokens <= 300)).toBe(true)

    const report = verifyDatabase(w.handle.db, { checkMirror: false })
    expect(report.ok).toBe(true)
  })

  it('已经重开（非 finalized）再重开被拒，不会建第二份 draft', () => {
    const w = world()
    seedFinal(w)
    reopenChapter(w.handle.db, w.repos, { chapterId: w.chapterId, actor: 'author' })
    const count = w.repos.revision.listByChapter(w.chapterId).length
    expect(() => reopenChapter(w.handle.db, w.repos, { chapterId: w.chapterId, actor: 'author' })).toThrowError(
      /已定稿/
    )
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(count)
  })
})
