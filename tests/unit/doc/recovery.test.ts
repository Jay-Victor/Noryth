import { describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { confirmBeat } from '../../../src/main/doc/beats'
import { recoverInterrupted } from '../../../src/main/doc/recovery'
import { openSliceWorld, type SliceTestWorld } from '../../support/slice-world'

function generate(w: SliceTestWorld, beatId: string, body: string): string {
  const beat = w.repos.beat.get(beatId)!
  const chapter = w.repos.chapter.get(w.chapterId)!
  const project = w.repos.project.get()!
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
    supersedesId: beat.id
  })
  return result.beatId
}

describe('启动恢复（强杀重启）', () => {
  it('running job 与 generating 拍 → interrupted；已确认拍不动', () => {
    const w = openSliceWorld()
    try {
      const first = generate(w, w.beatIds[0]!, '第一拍已经确认。')
      w.repos.beat.setStatus(first, 'waiting_for_human')
      confirmBeat(w.handle.db, w.repos, first)

      const second = generate(w, w.beatIds[1]!, '第二拍写到一半。')
      w.repos.beat.setStatus(second, 'generating')

      const project = w.repos.project.get()!
      const job = w.repos.job.insert({
        projectId: project.id,
        type: 'beat.generate',
        status: 'running',
        expectedRevision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
        epoch: project.writeEpoch,
        idempotencyKey: 'recovery-key',
        payloadJson: JSON.stringify({ beat_id: second })
      })

      const revisionBefore = w.repos.chapter.get(w.chapterId)!.currentRevisionId
      const report = recoverInterrupted(w.repos)

      expect(report.jobs).toContain(job.id)
      expect(report.beats).toContain(second)
      expect(w.repos.job.get(job.id)!.status).toBe('interrupted')
      expect(w.repos.beat.get(second)!.status).toBe('interrupted')
      expect(w.repos.beat.get(first)!.status).toBe('confirmed')
      expect(w.repos.chapter.get(w.chapterId)!.currentRevisionId).toBe(revisionBefore)
      expect(w.repos.beat.listByChapter(w.chapterId).filter((b) => b.status === 'superseded')).toHaveLength(2)
    } finally {
      w.cleanup()
    }
  })

  it('没有卡住的任务时是空操作', () => {
    const w = openSliceWorld()
    try {
      expect(recoverInterrupted(w.repos)).toEqual({ jobs: [], beats: [] })
      expect(w.repos.beat.listByChapter(w.chapterId).map((beat) => beat.status)).toEqual([
        'proposed',
        'proposed'
      ])
    } finally {
      w.cleanup()
    }
  })
})
