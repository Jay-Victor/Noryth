import { afterEach, describe, expect, it } from 'vitest'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-repos-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

describe('repos: project / outline / character / chapter / scene', () => {
  it('project 读写、元数据、纪元与定稿统计', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    expect(repos.project.get()!.id).toBe(seed.projectId)
    expect(repos.project.updateMeta(seed.projectId, { title: '改名', genre: '民国', targetWords: 80000 }).title).toBe(
      '改名'
    )
    expect(repos.project.incrementWriteEpoch(seed.projectId)).toBe(1)
    repos.project.setSetupState(seed.projectId, 'complete')
    expect(repos.project.get()!.setupState).toBe('complete')

    repos.chapter.setStatus(seed.chapterIds[0]!, 'finalized')
    expect(repos.project.finalizedChapterCount()).toBe(1)
    expect(repos.project.finalizedWordCount()).toBeGreaterThan(0)
  })

  it('outline 树、版本递增与删除', () => {
    const { handle } = setup()
    const repos = handle.repos
    const root = repos.outline.listByProject(handle.repos.project.get()!.id).find((node) => node.parentId === null)!
    expect(repos.outline.children(root.id)).toHaveLength(2)
    const before = repos.outline.get(root.id)!
    const updated = repos.outline.update(root.id, { title: '新主线', content: '大纲正文' })
    expect(updated.version).toBe(before.version + 1)
    expect(updated.title).toBe('新主线')
    const leaf = repos.outline.insert({
      projectId: root.projectId,
      parentId: root.id,
      kind: 'chapter',
      ord: 99,
      title: '临时章'
    })
    repos.outline.remove(leaf.id)
    expect(repos.outline.get(leaf.id)).toBeNull()
  })

  it('character 卡版本、按名查找与归档', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    expect(repos.character.list(seed.projectId)).toHaveLength(5)
    expect(repos.character.byName(seed.projectId, '林砚')!.id).toBe(seed.characterIds[0])
    const before = repos.character.get(seed.characterIds[0]!)!
    const updated = repos.character.updateCard(seed.characterIds[0]!, JSON.stringify({ role: '主角', revision: 2 }))
    expect(updated.cardVersion).toBe(before.cardVersion + 1)
    repos.character.setStatus(seed.characterIds[0]!, 'archived')
    expect(repos.character.list(seed.projectId, { status: 'active' })).toHaveLength(4)
  })

  it('chapter 状态、revision 指针与 covered_until_seq', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const chapter = repos.chapter.get(seed.chapterIds[0]!)!
    expect(repos.chapter.listByProject(seed.projectId)).toHaveLength(2)
    repos.chapter.setStatus(chapter.id, 'under_review')
    repos.chapter.setCoveredUntilSeq(chapter.id, 12)
    expect(repos.chapter.get(chapter.id)!.coveredUntilSeq).toBe(12)
    repos.chapter.markFinalized(chapter.id, chapter.currentRevisionId!)
    const finalized = repos.chapter.get(chapter.id)!
    expect(finalized.status).toBe('finalized')
    expect(finalized.finalRevisionId).toBe(chapter.currentRevisionId)
    expect(finalized.finalizedAt).not.toBeNull()
  })

  it('scene 按章序读取、更新与解除关联', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const list = repos.scene.listByChapter(seed.chapterIds[0]!)
    expect(list.map((item) => item.chapterOrd)).toEqual([1, 2, 3])
    const scene = list[1]!.scene
    expect(repos.scene.update(scene.id, { status: 'closed', goal: '新目标' }).status).toBe('closed')
    repos.scene.unlinkFromChapter(seed.chapterIds[0]!, scene.id)
    expect(repos.scene.listByChapter(seed.chapterIds[0]!)).toHaveLength(2)
  })
})

