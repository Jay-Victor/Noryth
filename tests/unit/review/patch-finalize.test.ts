import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../../../src/shared/domain/app-error'
import { isAppError } from '../../../src/shared/domain/app-error'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { applyPatchBatch } from '../../../src/main/doc/patch-apply'
import { decidePatches } from '../../../src/main/review/patch'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { issueAuthorGate, checkAuthorGate, consumeAuthorGate } from '../../../src/main/review/gates'
import { hashManifestRows } from '../../../src/main/db/hash'
import { sameText } from '../../../src/shared/text/normalize'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * patch 应用与定稿（PHASE-08 §5.2 / §5.3 / DEV-PLAN §9.3–9.5）：
 * - 一次修订只产生一个 revision；旧拍 superseded、新拍 confirmed；
 * - before 归一化后一致才套用；不一致 → patch_conflict 且零写入；
 * - 定稿必须有 G6 记录；阻断/未复检需要 ack；幂等；入队 memory.extract。
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

/** 用 commitBeat 写两拍正文并确认，返回 patch 需要的信息。 */
function seedBeats(w: WriteTestWorld): Array<{ beatId: string; body: string }> {
  const project = w.repos.project.get()!
  const beats = w.repos.beat.listLiveByChapter(w.chapterId)
  const seeded = beats.map((beat, index) => {
    const chapter = w.repos.chapter.get(w.chapterId)!
    const body = index === 0 ? '她把茶盏往他那边推了推。' : '他没有立刻回答。'
    const result = commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body,
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'confirmed',
      createdBy: 'doc_controller'
    })
    return { beatId: result.beatId, body }
  })
  markChapterComplete(w.handle.db, w.repos, w.repos.chapter.get(w.chapterId)!)
  return seeded
}

describe('applyPatchBatch', () => {
  it('一批 N 条 patch 只产生一个 revision，清单 hash 可复算', () => {
    const w = world()
    const [first, second] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const revisionCount = w.repos.revision.listByChapter(w.chapterId).length

    const result = applyPatchBatch(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: w.repos.project.get()!.writeEpoch,
      edits: [
        { patchId: 'pat_1', beatId: first!.beatId, before: first!.body, after: '她把茶盏收了回去。', issueRef: 'iss_01' },
        { patchId: 'pat_2', beatId: second!.beatId, before: second!.body, after: '他答得很慢。', issueRef: 'iss_02' }
      ]
    })

    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisionCount + 1)
    const revision = w.repos.revision.get(result.revisionId)!
    expect(w.repos.revision.countMembers(revision.id)).toBe(2)
    const manifest = w.repos.revision.manifest(revision.id)
    expect(hashManifestRows(manifest)).toBe(revision.contentHash)

    const live = w.repos.beat.listLiveByChapter(w.chapterId)
    expect(live).toHaveLength(2)
    expect(live.map((beat) => beat.body).sort()).toEqual(['他答得很慢。', '她把茶盏收了回去。'])
    expect(live.every((beat) => beat.status === 'confirmed')).toBe(true)
    const superseded = w.repos.beat.listByChapter(w.chapterId).filter((beat) => beat.status === 'superseded')
    expect(superseded).toHaveLength(4) // 2 个分镜占位 + 2 个被替换的正文版本
  })

  it('before 归一化后一致即可（全角/行尾空白不影响）', () => {
    const w = world()
    const [first] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const before = `  ${first!.body}\u3000`
    expect(sameText(before, first!.body)).toBe(true)
    expect(() =>
      applyPatchBatch(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: w.repos.project.get()!.writeEpoch,
        edits: [{ patchId: 'pat_1', beatId: first!.beatId, before, after: '改后的正文', issueRef: 'iss_01' }]
      })
    ).not.toThrow()
  })

  it('before 不一致 → patch_conflict，且零写入', () => {
    const w = world()
    const [first] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const before = {
      revisions: w.repos.revision.listByChapter(w.chapterId).length,
      body: w.repos.beat.get(first!.beatId)!.body
    }
    let error: AppError | null = null
    try {
      applyPatchBatch(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: w.repos.project.get()!.writeEpoch,
        edits: [{ patchId: 'pat_1', beatId: first!.beatId, before: '完全不同的原文', after: '改后的正文', issueRef: 'iss_01' }]
      })
    } catch (caught) {
      error = isAppError(caught) ? caught : null
    }
    expect(error?.code).toBe('patch_conflict')
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(before.revisions)
    expect(w.repos.beat.get(first!.beatId)!.body).toBe(before.body)
    expect(w.repos.beat.get(first!.beatId)!.status).toBe('confirmed')
  })

  it('同一拍两条 patch / 已定稿章 / base 变更 都被拒绝', () => {
    const w = world()
    const [first] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const epoch = w.repos.project.get()!.writeEpoch
    const base = {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch
    }

    expect(() =>
      applyPatchBatch(w.handle.db, w.repos, {
        ...base,
        edits: [
          { patchId: 'pat_1', beatId: first!.beatId, before: first!.body, after: 'a', issueRef: 'iss_01' },
          { patchId: 'pat_2', beatId: first!.beatId, before: first!.body, after: 'b', issueRef: 'iss_02' }
        ]
      })
    ).toThrowError(/同一拍/)

    expect(() =>
      applyPatchBatch(w.handle.db, w.repos, {
        ...base,
        expectedRevision: 'rev_other',
        edits: [{ patchId: 'pat_1', beatId: first!.beatId, before: first!.body, after: 'a', issueRef: 'iss_01' }]
      })
    ).toThrowError(/revision changed|稿件已变更|patch base/)

    w.repos.chapter.markFinalized(w.chapterId, chapter.currentRevisionId!)
    expect(() =>
      applyPatchBatch(w.handle.db, w.repos, {
        ...base,
        edits: [{ patchId: 'pat_1', beatId: first!.beatId, before: first!.body, after: 'a', issueRef: 'iss_01' }]
      })
    ).toThrowError(/已定稿/)
  })
})

