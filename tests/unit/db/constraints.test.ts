import { afterEach, describe, expect, it } from 'vitest'
import { openTestDb, type TestDb } from './support/db'
import { seedFixture, type SeedResult } from './support/fixture'
import { tempDir } from '../helpers'
import type { Repos } from '../../../src/main/db/repos'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface Context {
  handle: TestDb
  repos: Repos
  seed: SeedResult
  dir: string
}

function setup(): Context {
  const dir = tempDir('noryth-c-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, repos: handle.repos, seed, dir: dir.path }
}

function beat(repos: Repos, seed: SeedResult, overrides: Partial<Parameters<Repos['beat']['insert']>[0]> = {}) {
  return repos.beat.insert({
    chapterId: seed.chapterIds[0]!,
    sceneId: seed.chapters[0]!.sceneIds[0]!,
    ord: 99,
    speakerType: 'narrator',
    speakerId: 'narrator',
    body: '约束测试',
    status: 'draft',
    createdRevisionId: seed.chapters[0]!.revisionId,
    ...overrides
  })
}

describe('C1 章内场景顺序唯一', () => {
  it('同章同 ord 的第二条关联失败；换 ord 通过', () => {
    const { repos, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const otherScene = seed.chapters[1]!.sceneIds[0]!
    expect(() => repos.scene.linkToChapter(chapterId, otherScene, 1)).toThrowError(/UNIQUE constraint failed/)
    expect(() => repos.scene.linkToChapter(chapterId, otherScene, 4)).not.toThrow()
  })
})

describe('C2 一拍只有一个现行版本', () => {
  it('同场景同 ord 的第二个非 superseded 拍失败；旧拍 superseded 后通过', () => {
    const { repos, seed } = setup()
    const sceneId = seed.chapters[0]!.sceneIds[0]!
    const live = repos.beat.listLiveByScene(sceneId)[0]!
    expect(() => beat(repos, seed, { ord: live.ord })).toThrowError(/UNIQUE constraint failed/)
    repos.beat.markSuperseded(live.id)
    expect(() =>
      beat(repos, seed, { ord: live.ord, supersedesId: live.id })
    ).not.toThrow()
  })
})

describe('C3 一拍只能被替换一次', () => {
  it('同一旧拍被两条新拍 supersede 失败；只被替换一次通过', () => {
    const { repos, seed } = setup()
    const old = repos.beat.listLiveByScene(seed.chapters[0]!.sceneIds[0]!)[0]!
    expect(() => beat(repos, seed, { ord: 90, supersedesId: old.id })).not.toThrow()
    expect(() => beat(repos, seed, { ord: 91, supersedesId: old.id })).toThrowError(/UNIQUE constraint failed/)
  })
})

describe('C4 单值槽同时只有一个有效事实', () => {
  it('同 subject+predicate 的第二条 objective 单值事实失败；关闭有效期后通过', () => {
    const { repos, seed } = setup()
    const projectId = seed.projectId
    const first = repos.world.insert({
      projectId,
      subject: '林砚',
      predicate: '居住地',
      object: '上海',
      truth: 'objective',
      visibility: 'public',
      validFromSeq: 1,
      sourceType: 'author'
    })
    expect(() =>
      repos.world.insert({
        projectId,
        subject: '林砚',
        predicate: '居住地',
        object: '北京',
        truth: 'objective',
        visibility: 'public',
        validFromSeq: 2,
        sourceType: 'author'
      })
    ).toThrowError(/UNIQUE constraint failed/)
    repos.world.closeValidity(first.id, 2)
    expect(() =>
      repos.world.insert({
        projectId,
        subject: '林砚',
        predicate: '居住地',
        object: '北京',
        truth: 'objective',
        visibility: 'public',
        validFromSeq: 2,
        sourceType: 'author'
      })
    ).not.toThrow()
  })
})

describe('C5 关系边每轴一条有效边', () => {
  it('同 from+to+axis 的第二条有效边失败；关闭上一条后通过', () => {
    const { repos, seed } = setup()
    const first = repos.relationship.insert({
      projectId: seed.projectId,
      fromId: seed.characterIds[0]!,
      toId: seed.characterIds[1]!,
      axis: 'trust',
      value: 0.4,
      sinceSeq: 1,
      sourceType: 'author'
    })
    expect(() =>
      repos.relationship.insert({
        projectId: seed.projectId,
        fromId: seed.characterIds[0]!,
        toId: seed.characterIds[1]!,
        axis: 'trust',
        value: 0.6,
        sinceSeq: 2,
        sourceType: 'author'
      })
    ).toThrowError(/UNIQUE constraint failed/)
    repos.relationship.closeValidity(first.id, 2)
    expect(() =>
      repos.relationship.insert({
        projectId: seed.projectId,
        fromId: seed.characterIds[0]!,
        toId: seed.characterIds[1]!,
        axis: 'trust',
        value: 0.6,
        sinceSeq: 2,
        sourceType: 'author'
      })
    ).not.toThrow()
  })
})

describe('C6 记忆条目只被取代一次', () => {
  it('两条新记忆指向同一旧记忆失败；一条通过', () => {
    const { repos, seed } = setup()
    const chapter = seed.chapters[0]!
    const old = repos.memory.insert({
      projectId: seed.projectId,
      characterId: seed.characterIds[0]!,
      kind: 'fact',
      text: '父亲的书房里有一只黑漆匣子',
      learnedSeq: 1,
      sourceChapterId: chapter.id,
      sourceRevisionId: chapter.revisionId,
      embeddingModel: 'bge-small-zh-v1.5'
    })
    expect(() =>
      repos.memory.insert({
        projectId: seed.projectId,
        characterId: seed.characterIds[0]!,
        kind: 'fact',
        text: '黑漆匣子在祠堂供桌下',
        learnedSeq: 2,
        sourceChapterId: chapter.id,
        sourceRevisionId: chapter.revisionId,
        supersedesId: old.id,
        embeddingModel: 'bge-small-zh-v1.5'
      })
    ).not.toThrow()
    expect(() =>
      repos.memory.insert({
        projectId: seed.projectId,
        characterId: seed.characterIds[0]!,
        kind: 'fact',
        text: '黑漆匣子被穆掌柜拿走了',
        learnedSeq: 3,
        sourceChapterId: chapter.id,
        sourceRevisionId: chapter.revisionId,
        supersedesId: old.id,
        embeddingModel: 'bge-small-zh-v1.5'
      })
    ).toThrowError(/UNIQUE constraint failed/)
  })
})

describe('C7 任务幂等键唯一', () => {
  it('同项目同 idempotency_key 失败；不同 key 通过', () => {
    const { repos, seed } = setup()
    repos.job.insert({
      projectId: seed.projectId,
      type: 'beat.generate',
      epoch: 0,
      idempotencyKey: 'job-key-1',
      payloadJson: '{}'
    })
    expect(() =>
      repos.job.insert({
        projectId: seed.projectId,
        type: 'beat.generate',
        epoch: 0,
        idempotencyKey: 'job-key-1',
        payloadJson: '{}'
      })
    ).toThrowError(/UNIQUE constraint failed/)
    expect(() =>
      repos.job.insert({
        projectId: seed.projectId,
        type: 'beat.generate',
        epoch: 0,
        idempotencyKey: 'job-key-2',
        payloadJson: '{}'
      })
    ).not.toThrow()
  })
})

describe('C8 工具幂等键唯一', () => {
  it('同项目同 idempotency_key 失败；NULL key 可重复', () => {
    const { repos, seed } = setup()
    const base = {
      projectId: seed.projectId,
      jobId: 'job_x',
      turnId: 'turn_x',
      tool: 'memory.search',
      toolVersion: '1',
      actorId: 'actor_x',
      scopeJson: '{}',
      argsHash: 'a'.repeat(64),
      status: 'ok' as const,
      latencyMs: 12,
      idempotencyKey: 'tool-key-1'
    }
    repos.toolCall.insert(base)
    expect(() => repos.toolCall.insert(base)).toThrowError(/UNIQUE constraint failed/)
    expect(() => repos.toolCall.insert({ ...base, idempotencyKey: null })).not.toThrow()
    expect(() => repos.toolCall.insert({ ...base, idempotencyKey: null })).not.toThrow()
  })
})

describe('C9 闸门令牌唯一且只能消费一次', () => {
  it('同 token_hash 第二次插入失败；消费一次成功，第二次返回 null', () => {
    const { repos, seed } = setup()
    const gate = repos.gate.insert({
      projectId: seed.projectId,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: seed.chapterIds[0]!,
      decision: 'approve',
      actor: 'author',
      tokenHash: 'token-abc'
    })
    expect(() =>
      repos.gate.insert({
        projectId: seed.projectId,
        gateId: 'G6',
        entityType: 'chapter',
        entityId: seed.chapterIds[0]!,
        decision: 'approve',
        actor: 'author',
        tokenHash: 'token-abc'
      })
    ).toThrowError(/UNIQUE constraint failed/)

    const consumed = repos.gate.consumeToken('token-abc')
    expect(consumed?.id).toBe(gate.id)
    expect(consumed?.consumedAt).not.toBeNull()
    expect(repos.gate.consumeToken('token-abc')).toBeNull()

    expect(() =>
      repos.gate.insert({
        projectId: seed.projectId,
        gateId: 'G6',
        entityType: 'chapter',
        entityId: seed.chapterIds[0]!,
        decision: 'approve',
        actor: 'author',
        tokenHash: null
      })
    ).not.toThrow()
    expect(() =>
      repos.gate.insert({
        projectId: seed.projectId,
        gateId: 'G6',
        entityType: 'chapter',
        entityId: seed.chapterIds[0]!,
        decision: 'approve',
        actor: 'author',
        tokenHash: null
      })
    ).not.toThrow()
  })
})
