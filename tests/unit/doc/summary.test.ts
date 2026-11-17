import { afterEach, describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { buildChapterSummary } from '../../../src/main/doc/summary'
import { collectContext } from '../../../src/main/context/sources'
import { assembleContext } from '../../../src/main/context/assemble'
import { issueAuthorGate } from '../../../src/main/review/gates'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { confirmG2 } from '../../../src/main/scheduler/g2'
import { saveStoryboardDraft } from '../../../src/main/scheduler/storyboard'
import { estimateTokens } from '../../../src/main/context/tokens'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 章末摘要（PHASE-16 §5.4 / M1-13）：
 *   - finalize 同事务写 chapter_summary（首拍 + 末拍 + 关键事实 ≤5，≤300 tokens）；
 *   - 摘要不参与 hash、不写 beat.body；
 *   - collectContext 把上一章摘要作为 previousSummary 交给 L0 装配。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function register(created: WriteTestWorld): WriteTestWorld {
  worlds.push(created)
  return created
}

function writeBodies(w: WriteTestWorld, bodies: readonly string[]): string[] {
  const project = w.repos.project.get()!
  const ids: string[] = []
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
      body: bodies[index % bodies.length]!,
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

function finalizeNow(w: WriteTestWorld): string {
  const issued = issueAuthorGate({
    repos: w.repos,
    secret: 'unit-gate',
    projectId: w.projectId,
    gateId: 'G6',
    entityType: 'chapter',
    entityId: w.chapterId,
    revision: w.repos.chapter.get(w.chapterId)!.currentRevisionId,
    jobId: 'author_g6_summary_test',
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
  }).finalRevisionId
}

describe('章末摘要', () => {
  it('first + last + 本章关键事实；≤300 tokens；不写正文', () => {
    const w = register(openWriteWorld({ sceneCount: 1, beatsPerScene: 3 }))
    const bodies = ['首拍：她把茶盏推了回去。', '中拍：他低头拨了拨灯芯。', '末拍：她没有退，手指扣住桌沿。']
    const beatIds = writeBodies(w, bodies)
    const chapter = w.repos.chapter.get(w.chapterId)!
    w.repos.world.insert({
      projectId: w.projectId,
      subject: '黑漆匣子',
      predicate: '位置',
      object: '供桌下面',
      truth: 'objective',
      visibility: 'public',
      validFromSeq: chapter.coveredUntilSeq,
      sourceType: 'author'
    })
    const beforeBodies = beatIds.map((id) => w.repos.beat.get(id)!.body)
    const finalId = finalizeNow(w)

    const summary = w.repos.chapterSummary.get(finalId)!
    expect(summary.chapterId).toBe(w.chapterId)
    expect(summary.source).toBe('extractive')
    expect(summary.summary).toContain('首拍')
    expect(summary.summary).toContain('末拍')
    expect(summary.summary).not.toContain('中拍')
    expect(summary.keyFactsJson).toContain('黑漆匣子')
    expect(summary.tokens).toBeLessThanOrEqual(300)
    expect(summary.tokens).toBe(estimateTokens(`${summary.summary}\n关键事实：黑漆匣子 位置 供桌下面`))
    // 摘要不写正文。
    expect(beatIds.map((id) => w.repos.beat.get(id)!.body)).toEqual(beforeBodies)
    // 定稿 hash 不因摘要变化：复算仍等于存储值。
    const final = w.repos.revision.get(finalId)!
    expect(final.contentHash).toHaveLength(64)
  })

  it('超长首末拍压到 ≤300 tokens；关键事实最多 5 条', () => {
    const w = register(openWriteWorld({ sceneCount: 1, beatsPerScene: 2 }))
    const long = '她'.repeat(500)
    writeBodies(w, [long, long])
    const chapter = w.repos.chapter.get(w.chapterId)!
    for (let index = 0; index < 7; index += 1) {
      w.repos.world.insert({
        projectId: w.projectId,
        subject: `fact_${index}`,
        predicate: '状态',
        object: '成立',
        truth: 'objective',
        visibility: 'public',
        validFromSeq: chapter.coveredUntilSeq,
        sourceType: 'author'
      })
    }
    const finalId = finalizeNow(w)
    const summary = w.repos.chapterSummary.get(finalId)!
    expect(summary.tokens).toBeLessThanOrEqual(300)
    const facts = JSON.parse(summary.keyFactsJson) as string[]
    expect(facts).toHaveLength(5)
    expect(facts.every((fact) => fact.includes('fact_'))).toBe(true)
  })

  it('collectContext：下一章装配带上上一章摘要（L0:summary:prev）', () => {
    const w = register(openWriteWorld({ sceneCount: 1, beatsPerScene: 1 }))
    writeBodies(w, ['她把茶盏往他那边推了推。'])
    finalizeNow(w)
    const chapter1 = w.repos.chapter.get(w.chapterId)!

    // 第 2 章：一章一场一拍（走真实 G2 物化）。
    const root = w.repos.outline.listByProject(w.projectId).find((node) => node.kind === 'main')!
    const node = w.repos.outline.insert({
      projectId: w.projectId,
      parentId: root.id,
      kind: 'chapter',
      ord: 2,
      title: '旧账最后一页',
      content: '从穆掌柜手里拿到旧账',
      status: 'approved'
    })
    const chapter2 = w.repos.chapter.insert({
      projectId: w.projectId,
      outlineNodeId: node.id,
      ord: 2,
      status: 'planned'
    })
    saveStoryboardDraft(w.repos, {
      chapterId: chapter2.id,
      updatedBy: 'author',
      scenes: [
        {
          location: '穆家铺子',
          participants: [w.characterIds[0]!],
          goal: '拿到旧账',
          entry: '',
          exit: 'beats(1)',
          max_beats: 2,
          beats: [{ speaker_type: 'character', speaker_id: w.characterIds[0]!, intent: '开口', max_words: 120 }]
        }
      ]
    })
    confirmG2(w.handle.db, w.repos, { chapterId: chapter2.id, actor: 'author' })
    const beat = w.repos.beat.listLiveByChapter(chapter2.id)[0]!

    const collected = collectContext(w.repos, {
      projectId: w.projectId,
      chapterId: chapter2.id,
      beatId: beat.id,
      agent: `character:${w.characterIds[0]!}`
    })
    expect(collected.input.previousSummary?.chapterId).toBe(chapter1.id)
    expect(collected.input.previousSummary?.chapterOrd).toBe(1)
    expect(collected.input.previousSummary?.text).toContain('她把茶盏')

    const assembled = assembleContext(collected.input)
    const block = assembled.bundle.blocks.find((item) => item.id === 'L0:summary:prev')
    expect(block).toBeDefined()
    expect(block?.text).toContain('上一章（第 1 章 祠堂夜谈）摘要')
    expect(block?.tokens).toBeLessThanOrEqual(300)

    // 第 1 章本身没有上一章摘要。
    const first = collectContext(w.repos, {
      projectId: w.projectId,
      chapterId: chapter1.id,
      beatId: w.repos.beat.listLiveByChapter(chapter1.id)[0]!.id,
      agent: `character:${w.characterIds[0]!}`
    })
    expect(first.input.previousSummary).toBeUndefined()

    // buildChapterSummary 是纯读取：再算一次不改变任何行。
    const draft = buildChapterSummary(w.repos, {
      chapterId: chapter1.id,
      revisionId: recordFinalId(w)
    })
    expect(draft.tokens).toBeLessThanOrEqual(300)
  })
})

function recordFinalId(w: WriteTestWorld): string {
  return w.repos.chapter.get(w.chapterId)!.finalRevisionId!
}
