import { afterEach, describe, expect, it } from 'vitest'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { reopenChapter } from '../../../src/main/doc/reopen'
import { issueAuthorGate, consumeAuthorGate } from '../../../src/main/review/gates'
import { markChapterComplete } from '../../../src/main/scheduler/loop'
import { MemoryService } from '../../../src/main/memory/service'
import { hashEmbedding } from '../../../src/main/memory/embed/hash'
import { normalizeVector, type Embedder } from '../../../src/main/memory/embed/types'
import { ALL_MANIFESTS } from '../../../src/main/tools/manifests'
import { buildRegistry } from '../../../src/main/tools/registry'
import { SettingsSchema } from '../../../src/shared/schema/project'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * PHASE-16 §5.1：重开再定稿自动入队的 `memory.rebuild` 必须能真正执行并让
 * 旧 final 来源记忆 inactive。与 E2E 共用同一条服务链路（fake 模型 + hash 向量）。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

const LINES = [
  '她把茶盏往他那边推了推，声音压得很低：「我爹书房里那只黑漆匣子，你见过没有？」',
  '他知道那匣子里装着什么，却只低头拨了拨灯芯，说：「没见过。」',
  '她把他的沉默当成回答：「账本在祠堂。」',
  '窗外的雨忽然大了，瓦上像有人在数拍子。',
  '他抬起头，第一次正眼看她：「你确定要问下去？」',
  '她没有退，手指扣住桌沿，指节发白。'
]

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const embedder: Embedder = {
  model: 'hash-bigram-v1',
  dim: 512,
  source: 'hash',
  async embed(texts) {
    return texts.map((text) => normalizeVector(hashEmbedding(text)))
  },
  async dispose() {
    // no-op
  }
}

function seedFinal(w: WriteTestWorld): string {
  const project = w.repos.project.get()!
  for (const [index, beat] of w.repos.beat.listLiveByChapter(w.chapterId).entries()) {
    const chapter = w.repos.chapter.get(w.chapterId)!
    commitBeat(w.handle.db, w.repos, {
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
    jobId: 'g6_rebuild_auto_1',
    actor: 'author'
  })
  return (() => {
    const result = finalizeChapter(w.handle.db, w.repos, {
      chapterId: w.chapterId,
      gateRecordId: issued.gateRecordId,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })
    consumeAuthorGate(w.repos, issued.token)
    return result.finalRevisionId
  })()
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
    jobId: 'g6_rebuild_auto_2',
    actor: 'author'
  })
  const result = finalizeChapter(w.handle.db, w.repos, {
    chapterId: w.chapterId,
    gateRecordId: issued.gateRecordId,
    actor: 'author',
    ackBlocking: true,
    ackUnreviewed: true,
    blocking: [],
    unreviewed: []
  })
  consumeAuthorGate(w.repos, issued.token)
  return result
}

describe('重开再定稿 → memory.rebuild 自动执行', () => {
  it('旧 final 记忆 inactive；新 final 重建；不重复入队 extract', async () => {
    const w = openWriteWorld({ sceneCount: 1, beatsPerScene: 6 })
    worlds.push(w)
    const service = new MemoryService({
      host: () => ({ dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }),
      registry,
      settings: () => SettingsSchema.parse({}),
      allowFakeModel: true,
      env: { NORYTH_MEMORY_FAKE: '1' },
      gateSecret: 'unit-gate',
      send: () => undefined,
      embedder,
      fakeChunkDelayMs: 0
    })
    const final1 = seedFinal(w)

    // 第一版记忆固化。
    await service.extract(w.chapterId)
    const items = service.proposalsOf(w.chapterId)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) service.decide({ itemId: item.id, decision: 'accept' })
    const g7 = service.issueG7Token(w.chapterId)
    await service.apply({ chapterId: w.chapterId, token: g7.token })
    const activeBefore = w.repos.memory.listBySource(w.chapterId).filter((entry) => entry.status === 'active')
    expect(activeBefore.length).toBeGreaterThan(0)

    // 重开 → 改一拍 → 再定稿（自动入队 memory.rebuild）。
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
      body: '重开后的第一处修改。',
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'author_edited',
      createdBy: 'author'
    })
    const second = finalizeAgain(w)
    expect(second.previousFinalRevisionId).toBe(final1)
    expect(second.memoryJobType).toBe('memory.rebuild')

    await service.runQueuedRebuild(second.memoryJobId!)

    const after = w.repos.memory.listBySource(w.chapterId)
    expect(after.some((entry) => entry.status === 'inactive')).toBe(true)
    expect(after.some((entry) => entry.status === 'active')).toBe(true)
    const rebuild = w.repos.job.get(second.memoryJobId!)!
    expect(rebuild.status).toBe('succeeded')
    expect((JSON.parse(rebuild.resultJson!) as { applied?: boolean }).applied).toBe(true)
  })
})
