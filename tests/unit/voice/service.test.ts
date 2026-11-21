import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashManifestRows } from '../../../src/main/db/hash'
import type { ManifestBeatRow } from '../../../src/main/db/revision'
import { openTestDb, closeTestDb, type TestDb } from '../db/support/db'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import {
  computeSceneVoice,
  currentRevisionIdOf,
  resolveSceneVoice,
  syncChapterVoice
} from '../../../src/main/voice/service'
import { VOICE_THRESHOLD } from '../../../src/shared/domain/voice'

/** PHASE-19 §5.4：按 scene + revision 持久化、stale 判定、空场景不伪造 0 分。 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface VoiceWorld extends TestDb {
  projectId: string
  chapterId: string
  sceneId: string
  revisionA: string
}

function buildWorld(): VoiceWorld {
  const dir = mkdtempSync(join(tmpdir(), 'noryth-voice-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const handle = openTestDb(dir)
  cleanups.push(() => closeTestDb(handle))
  const { repos } = handle

  const project = repos.project.create({
    id: 'prj_voice',
    title: '声音测试',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 100000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  repos.character.insert({
    id: 'chr_short',
    projectId: project.id,
    name: '沈昼',
    cardJson: JSON.stringify({ voice: { catchphrase: '罢了' } })
  })
  repos.character.insert({
    id: 'chr_long',
    projectId: project.id,
    name: '林晚',
    cardJson: JSON.stringify({ voice: { catchphrase: '你知道的' } })
  })

  const main = repos.outline.insert({
    id: 'out_main',
    projectId: project.id,
    parentId: null,
    kind: 'main',
    ord: 0,
    title: '主线',
    content: '',
    status: 'approved'
  })
  const node = repos.outline.insert({
    id: 'out_ch',
    projectId: project.id,
    parentId: main.id,
    kind: 'chapter',
    ord: 1,
    title: '第一章',
    content: '测试一章。',
    status: 'draft'
  })
  repos.chapter.insert({
    id: 'ch_1',
    projectId: project.id,
    outlineNodeId: node.id,
    ord: 1,
    status: 'drafting',
    coveredUntilSeq: 0,
    currentRevisionId: null
  })
  repos.scene.insert({
    id: 'scn_1',
    projectId: project.id,
    ord: 1,
    location: '祠堂',
    participantsJson: JSON.stringify(['chr_short', 'chr_long']),
    goal: '对质',
    exitJson: '{}',
    status: 'open'
  })
  repos.scene.linkToChapter('ch_1', 'scn_1', 1)

  const rows: ManifestBeatRow[] = [
    {
      beatId: 'bt_1',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 1,
      speakerType: 'character',
      speakerId: 'chr_short',
      body: '灯灭了。雨停了。门没锁。罢了，先回去。'
    },
    {
      beatId: 'bt_2',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 2,
      speakerType: 'character',
      speakerId: 'chr_long',
      body: '我一直在想，父亲把那只黑漆匣子藏在祠堂，究竟是在躲谁？'
    },
    {
      beatId: 'bt_3',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 3,
      speakerType: 'character',
      speakerId: 'chr_short',
      body: '灰上有脚印。有人来过。'
    },
    {
      beatId: 'bt_4',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 4,
      speakerType: 'character',
      speakerId: 'chr_long',
      body: '你有没有想过，那天夜里他为什么不肯点灯，也不肯说话？'
    }
  ]
  repos.revision.insert({
    id: 'rev_a',
    chapterId: 'ch_1',
    parentRevisionId: null,
    kind: 'draft',
    contentHash: hashManifestRows(rows),
    createdBy: 'author'
  })
  rows.forEach((row, index) => {
    repos.beat.insert({
      id: row.beatId,
      chapterId: 'ch_1',
      sceneId: 'scn_1',
      ord: index + 1,
      seq: index + 1,
      speakerType: 'character',
      speakerId: row.speakerId,
      body: row.body,
      status: 'draft',
      createdRevisionId: 'rev_a'
    })
  })
  repos.revision.insertMembers(
    'rev_a',
    rows.map((row) => ({
      revisionId: 'rev_a',
      beatId: row.beatId,
      sceneOrd: row.sceneOrd,
      beatOrd: row.beatOrd
    }))
  )
  repos.chapter.setCurrentRevision('ch_1', 'rev_a')

  return { ...handle, projectId: project.id, chapterId: 'ch_1', sceneId: 'scn_1', revisionA: 'rev_a' }
}

describe('voice/service', () => {
  it('计算不落库：逐角色 + 两两，角色按 id 排序', () => {
    const world = buildWorld()
    const computed = computeSceneVoice(world.repos, 'scn_1')
    expect(computed.chapterId).toBe('ch_1')
    expect(computed.revisionId).toBe('rev_a')
    expect(computed.metrics.insufficientData).toBe(false)
    expect(computed.metrics.characters.map((item) => item.characterId)).toEqual(['chr_long', 'chr_short'])
    expect(computed.metrics.pairs).toHaveLength(1)
    expect(computed.metrics.pairs[0]!.score).toBe(computed.metrics.aggregate.pairwiseDistinctness)
    expect(computed.metrics.threshold.version).toBe(VOICE_THRESHOLD.version)
    expect(world.repos.voice.listByChapter(world.projectId, world.chapterId)).toHaveLength(0)
  })

  it('resolve persist 只留一行；同 revision 再读命中缓存', () => {
    const world = buildWorld()
    const first = resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    expect(first.found).toBe(true)
    expect(first.stale).toBe(false)
    expect(first.belowThreshold).toBe(
      first.aggregate.pairwiseDistinctness < first.threshold.distinctnessMin
    )
    const rows = world.repos.voice.listByChapter(world.projectId, world.chapterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.thresholdVersion).toBe(VOICE_THRESHOLD.version)

    const second = resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    expect(second).toEqual(first)
    expect(world.repos.voice.listByChapter(world.projectId, world.chapterId)).toHaveLength(1)
  })

  it('revision 变化后标 stale 并按新稿重算（同一场景两行）', () => {
    const world = buildWorld()
    resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    const before = world.repos.voice.getBySceneRevision('scn_1', 'rev_a')!

    const nextRows: ManifestBeatRow[] = [
      {
        beatId: 'bt_5',
        sceneId: 'scn_1',
        sceneOrd: 1,
        beatOrd: 1,
        speakerType: 'character',
        speakerId: 'chr_short',
        body: '灯灭了。雨停了。门没锁。罢了，先回去。'
      },
      {
        beatId: 'bt_6',
        sceneId: 'scn_1',
        sceneOrd: 1,
        beatOrd: 2,
        speakerType: 'character',
        speakerId: 'chr_long',
        body: '我一直在想，父亲把那只黑漆匣子藏在祠堂，究竟是在躲谁？'
      }
    ]
    world.repos.revision.insert({
      id: 'rev_b',
      chapterId: 'ch_1',
      parentRevisionId: 'rev_a',
      kind: 'draft',
      contentHash: hashManifestRows(nextRows),
      createdBy: 'author'
    })
    // 旧稿的拍先 supersede，才能在同一槽位插入新拍（beat_ord_live 是部分唯一索引）。
    for (const beatId of ['bt_1', 'bt_2', 'bt_3', 'bt_4']) {
      world.repos.beat.setStatus(beatId, 'superseded')
    }
    nextRows.forEach((row, index) => {
      world.repos.beat.insert({
        id: row.beatId,
        chapterId: 'ch_1',
        sceneId: 'scn_1',
        ord: index + 1,
        seq: index + 10,
        speakerType: 'character',
        speakerId: row.speakerId,
        body: row.body,
        status: 'draft',
        createdRevisionId: 'rev_b'
      })
    })
    world.repos.revision.insertMembers(
      'rev_b',
      nextRows.map((row) => ({
        revisionId: 'rev_b',
        beatId: row.beatId,
        sceneOrd: row.sceneOrd,
        beatOrd: row.beatOrd
      }))
    )
    // 旧 revision 的拍要被新稿取代，否则 ownerChapter 仍找到旧章没关系；
    // 清单只读 rev_b，所以指标会按新稿重算。
    world.repos.chapter.setCurrentRevision('ch_1', 'rev_b')

    const next = resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    expect(next.stale).toBe(true)
    expect(next.revisionId).toBe('rev_b')
    expect(next.found).toBe(true)
    expect(world.repos.voice.listByChapter(world.projectId, world.chapterId)).toHaveLength(2)
    expect(world.repos.voice.getBySceneRevision('scn_1', 'rev_a')!.metricsJson).toBe(before.metricsJson)
  })

  it('阈值版本变化会重算同一行（不追加历史）', () => {
    const world = buildWorld()
    resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    world.db.prepare("UPDATE voice_metric SET threshold_version = 'old'").run()
    const next = resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: true })
    expect(next.stale).toBe(true)
    const rows = world.repos.voice.listByChapter(world.projectId, world.chapterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.thresholdVersion).toBe(VOICE_THRESHOLD.version)
  })

  it('persist=false 不写库；空场景 found=false 且不伪造 0 分', () => {
    const world = buildWorld()
    resolveSceneVoice(world.repos, { sceneId: 'scn_1' }, { persist: false })
    expect(world.repos.voice.listByChapter(world.projectId, world.chapterId)).toHaveLength(0)

    world.repos.scene.insert({
      id: 'scn_empty',
      projectId: world.projectId,
      ord: 2,
      location: '空场',
      participantsJson: '[]',
      goal: '',
      exitJson: '{}',
      status: 'planned'
    })
    const empty = resolveSceneVoice(world.repos, { sceneId: 'scn_empty' }, { persist: true })
    expect(empty.found).toBe(false)
    expect(empty.insufficientData).toBe(true)
    expect(empty.chapterId).toBeNull()
    expect(empty.revisionId).toBeNull()
    expect(empty.pairs).toEqual([])
  })

  it('缺场景 invalid_args；sync 失败不影响调用方', () => {
    const world = buildWorld()
    expect(() => computeSceneVoice(world.repos, 'scn_missing')).toThrow(/场景不存在/)
    expect(() => syncChapterVoice(world.repos, 'ch_missing', { persist: true })).not.toThrow()
  })

  it('currentRevisionIdOf：定稿章读 final，其余读 current', () => {
    const world = buildWorld()
    expect(currentRevisionIdOf(world.repos, 'ch_1')).toBe('rev_a')
    world.repos.chapter.setStatus(world.chapterId, 'finalized')
    world.repos.chapter.setFinalRevision(world.chapterId, 'rev_a')
    expect(currentRevisionIdOf(world.repos, 'ch_1')).toBe('rev_a')
  })
})