describe('repos: beat / revision / patch', () => {
  it('beat 只追加、状态可改、superseded 后不计入现行', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const live = repos.beat.listLiveByChapter(seed.chapterIds[0]!)
    expect(live).toHaveLength(24)
    const target = live[0]!
    repos.beat.setStatus(target.id, 'confirmed', 'author')
    expect(repos.beat.get(target.id)!.status).toBe('confirmed')
    expect(repos.beat.nextOrd(target.sceneId)).toBe(9)
    repos.beat.markSuperseded(target.id)
    expect(repos.beat.countLive(seed.chapterIds[0]!)).toBe(23)
  })

  it('revision 清单读取与成员计数', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const revisions = repos.revision.listByChapter(seed.chapterIds[0]!)
    expect(revisions).toHaveLength(1)
    expect(repos.revision.countMembers(revisions[0]!.id)).toBe(24)
    expect(repos.revision.manifest(revisions[0]!.id)).toHaveLength(24)
    expect(repos.revision.listMembers(revisions[0]!.id)[0]!.sceneOrd).toBe(1)
  })

  it('patch 决策与应用记录', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const beat = repos.beat.listLiveByChapter(seed.chapterIds[0]!)[0]!
    const patch = repos.patch.insert({
      projectId: seed.projectId,
      proposalId: 'prop_1',
      revisionId: seed.chapters[0]!.revisionId,
      beatId: beat.id,
      before: beat.body,
      after: '修订后的正文',
      reason: '口吻不一致',
      issueRef: 'issue_1'
    })
    expect(repos.patch.setDecision(patch.id, 'accepted').status).toBe('accepted')
    const applied = repos.patch.markApplied(patch.id, 'rev_new')
    expect(applied.status).toBe('applied')
    expect(applied.appliedRevisionId).toBe('rev_new')
    expect(repos.patch.listByRevision(seed.chapters[0]!.revisionId)).toHaveLength(1)
  })
})

describe('repos: memory / world / review', () => {
  it('memory 软失效与取代链', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const chapter = seed.chapters[0]!
    const old = repos.memory.insert({
      projectId: seed.projectId,
      characterId: seed.characterIds[0]!,
      kind: 'fact',
      text: '匣子在书房',
      learnedSeq: 1,
      sourceChapterId: chapter.id,
      sourceRevisionId: chapter.revisionId,
      embeddingModel: 'bge-small-zh-v1.5'
    })
    const next = repos.memory.insert({
      projectId: seed.projectId,
      characterId: seed.characterIds[0]!,
      kind: 'fact',
      text: '匣子在祠堂',
      learnedSeq: 2,
      sourceChapterId: chapter.id,
      sourceRevisionId: chapter.revisionId,
      embeddingModel: 'bge-small-zh-v1.5'
    })
    repos.memory.supersede(old.id, next.id)
    expect(repos.memory.get(old.id)!.status).toBe('superseded')
    expect(repos.memory.get(next.id)!.supersedesId).toBe(old.id)
    repos.memory.closeValidity(next.id, 3)
    expect(repos.memory.get(next.id)!.validToSeq).toBe(3)
    expect(repos.memory.listByCharacter(seed.characterIds[0]!)).toHaveLength(2)
  })

  it('world fact / belief / relationship 读写', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const fact = repos.world.insert({
      projectId: seed.projectId,
      subject: '沈青梧',
      predicate: '身份',
      object: '沈家养女',
      truth: 'objective',
      visibility: 'secret',
      knownByJson: JSON.stringify([seed.characterIds[0]]),
      validFromSeq: 1,
      sourceType: 'author'
    })
    expect(repos.world.current('沈青梧', '身份')!.id).toBe(fact.id)
    const belief = repos.belief.insert({
      projectId: seed.projectId,
      characterId: seed.characterIds[1]!,
      factId: fact.id,
      beliefText: '她以为自己是亲生女儿',
      confidence: 0.8,
      learnedSeq: 2,
      sourceType: 'inference'
    })
    expect(repos.belief.listByCharacter(seed.characterIds[1]!)).toHaveLength(1)
    repos.belief.setStatus(belief.id, 'inactive')
    expect(repos.belief.get(belief.id)!.status).toBe('inactive')

    const edge = repos.relationship.insert({
      projectId: seed.projectId,
      fromId: seed.characterIds[0]!,
      toId: seed.characterIds[1]!,
      axis: 'tension',
      value: 0.3,
      sinceSeq: 1,
      sourceType: 'event'
    })
    expect(repos.relationship.current(seed.characterIds[0]!, seed.characterIds[1]!, 'tension')!.id).toBe(edge.id)
    expect(repos.relationship.listActiveFrom(seed.characterIds[0]!)).toHaveLength(1)
  })

  it('approval_report 与 gate_record 查询', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const report = repos.review.insertReport({
      projectId: seed.projectId,
      chapterId: seed.chapterIds[0]!,
      revisionId: seed.chapters[0]!.revisionId,
      round: 1,
      verdict: 'pass_with_notes',
      blockingJson: '[]',
      suggestionsJson: JSON.stringify(['加强场景转换']),
      model: 'deepseek-flash'
    })
    expect(repos.review.listReportsByChapter(seed.chapterIds[0]!)[0]!.id).toBe(report.id)
    const gate = repos.gate.insert({
      projectId: seed.projectId,
      gateId: 'G2',
      entityType: 'chapter',
      entityId: seed.chapterIds[0]!,
      decision: 'approve',
      actor: 'author'
    })
    expect(repos.gate.listByEntity('chapter', seed.chapterIds[0]!)[0]!.id).toBe(gate.id)
    expect(repos.gate.findByTokenHash('none')).toBeNull()
  })
})