describe('decidePatches', () => {
  it('接受 1 拒绝 1：新 revision + patch 状态正确；未决定的旧提案标 superseded', () => {
    const w = world()
    const [first, second] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const proposalId = 'prop_1'
    const p1 = w.repos.patch.insert({
      projectId: w.projectId,
      proposalId,
      revisionId: chapter.currentRevisionId!,
      beatId: first!.beatId,
      before: first!.body,
      after: '她把茶盏收了回去。',
      reason: '语气更克制',
      issueRef: 'iss_01'
    })
    const p2 = w.repos.patch.insert({
      projectId: w.projectId,
      proposalId,
      revisionId: chapter.currentRevisionId!,
      beatId: second!.beatId,
      before: second!.body,
      after: '他答得很慢。',
      reason: '节奏',
      issueRef: 'iss_02'
    })
    const p3 = w.repos.patch.insert({
      projectId: w.projectId,
      proposalId: 'prop_2',
      revisionId: chapter.currentRevisionId!,
      beatId: first!.beatId,
      before: first!.body,
      after: '重复提案',
      reason: '重复',
      issueRef: 'iss_03'
    })

    const result = decidePatches(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      decisions: [
        { patchId: p1.id, accept: true },
        { patchId: p2.id, accept: false }
      ]
    })
    expect(result.applied).toEqual([p1.id])
    expect(result.rejected).toEqual([p2.id])
    expect(result.superseded).toEqual([p3.id])
    expect(w.repos.patch.get(p1.id)!.status).toBe('applied')
    expect(w.repos.patch.get(p1.id)!.appliedRevisionId).toBe(result.revisionId)
    expect(w.repos.patch.get(p2.id)!.status).toBe('rejected')
    expect(w.repos.patch.get(p3.id)!.status).toBe('superseded')
  })

  it('全部拒绝：不产生新 revision', () => {
    const w = world()
    const [first] = seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const patch = w.repos.patch.insert({
      projectId: w.projectId,
      proposalId: 'prop_1',
      revisionId: chapter.currentRevisionId!,
      beatId: first!.beatId,
      before: first!.body,
      after: '改',
      reason: '测试',
      issueRef: 'iss_01'
    })
    const revisions = w.repos.revision.listByChapter(w.chapterId).length
    const result = decidePatches(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      decisions: [{ patchId: patch.id, accept: false }]
    })
    expect(result.revisionId).toBeNull()
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisions)
    expect(w.repos.patch.get(patch.id)!.status).toBe('rejected')
  })
})

