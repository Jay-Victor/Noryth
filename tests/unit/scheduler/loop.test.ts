import { afterEach, describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { confirmBeat } from '../../../src/main/doc/beats'
import { verifyDatabase } from '../../../src/main/db/verify'
import { fullVerify } from './helpers'
import { confirmG2, previewG2 } from '../../../src/main/scheduler/g2'
import { saveStoryboardDraft, validateChapterStoryboard } from '../../../src/main/scheduler/storyboard'
import {
  chapterBudget,
  closeScene,
  decideNext,
  evaluateSceneExit,
  markChapterComplete,
  nextActionableBeat
} from '../../../src/main/scheduler/loop'
import type { WriteTestWorld } from '../../support/write-world'
import { openWriteWorld } from '../../support/write-world'

/**
 * 调度循环判定（PHASE-07 F2/F3/F6/F7）：
 * 出口/拍数/预算/耗尽四类停止条件，加上重生成补偿与 G2 闸门。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(options: Parameters<typeof openWriteWorld>[0] = {}): WriteTestWorld {
  const created = openWriteWorld(options)
  worlds.push(created)
  return created
}

/** 生产路径的等价简化：一拍正文落盘（commitBeat 是唯一写入者）。 */
function writeBody(w: WriteTestWorld, beatId: string, body: string): string {
  const beat = w.repos.beat.get(beatId)!
  const chapter = w.repos.chapter.get(w.chapterId)!
  const project = w.repos.project.get()!
  const committed = commitBeat(w.handle.db, w.repos, {
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
    status: 'draft',
    maxWords: beat.maxWords
  })
  return committed.beatId
}

function generateAndConfirm(w: WriteTestWorld, beatId: string, body = `正文 ${beatId}`): string {
  const newId = writeBody(w, beatId, body)
  confirmBeat(w.handle.db, w.repos, newId)
  return newId
}

describe('G2 与分镜物化', () => {
  it('G2 把草案物化成 scene/beat（proposed），章进入 storyboard_ready，verify 全绿', () => {
    const w = world({ sceneCount: 2, beatsPerScene: 3 })
    const chapter = w.repos.chapter.get(w.chapterId)!
    expect(chapter.status).toBe('storyboard_ready')
    expect(w.sceneIds).toHaveLength(2)
    expect(w.beatIds).toHaveLength(6)
    for (const beat of w.repos.beat.listLiveByChapter(w.chapterId)) {
      expect(beat.status).toBe('proposed')
      expect(beat.body).toBe('')
      expect(beat.seq).toBeNull()
    }
    const gate = w.repos.gate.listByEntity('chapter', w.chapterId).find((record) => record.gateId === 'G2')
    expect(gate?.decision).toBe('approve')
    const report = fullVerify(w)
    expect(report.ok, JSON.stringify(report.issues)).toBe(true)
  })

  it('硬冲突时 G2 拒绝开演，并给出第一条原因', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 2 })
    const draft = {
      location: '祠堂',
      participants: ['chr_lin'],
      goal: '摊牌',
      exit: '等他们吵完',
      max_beats: 4,
      beats: [
        { speaker_type: 'character' as const, speaker_id: 'chr_yan', intent: '不在场的人说话' },
        { speaker_type: 'narrator' as const, speaker_id: 'narrator', intent: '收尾' }
      ]
    }
    saveStoryboardDraft(w.repos, { chapterId: w.chapterId, scenes: [draft], updatedBy: 'author' })
    const conflicts = validateChapterStoryboard(w.repos, w.chapterId)
    expect(conflicts.some((conflict) => conflict.code === 'exit_invalid')).toBe(true)
    expect(conflicts.some((conflict) => conflict.code === 'speaker_not_in_participants')).toBe(true)

    const preview = previewG2(w.repos, w.chapterId)
    expect(preview.ready).toBe(false)
    expect(preview.blocker).toBeTruthy()
    expect(() => confirmG2(w.handle.db, w.repos, { chapterId: w.chapterId })).toThrowError(/硬冲突/)
  })

  it('下一次可发牌的拍：按顺序，前拍确认后才轮到下一拍', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 3 })
    expect(nextActionableBeat(w.repos, w.chapterId)?.id).toBe(w.beatIds[0])

    const generated = writeBody(w, w.beatIds[0]!, '第一拍')
    // 已落草稿但未确认：不跳过
    expect(nextActionableBeat(w.repos, w.chapterId)).toBeNull()
    confirmBeat(w.handle.db, w.repos, generated)
    expect(nextActionableBeat(w.repos, w.chapterId)?.ord).toBe(2)
  })

  it('重生成三次：旧拍全 superseded，无双活、无孤儿，verify 全绿', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 2 })
    const slot = w.beatIds[0]!
    const versions = [writeBody(w, slot, '第一版')]
    for (const body of ['第二版', '第三版', '第四版']) {
      versions.push(writeBody(w, versions[versions.length - 1]!, body))
    }
    const all = w.repos.beat.listByChapter(w.chapterId).filter((beat) => beat.sceneId === w.sceneIds[0]!)
    // 1 个分镜占位版本 + 3 次重生成 = 4 条 superseded；活行始终只有 1 条。
    expect(all.filter((beat) => beat.status === 'superseded')).toHaveLength(4)
    expect(all.filter((beat) => beat.status !== 'superseded' && beat.ord === 1)).toHaveLength(1)
    expect(w.repos.beat.get(versions[3]!)!.body).toBe('第四版')

    for (const revision of w.repos.revision.listByChapter(w.chapterId)) {
      expect(w.repos.revision.countMembers(revision.id)).toBe(w.repos.beat.listLiveByChapter(w.chapterId).length)
    }
    const report = verifyDatabase(w.handle.db, { projectDir: w.dir, checkMirror: false })
    expect(report.ok, JSON.stringify(report.issues)).toBe(true)
    expect(report.issues.map((issue) => issue.code)).not.toContain('seq_not_monotonic')
  })
})