describe('repos: job / tool_call / outbox', () => {
  it('job 幂等查找与状态迁移', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const job = repos.job.insert({
      projectId: seed.projectId,
      type: 'review.run',
      epoch: 0,
      idempotencyKey: 'review-1',
      payloadJson: JSON.stringify({ chapterId: seed.chapterIds[0] })
    })
    expect(repos.job.findByIdempotency(seed.projectId, 'review-1')!.id).toBe(job.id)
    repos.job.setStatus(job.id, 'running')
    expect(repos.job.listByStatus(seed.projectId, 'running')).toHaveLength(1)
    repos.job.setStatus(job.id, 'failed', { errorCode: 'model_error' })
    expect(repos.job.get(job.id)!.errorCode).toBe('model_error')
  })

  it('tool_call 只存 hash，按幂等键与 turn 查询', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    const call = repos.toolCall.insert({
      projectId: seed.projectId,
      jobId: 'job_1',
      turnId: 'turn_1',
      tool: 'memory.search',
      toolVersion: '1.0.0',
      actorId: 'character:chr_lin',
      scopeJson: JSON.stringify({ characterId: seed.characterIds[0], asOf: 10 }),
      argsHash: 'b'.repeat(64),
      status: 'ok',
      latencyMs: 25,
      idempotencyKey: 'call-1'
    })
    expect(call.resultJson).toBeNull()
    expect(repos.toolCall.findByIdempotency(seed.projectId, 'call-1')!.id).toBe(call.id)
    expect(repos.toolCall.listByTurn('turn_1')).toHaveLength(1)
  })

  it('outbox：pending → published，按章取最新', () => {
    const { handle, seed } = setup()
    const repos = handle.repos
    expect(repos.outbox.pendingCount(seed.projectId)).toBe(0)
    const published = repos.outbox.latestForChapter(seed.chapterIds[0]!)!
    expect(published.publishedAt).not.toBeNull()
    expect(repos.outbox.latestPublishedHash(seed.chapterIds[0]!)).toBe(published.expectedHash)
    expect(repos.outbox.listByChapter(seed.chapterIds[1]!)).toHaveLength(1)
  })
})