describe('finalizeChapter', () => {
  function gate(w: WriteTestWorld, gateId: 'G6' = 'G6') {
    return issueAuthorGate({
      repos: w.repos,
      secret: 'unit-gate',
      projectId: w.projectId,
      gateId,
      entityType: 'chapter',
      entityId: w.chapterId,
      revision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
      jobId: 'author_g6_test',
      actor: 'author'
    })
  }

  it('没有 G6 记录 → gate_required；有记录但未勾选阻断 → gate_required', () => {
    const w = world()
    seedBeats(w)
    const chapter = w.repos.chapter.get(w.chapterId)!
    expect(() =>
      finalizeChapter(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        gateRecordId: 'gate_missing',
        actor: 'author',
        ackBlocking: true,
        ackUnreviewed: true,
        blocking: [],
        unreviewed: []
      })
    ).toThrowError(/G6 记录/)

    const issued = gate(w)
    expect(() =>
      finalizeChapter(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        gateRecordId: issued.gateRecordId,
        actor: 'author',
        ackBlocking: false,
        ackUnreviewed: true,
        blocking: [
          {
            issue_id: 'iss_01',
            type: 'knowledge_leak',
            beat_id: chapter.currentRevisionId!,
            evidence: 'x',
            why: 'y',
            suggestion: '',
            downgraded: null
          }
        ],
        unreviewed: []
      })
    ).toThrowError(/未确认的阻断/)
  })

  it('定稿创建 final 快照、写 G6 记录、入队 memory.extract；重复定稿幂等', () => {
    const w = world()
    seedBeats(w)
    const issued = gate(w)
    const result = finalizeChapter(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      gateRecordId: issued.gateRecordId,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })
    expect(result.alreadyFinalized).toBe(false)
    const final = w.repos.revision.get(result.finalRevisionId)!
    expect(final.kind).toBe('final')
    expect(w.repos.revision.get(result.sourceRevisionId)!.kind).toBe('draft')
    expect(w.repos.chapter.get(w.chapterId)!.status).toBe('finalized')
    expect(w.repos.chapter.get(w.chapterId)!.finalRevisionId).toBe(final.id)

    const record = w.repos.gate.get(issued.gateRecordId)!
    const payload = JSON.parse(record.payloadJson) as { finalRevisionId: string; ackedBlocking: boolean }
    expect(payload.finalRevisionId).toBe(final.id)
    expect(payload.ackedBlocking).toBe(true)

    const job = w.repos.job.get(result.memoryJobId!)!
    expect(job.type).toBe('memory.extract')
    expect(job.status).toBe('queued')
    expect(job.expectedRevision).toBe(final.id)

    const again = finalizeChapter(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      gateRecordId: issued.gateRecordId,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })
    expect(again.alreadyFinalized).toBe(true)
    expect(again.finalRevisionId).toBe(final.id)
    expect(w.repos.revision.listByChapter(w.chapterId).filter((r) => r.kind === 'final')).toHaveLength(1)
  })
})

describe('G5/G6 作者令牌', () => {
  it('签发 → 校验 → 消费；错实体/过期/复用都拒绝', () => {
    const w = world()
    const chapter = w.repos.chapter.get(w.chapterId)!
    const issued = issueAuthorGate({
      repos: w.repos,
      secret: 'unit-gate',
      projectId: w.projectId,
      gateId: 'G5',
      entityType: 'revision',
      entityId: chapter.currentRevisionId!,
      revision: chapter.currentRevisionId,
      jobId: 'job_patch_1',
      actor: 'author',
      ttlMs: 60_000
    })

    const record = checkAuthorGate({
      repos: w.repos,
      secret: 'unit-gate',
      gateId: 'G5',
      entityType: 'revision',
      entityId: chapter.currentRevisionId!,
      revision: chapter.currentRevisionId,
      token: issued.token
    })
    expect(record.id).toBe(issued.gateRecordId)

    expect(() =>
      checkAuthorGate({
        repos: w.repos,
        secret: 'unit-gate',
        gateId: 'G6',
        entityType: 'revision',
        entityId: chapter.currentRevisionId!,
        revision: chapter.currentRevisionId,
        token: issued.token
      })
    ).toThrowError(/授权闸门不匹配/)

    expect(() =>
      checkAuthorGate({
        repos: w.repos,
        secret: 'unit-gate',
        gateId: 'G5',
        entityType: 'revision',
        entityId: 'rev_other',
        revision: chapter.currentRevisionId,
        token: issued.token
      })
    ).toThrowError(/授权对象不匹配/)

    consumeAuthorGate(w.repos, issued.token)
    expect(() =>
      checkAuthorGate({
        repos: w.repos,
        secret: 'unit-gate',
        gateId: 'G5',
        entityType: 'revision',
        entityId: chapter.currentRevisionId!,
        revision: chapter.currentRevisionId,
        token: issued.token
      })
    ).toThrowError(/已使用/)

    const expired = issueAuthorGate({
      repos: w.repos,
      secret: 'unit-gate',
      projectId: w.projectId,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: w.chapterId,
      revision: chapter.currentRevisionId,
      jobId: 'author_g6_2',
      actor: 'author',
      ttlMs: 1
    })
    expect(() =>
      checkAuthorGate({
        repos: w.repos,
        secret: 'unit-gate',
        gateId: 'G6',
        entityType: 'chapter',
        entityId: w.chapterId,
        revision: chapter.currentRevisionId,
        token: expired.token,
        nowMs: Date.now() + 1000
      })
    ).toThrowError(/过期/)
  })
})
