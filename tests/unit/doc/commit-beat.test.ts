import { afterEach, describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { confirmBeat, editBeat } from '../../../src/main/doc/beats'
import { hashManifestRows } from '../../../src/main/db/hash'
import { loadLiveManifest, recomputeRevisionHash } from '../../../src/main/db/revision'
import { verifyDatabase } from '../../../src/main/db/verify'
import { openSliceWorld, type SliceTestWorld } from '../../support/slice-world'

const worlds: SliceTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): SliceTestWorld {
  const created = openSliceWorld()
  worlds.push(created)
  return created
}

function currentChapter(w: SliceTestWorld) {
  return w.repos.chapter.get(w.chapterId)!
}

/** 生成一拍：替换种子里的 proposed 占位。 */
function generate(w: SliceTestWorld, beatId: string, body: string) {
  const beat = w.repos.beat.get(beatId)!
  const project = w.repos.project.get()!
  const chapter = currentChapter(w)
  return commitBeat(w.handle.db, w.repos, {
    chapterId: w.chapterId,
    expectedRevision: chapter.currentRevisionId,
    epoch: project.writeEpoch,
    sceneId: beat.sceneId,
    ord: beat.ord,
    speakerType: beat.speakerType,
    speakerId: beat.speakerId,
    body,
    intent: beat.intent,
    grounding: [],
    traceRef: 'logs/trace/job_test/turn_test.json',
    supersedesId: beat.id,
    status: 'draft'
  })
}

describe('commitBeat（唯一正文写入者）', () => {
  it('一次提交：+1 beat、+1 revision、清单 2 行、hash 可复算、outbox 入队', () => {
    const w = world()
    const before = w.repos.revision.listByChapter(w.chapterId).length
    const beforeRevision = currentChapter(w).currentRevisionId
    const result = generate(w, w.beatIds[0]!, '雨敲在瓦上，一声接一声。')

    const old = w.repos.beat.get(w.beatIds[0]!)!
    expect(old.status).toBe('superseded')
    const fresh = w.repos.beat.get(result.beatId)!
    expect(fresh.status).toBe('draft')
    expect(fresh.body).toBe('雨敲在瓦上，一声接一声。')
    expect(fresh.seq).toBe(result.seq)
    expect(fresh.supersedesId).toBe(old.id)
    expect(fresh.traceRef).toBe('logs/trace/job_test/turn_test.json')

    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(before + 1)
    expect(w.repos.revision.countMembers(result.revisionId)).toBe(2)
    expect(result.parentRevisionId).toBe(beforeRevision)
    expect(recomputeRevisionHash(w.handle.db, result.revisionId)).toBe(result.contentHash)
    expect(hashManifestRows(loadLiveManifest(w.handle.db, w.chapterId))).toBe(result.contentHash)

    expect(currentChapter(w).currentRevisionId).toBe(result.revisionId)
    const outbox = w.repos.outbox.latestForChapter(w.chapterId)!
    expect(outbox.revisionId).toBe(result.revisionId)
    expect(outbox.expectedHash).toBe(result.mirrorHash)

    const report = verifyDatabase(w.handle.db, { projectDir: w.dir, checkMirror: false })
    expect(report.ok, JSON.stringify(report.issues)).toBe(true)
  })

  it('expected_revision 不匹配 → stale_revision，且不写任何行', () => {
    const w = world()
    const beat = w.repos.beat.get(w.beatIds[0]!)!
    const project = w.repos.project.get()!
    const beatsBefore = w.repos.beat.listByChapter(w.chapterId).length
    const revisionsBefore = w.repos.revision.listByChapter(w.chapterId).length

    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: 'rev_stale',
        epoch: project.writeEpoch,
        sceneId: beat.sceneId,
        ord: beat.ord,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '不该落盘',
        supersedesId: beat.id
      })
    ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))

    expect(w.repos.beat.listByChapter(w.chapterId)).toHaveLength(beatsBefore)
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisionsBefore)
    expect(w.repos.beat.get(beat.id)!.status).toBe('proposed')
  })

  it('epoch 不匹配 → stale_revision(epoch)', () => {
    const w = world()
    const beat = w.repos.beat.get(w.beatIds[0]!)!
    const chapter = currentChapter(w)
    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: 99,
        sceneId: beat.sceneId,
        ord: beat.ord,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '迟到结果',
        supersedesId: beat.id
      })
    ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
  })

  it('空正文与跨槽位 supersedes 都被拒绝', () => {
    const w = world()
    const first = w.repos.beat.get(w.beatIds[0]!)!
    const second = w.repos.beat.get(w.beatIds[1]!)!
    const chapter = currentChapter(w)
    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: 0,
        sceneId: first.sceneId,
        ord: first.ord,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '   ',
        supersedesId: first.id
      })
    ).toThrowError(expect.objectContaining({ code: 'schema_invalid' }))

    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: 0,
        sceneId: first.sceneId,
        ord: first.ord,
        speakerType: 'character',
        speakerId: 'chr_lin',
        body: '槽位不匹配',
        supersedesId: second.id
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_args' }))

    expect(() =>
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: 0,
        sceneId: first.sceneId,
        ord: first.ord,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '不能直接写瞬时状态',
        supersedesId: first.id,
        status: 'generating'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_args' }))
  })
})

describe('拍的显式状态迁移', () => {
  it('确认：waiting_for_human → confirmed，covered_until_seq 推进到该拍 seq', () => {
    const w = world()
    const result = generate(w, w.beatIds[0]!, '灯芯爆了一下。')
    w.repos.beat.setStatus(result.beatId, 'waiting_for_human')
    const confirmed = confirmBeat(w.handle.db, w.repos, result.beatId, 'author')

    expect(confirmed.status).toBe('confirmed')
    expect(w.repos.beat.get(result.beatId)!.decidedBy).toBe('author')
    expect(confirmed.coveredUntilSeq).toBe(result.seq)
    expect(currentChapter(w).coveredUntilSeq).toBe(result.seq)
  })

  it('proposed 占位不能确认', () => {
    const w = world()
    expect(() => confirmBeat(w.handle.db, w.repos, w.beatIds[0]!)).toThrowError(
      expect.objectContaining({ code: 'invalid_args' })
    )
  })

  it('作者编辑：新版本 author_edited、旧拍 superseded、后续 confirmed 拍 stale', () => {
    const w = world()
    generate(w, w.beatIds[0]!, '第一拍正文。')
    const second = generate(w, w.beatIds[1]!, '第二拍正文。')
    w.repos.beat.setStatus(second.beatId, 'waiting_for_human')
    confirmBeat(w.handle.db, w.repos, second.beatId)

    const firstLive = w.repos.beat
      .listLiveByChapter(w.chapterId)
      .find((beat) => beat.ord === 1)!
    const chapter = currentChapter(w)
    const edited = editBeat(w.handle.db, w.repos, {
      beatId: firstLive.id,
      body: '第一拍正文（作者改过）。',
      expectedRevision: chapter.currentRevisionId
    })

    expect(w.repos.beat.get(firstLive.id)!.status).toBe('superseded')
    const fresh = w.repos.beat.get(edited.commit.beatId)!
    expect(fresh.status).toBe('author_edited')
    expect(fresh.authorEdited).toBe(1)
    expect(fresh.body).toBe('第一拍正文（作者改过）。')
    expect(fresh.intent).toBe(firstLive.intent)
    expect(edited.staled).toContain(second.beatId)
    expect(w.repos.beat.get(second.beatId)!.status).toBe('stale')
    expect(currentChapter(w).currentRevisionId).toBe(edited.commit.revisionId)
  })
})