describe('循环停止条件', () => {
  it('出口满足 → 关场景；所有场景 closed → complete', () => {
    const w = world({ sceneCount: 2, beatsPerScene: 2 })
    for (const beatId of w.beatIds) generateAndConfirm(w, beatId)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const decision = decideNext(w.repos, chapter, { auto: true, budget: chapterBudget(w.repos, chapter) })
    expect(decision.kind).toBe('close_scene')
    if (decision.kind !== 'close_scene') return
    expect(decision.reason).toBe('exit_satisfied')
    expect(decision.scene.scene.id).toBe(w.sceneIds[0])

    // 关掉两场
    for (const sceneId of w.sceneIds) {
      const scene = w.repos.scene.listByChapter(w.chapterId).find((entry) => entry.scene.id === sceneId)!
      closeScene(w.handle.db, w.repos, { chapter, scene, reason: 'exit_satisfied' })
    }
    markChapterComplete(w.handle.db, w.repos, w.repos.chapter.get(w.chapterId)!)
    const done = w.repos.chapter.get(w.chapterId)!
    expect(done.status).toBe('draft_complete')
    expect(decideNext(w.repos, done, { auto: true, budget: chapterBudget(w.repos, done) }).kind).toBe('complete')
    expect(w.repos.schedulerEvent.listByChapter(w.chapterId).some((event) => event.kind === 'chapter_complete')).toBe(true)
  })

  it('出口未满足且拍数到 max_beats → 按 WARN 收束', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 3, exit: 'all(fact("black_box","location"), beats(6))' })
    const sceneId = w.sceneIds[0]!
    w.repos.scene.update(sceneId, { maxBeats: 2 })
    generateAndConfirm(w, w.beatIds[0]!)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const decision = decideNext(w.repos, chapter, { auto: true, budget: chapterBudget(w.repos, chapter) })
    expect(decision.kind).toBe('beat')

    generateAndConfirm(w, w.beatIds[1]!)
    const fresh = w.repos.chapter.get(w.chapterId)!
    const atLimit = decideNext(w.repos, fresh, { auto: true, budget: chapterBudget(w.repos, fresh) })
    expect(atLimit.kind).toBe('close_scene')
    if (atLimit.kind !== 'close_scene') return
    expect(atLimit.reason).toBe('max_beats')
    const closed = closeScene(w.handle.db, w.repos, { chapter: fresh, scene: atLimit.scene, reason: 'max_beats' })
    expect(closed.warn).toBe('exit_conditions_unsatisfied')
  })

  it('分镜耗尽且出口未满足 → storyboard_exhausted，不即兴续写', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 2, exit: 'all(fact("black_box","location"), beats(5))' })
    for (const beatId of w.beatIds) generateAndConfirm(w, beatId)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const decision = decideNext(w.repos, chapter, { auto: true, budget: chapterBudget(w.repos, chapter) })
    expect(decision.kind).toBe('exhausted')
    // 没有新增拍
    expect(w.repos.beat.listLiveByChapter(w.chapterId)).toHaveLength(2)
  })

  it('预算用尽 → 自动模式在拍边界暂停', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 2, budgetTokens: 100 })
    const beatId = w.beatIds[0]!
    w.repos.turnMetric.insert({
      turnId: 'turn_budget',
      projectId: w.projectId,
      jobId: 'job_budget',
      beatId,
      agentKey: 'character',
      provider: 'deepseek',
      model: 'deepseek-flash',
      bindingVersion: 1,
      tokensIn: 80,
      tokensOut: 40,
      costCny: 0.001,
      latencyMs: 10,
      firstTokenMs: 5,
      contextJson: '{}',
      createdAt: new Date().toISOString()
    })
    const chapter = w.repos.chapter.get(w.chapterId)!
    expect(chapterBudget(w.repos, chapter).exceeded).toBe(true)
    const decision = decideNext(w.repos, chapter, { auto: true, budget: chapterBudget(w.repos, chapter) })
    expect(decision.kind).toBe('pause')
    if (decision.kind !== 'pause') return
    expect(decision.reason).toBe('budget_exceeded')

    // 逐拍模式照常发牌（预算只约束自动模式）
    expect(decideNext(w.repos, chapter, { auto: false, budget: chapterBudget(w.repos, chapter) }).kind).toBe('beat')
  })

  it('出口求值：没有 DSL 的场景不可判定；有 DSL 且事实有效才满足', () => {
    const w = world({ sceneCount: 1, beatsPerScene: 2 })
    const entry = w.repos.scene.listByChapter(w.chapterId)[0]!
    const beats = w.repos.beat.listLiveByScene(entry.scene.id)
    const chapter = w.repos.chapter.get(w.chapterId)!
    const before = evaluateSceneExit(w.repos, chapter, entry, beats)
    expect(before.decidable).toBe(true)
    expect(before.satisfied).toBe(false)

    generateAndConfirm(w, w.beatIds[0]!)
    const mid = w.repos.scene.listByChapter(w.chapterId)[0]!
    expect(evaluateSceneExit(w.repos, w.repos.chapter.get(w.chapterId)!, mid, w.repos.beat.listLiveByScene(entry.scene.id)).satisfied).toBe(false)

    // 去掉事实 → 即使拍数够也不满足
    w.handle.db.prepare('UPDATE world_fact SET valid_to_seq = 0 WHERE id = ?').run('fact_box_location')
    generateAndConfirm(w, w.beatIds[1]!)
    const finalEntry = w.repos.scene.listByChapter(w.chapterId)[0]!
    const afterFactGone = evaluateSceneExit(
      w.repos,
      w.repos.chapter.get(w.chapterId)!,
      finalEntry,
      w.repos.beat.listLiveByScene(entry.scene.id)
    )
    expect(afterFactGone.satisfied).toBe(false)
  })
})
