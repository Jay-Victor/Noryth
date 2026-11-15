import { afterEach, describe, expect, it } from 'vitest'
import { compareRevisions, diffLines } from '../../../src/main/review/diff'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 版本对比（PHASE-08 G5 / UI-DESIGN §9.3）：
 * - 行级 LCS：same / add / remove，左右行号分别编号；
 * - 槽位对齐：patch 之后同一槽位是新 beat，对比不能显示成「删一段 + 加一段」；
 * - 未变更的槽位也出现在 hunks 里，由 UI 折叠。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

describe('diffLines', () => {
  it('相同文本全是 same；多行增删正确编号', () => {
    expect(diffLines('甲\n乙', '甲\n乙').every((line) => line.kind === 'same')).toBe(true)
    const lines = diffLines('甲\n乙\n丙', '甲\n丙')
    expect(lines.map((line) => line.kind)).toEqual(['same', 'remove', 'same'])
    expect(lines[1]).toMatchObject({ leftNo: 2, rightNo: 0, text: '乙' })

    const added = diffLines('甲', '甲\n乙')
    expect(added.map((line) => line.kind)).toEqual(['same', 'add'])
    expect(added[1]).toMatchObject({ leftNo: 0, rightNo: 2, text: '乙' })
  })

  it('空文本与单行都能对比', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('', '正文')).toEqual([{ kind: 'add', leftNo: 0, rightNo: 1, text: '正文' }])
    expect(diffLines('正文', '')).toEqual([{ kind: 'remove', leftNo: 1, rightNo: 0, text: '正文' }])
  })
})

describe('compareRevisions', () => {
  it('按槽位对齐：patch 后的同一拍是「已改」而不是删+加', () => {
    const w: WriteTestWorld = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
    worlds.push(w)
    const project = w.repos.project.get()!
    const beats = w.repos.beat.listLiveByChapter(w.chapterId)
    const bodies = ['第一拍正文。', '第二拍正文。']
    for (const [index, beat] of beats.entries()) {
      const chapter = w.repos.chapter.get(w.chapterId)!
      commitBeat(w.handle.db, w.repos, {
        chapterId: w.chapterId,
        expectedRevision: chapter.currentRevisionId,
        epoch: project.writeEpoch,
        sceneId: beat.sceneId,
        ord: beat.ord,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        body: bodies[index]!,
        intent: beat.intent,
        supersedesId: beat.id,
        status: 'confirmed',
        createdBy: 'doc_controller'
      })
    }
    markChapterComplete(w.handle.db, w.repos, w.repos.chapter.get(w.chapterId)!)
    const left = w.repos.chapter.get(w.chapterId)!.currentRevisionId!

    const firstLive = w.repos.beat.listLiveByChapter(w.chapterId)[0]!
    const chapter = w.repos.chapter.get(w.chapterId)!
    commitBeat(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: firstLive.sceneId,
      ord: firstLive.ord,
      speakerType: firstLive.speakerType,
      speakerId: firstLive.speakerId,
      body: '第一拍正文（改）。',
      intent: firstLive.intent,
      supersedesId: firstLive.id,
      status: 'confirmed',
      createdBy: 'reviewer'
    })
    const right = w.repos.chapter.get(w.chapterId)!.currentRevisionId!

    const result = compareRevisions(w.repos, {
      chapterId: w.chapterId,
      leftRevisionId: left,
      rightRevisionId: right
    })
    expect(result.changedBeats).toBe(1)
    expect(result.hunks.map((hunk) => hunk.status)).toEqual(['changed', 'same'])
    expect(result.hunks[0]!.leftBeatId).not.toBe(result.hunks[0]!.rightBeatId)
    expect(result.hunks[0]!.lines.some((line) => line.kind === 'remove')).toBe(true)
    expect(result.hunks[0]!.lines.some((line) => line.kind === 'add')).toBe(true)
    expect(result.leftHash).toBe(w.repos.revision.get(left)!.contentHash)
    expect(result.rightHash).toBe(w.repos.revision.get(right)!.contentHash)
  })
})
