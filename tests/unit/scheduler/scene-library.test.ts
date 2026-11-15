import { afterEach, describe, expect, it } from 'vitest'
import { verifyDatabase } from '../../../src/main/db/verify'
import {
  forkSceneIntoChapter,
  linkSceneToChapter,
  removeScene,
  reorderChapterScenes,
  sceneLibraryEntries,
  unlinkSceneFromChapter,
  updateSceneTime
} from '../../../src/main/scheduler/scene-library'
import { commitBeat } from '../../../src/main/doc/commit-beat'
import { loadLiveManifest } from '../../../src/main/db/revision'
import { readChapterStoryboard } from '../../../src/main/scheduler/storyboard'
import { openTestDb } from '../db/support/db'
import { seedFixture } from '../db/support/fixture'
import { tempDir } from '../helpers'

/**
 * 场景库与章↔场景多对多（PHASE-12 §5.1 / §6 验收 1–3）：
 * - 空场景可链接多章（不产生拍）；
 * - 已演出的场景链接到别的章 → 要求 fork；引用章 commitBeat 拒绝；
 * - fork 复制 scene + live 拍，原章 revision/正文不变，verify 无 scene_cross_chapter_beats；
 * - 解链/删除只在安全条件下允许。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-scene-lib-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

function codes(report: ReturnType<typeof verifyDatabase>): string[] {
  return report.issues.map((issue) => issue.code)
}

describe('场景库：规划链接与多对多', () => {
  it('空场景可以同时链接两章：不报错，也不产生拍', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const projectId = seed.projectId
    const empty = repos.scene.insert({
      projectId,
      ord: 99,
      location: '书房空镜',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '埋一个空场景',
      exitJson: JSON.stringify({ dsl: 'beats(2)' })
    })
    const [chapterA, chapterB] = seed.chapterIds

    linkSceneToChapter(db, repos, { chapterId: chapterA!, sceneId: empty.id })
    linkSceneToChapter(db, repos, { chapterId: chapterB!, sceneId: empty.id })

    const links = repos.scene.listChaptersByScene(empty.id)
    expect(links.map((link) => link.chapterId).sort()).toEqual([chapterA!, chapterB!].sort())
    expect(repos.scene.liveBeatCount(empty.id)).toBe(0)
    const report = verifyDatabase(db, { checkMirror: false })
    expect(codes(report)).not.toContain('scene_cross_chapter_beats')
    expect(report.ok).toBe(true)
  })

  it('已演出的场景链接到别的章 → invalid_args，并要求 fork', () => {
    const { handle, seed } = setup()
    const scene = seed.chapters[0]!.sceneIds[0]!
    expect(() =>
      linkSceneToChapter(handle.db, handle.repos, { chapterId: seed.chapterIds[1]!, sceneId: scene })
    ).toThrowError(/fork/)
    // 同一章重复链接是幂等的。
    linkSceneToChapter(handle.db, handle.repos, { chapterId: seed.chapterIds[0]!, sceneId: scene })
    expect(handle.repos.scene.listByChapter(seed.chapterIds[0]!).length).toBe(3)
  })

  it('链接空场景会写进本章草案；解链把它移出草案，场景仍在库里', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const empty = repos.scene.insert({
      projectId: seed.projectId,
      ord: 98,
      location: '码头',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '等船',
      exitJson: JSON.stringify({ dsl: 'beats(2)' })
    })
    const chapterId = seed.chapterIds[1]!
    linkSceneToChapter(db, repos, { chapterId, sceneId: empty.id })
    let draft = repos.storyboard.get(chapterId)
    expect(draft).not.toBeNull()
    expect(JSON.parse(draft!.scenesJson).scenes.some((scene: { scene_id?: string }) => scene.scene_id === empty.id)).toBe(true)

    unlinkSceneFromChapter(db, repos, { chapterId, sceneId: empty.id })
    draft = repos.storyboard.get(chapterId)
    // 草案里只剩这一场 → 删到 0 场回到「未分镜」，不保留空表。
    expect(draft).toBeNull()
    expect(repos.scene.get(empty.id)).not.toBeNull()
  })

  it('演出中的场景不能解链（否则拍会变成孤儿）', () => {
    const { handle, seed } = setup()
    const scene = seed.chapters[0]!.sceneIds[0]!
    expect(() =>
      unlinkSceneFromChapter(handle.db, handle.repos, { chapterId: seed.chapterIds[0]!, sceneId: scene })
    ).toThrowError(/已有拍/)
  })

  it('章内排序只改 chapter_scene.ord，不改 scene.ord；有正文时拒绝', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    // 规划期：新建一章（无拍），两场空场景链接进去，顺序可换。
    const node = repos.outline.insert({
      projectId: seed.projectId,
      parentId: null,
      kind: 'chapter',
      ord: 3,
      title: '第 3 章（未开演）',
      status: 'draft'
    })
    const chapter = repos.chapter.insert({
      projectId: seed.projectId,
      outlineNodeId: node.id,
      ord: 3,
      status: 'planned'
    })
    const chapterId = chapter.id
    const firstEmpty = repos.scene.insert({
      projectId: seed.projectId,
      ord: 90,
      location: '甲',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '甲',
      exitJson: JSON.stringify({ dsl: 'beats(1)' })
    })
    const secondEmpty = repos.scene.insert({
      projectId: seed.projectId,
      ord: 91,
      location: '乙',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '乙',
      exitJson: JSON.stringify({ dsl: 'beats(1)' })
    })
    linkSceneToChapter(db, repos, { chapterId, sceneId: secondEmpty.id })
    linkSceneToChapter(db, repos, { chapterId, sceneId: firstEmpty.id })
    expect(repos.scene.listByChapter(chapterId).map((entry) => entry.scene.id)).toEqual([
      secondEmpty.id,
      firstEmpty.id
    ])
    const sceneOrds = [firstEmpty.ord, secondEmpty.ord]

    reorderChapterScenes(db, repos, { chapterId, sceneIds: [firstEmpty.id, secondEmpty.id] })
    expect(repos.scene.listByChapter(chapterId).map((entry) => entry.scene.id)).toEqual([
      firstEmpty.id,
      secondEmpty.id
    ])
    // 场景库顺序（scene.ord）不变。
    expect([repos.scene.get(firstEmpty.id)!.ord, repos.scene.get(secondEmpty.id)!.ord]).toEqual(sceneOrds)

    expect(() =>
      reorderChapterScenes(db, repos, { chapterId, sceneIds: [firstEmpty.id] })
    ).toThrowError(/集合一致/)

    // 有正文的章（第 1 章）不允许直接改顺序：必须走分镜 + 重新开演。
    expect(() =>
      reorderChapterScenes(db, repos, {
        chapterId: seed.chapterIds[0]!,
        sceneIds: [...seed.chapters[0]!.sceneIds].reverse()
      })
    ).toThrowError(/已有正文/)
  })
})

describe('场景库：fork 与只读引用', () => {
  it('fork 复制场景与拍到新章：原章 revision/hash 不变，verify 无跨章拍', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const sourceChapter = seed.chapterIds[0]!
    const targetChapter = seed.chapterIds[1]!
    const sourceScene = seed.chapters[0]!.sceneIds[0]!
    const sourceRevisionBefore = repos.chapter.get(sourceChapter)!.currentRevisionId!
    const sourceHashBefore = repos.revision.get(sourceRevisionBefore)!.contentHash
    const targetRevisionBefore = repos.chapter.get(targetChapter)!.currentRevisionId!
    const targetBeatsBefore = repos.beat.listLiveByChapter(targetChapter).length

    const result = forkSceneIntoChapter(db, repos, { chapterId: targetChapter, sceneId: sourceScene })

    expect(result.beatCount).toBe(repos.beat.listLiveByScene(sourceScene).length)
    // 原章一字未动。
    expect(repos.chapter.get(sourceChapter)!.currentRevisionId).toBe(sourceRevisionBefore)
    expect(repos.revision.get(sourceRevisionBefore)!.contentHash).toBe(sourceHashBefore)
    // 新章：新 scene + 新拍 + 新 revision。
    const forkedScene = repos.scene.get(result.sceneId)!
    expect(forkedScene.id).not.toBe(sourceScene)
    expect(forkedScene.location).toBe(repos.scene.get(sourceScene)!.location)
    expect(repos.scene.listByChapter(targetChapter).map((entry) => entry.scene.id)).toContain(result.sceneId)
    expect(repos.beat.listLiveByChapter(targetChapter).length).toBe(targetBeatsBefore + result.beatCount)
    expect(repos.chapter.get(targetChapter)!.currentRevisionId).not.toBe(targetRevisionBefore)
    // 新拍的 live 槽位与正文与原场景一致，但 id 不同。
    const copied = repos.beat.listLiveByScene(result.sceneId)
    expect(copied.every((beat) => beat.body.trim().length > 0)).toBe(true)
    expect(copied.every((beat) => beat.status === 'waiting_for_human')).toBe(true)
    expect(copied[0]!.supersedesId).toBeNull()

    const report = verifyDatabase(db, { checkMirror: false })
    expect(codes(report)).not.toContain('scene_cross_chapter_beats')
    expect(report.ok).toBe(true)
  })

  it('引用章不能写正文：commitBeat 对别的章演出的场景返回 invalid_args', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const project = repos.project.get()!
    const targetChapter = seed.chapterIds[1]!
    const sourceScene = seed.chapters[0]!.sceneIds[0]!
    // 引用链接的真实来源：先链接空场景，另一章后来演出了它。
    // 这里直接写链接，模拟那一刻的状态（服务层此刻会拒绝新链接）。
    repos.scene.linkToChapter(targetChapter, sourceScene, 4)

    let error: unknown = null
    try {
      commitBeat(db, repos, {
        chapterId: targetChapter,
        expectedRevision: repos.chapter.get(targetChapter)!.currentRevisionId,
        epoch: project.writeEpoch,
        sceneId: sourceScene,
        ord: 9,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '不该写进来'
      })
    } catch (caught) {
      error = caught
    }
    expect(error).not.toBeNull()
    expect((error as { code?: string }).code).toBe('invalid_args')
    expect((error as Error).message).toMatch(/别\s*的章|别章|已经.*章演出/)
    // 没有写入：引用章仍然只有原来的 24 拍。
    expect(repos.beat.listLiveByChapter(targetChapter).length).toBe(24)
  })

  it('引用章的 revision 清单与 hash 不含该场拍', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const targetChapter = seed.chapterIds[1]!
    const sourceScene = seed.chapters[0]!.sceneIds[0]!
    const revisionBefore = repos.chapter.get(targetChapter)!.currentRevisionId!
    const hashBefore = repos.revision.get(revisionBefore)!.contentHash
    repos.scene.linkToChapter(targetChapter, sourceScene, 4)

    // 清单仍只含本章的拍（24 条），引用场一条都不进。
    const manifest = loadLiveManifest(db, targetChapter)
    expect(manifest).toHaveLength(24)
    expect(manifest.some((row) => row.sceneId === sourceScene)).toBe(false)
    // 分镜读取侧同样不返回别章的拍。
    const view = readChapterStoryboard(repos, targetChapter)
    const reference = view.find((entry) => entry.scene.id === sourceScene)!
    expect(reference.beats).toEqual([])
    expect(repos.chapter.get(targetChapter)!.currentRevisionId).toBe(revisionBefore)
    expect(repos.revision.get(revisionBefore)!.contentHash).toBe(hashBefore)
  })

  it('fork 之后新章可写；旧章的拍仍是唯一演出者', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const project = repos.project.get()!
    const targetChapter = seed.chapterIds[1]!
    const sourceScene = seed.chapters[0]!.sceneIds[0]!
    const forked = forkSceneIntoChapter(db, repos, { chapterId: targetChapter, sceneId: sourceScene })

    const firstBeat = repos.beat.listLiveByScene(forked.sceneId)[0]!
    const result = commitBeat(db, repos, {
      chapterId: targetChapter,
      expectedRevision: repos.chapter.get(targetChapter)!.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: forked.sceneId,
      ord: firstBeat.ord,
      speakerType: 'narrator',
      speakerId: 'narrator',
      body: '第 2 章自己的旁白。',
      supersedesId: firstBeat.id
    })
    expect(result.beatId).not.toBe(firstBeat.id)
    expect(repos.beat.get(firstBeat.id)!.status).toBe('superseded')
    // 原章同一个槽位没被动过。
    const original = repos.beat.listLiveByScene(sourceScene).find((beat) => beat.ord === firstBeat.ord)!
    expect(original.status).not.toBe('superseded')

    const report = verifyDatabase(db, { checkMirror: false })
    expect(report.ok).toBe(true)
    expect(codes(report)).not.toContain('scene_cross_chapter_beats')
  })

  it('空场景不需要 fork；已在本章演出的场景也不重复 fork', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const empty = repos.scene.insert({
      projectId: seed.projectId,
      ord: 97,
      location: '空镜',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '过渡',
      exitJson: JSON.stringify({ dsl: 'beats(1)' })
    })
    expect(() => forkSceneIntoChapter(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: empty.id })).toThrowError(
      /不需要 fork/
    )
    expect(() =>
      forkSceneIntoChapter(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: seed.chapters[0]!.sceneIds[0]! })
    ).toThrowError(/不需要 fork/)
  })
})

describe('场景库：时间三轴与删除', () => {
  it('时间字段按行读写；timeline 默认 main，旧行迁移后仍是 main', () => {
    const { handle, seed } = setup()
    const { repos } = handle
    const scene = repos.scene.get(seed.chapters[0]!.sceneIds[0]!)!
    expect(scene.timeline).toBe('main')
    expect(scene.storyStart).toBeNull()

    const updated = updateSceneTime(repos, {
      chapterId: seed.chapterIds[0]!,
      sceneId: scene.id,
      storyStart: '民国二十三年 三月初七 夜',
      storyEnd: '次日 破晓',
      timeline: 'flashback'
    })
    expect(updated.timeline).toBe('flashback')
    expect(updated.storyStart).toBe('民国二十三年 三月初七 夜')

    const cleared = updateSceneTime(repos, { chapterId: seed.chapterIds[0]!, sceneId: scene.id, storyEnd: null })
    expect(cleared.storyEnd).toBeNull()
    expect(cleared.storyStart).toBe('民国二十三年 三月初七 夜')

    expect(() =>
      updateSceneTime(repos, { chapterId: seed.chapterIds[1]!, sceneId: scene.id, timeline: 'dream' })
    ).toThrowError(/未链接到本章/)
  })

  it('删除：有 live 拍拒绝；被别的章引用拒绝；只有本章链接时可以删', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const performed = seed.chapters[0]!.sceneIds[0]!
    expect(() =>
      removeScene(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: performed })
    ).toThrowError(/已有演出拍/)

    const shared = repos.scene.insert({
      projectId: seed.projectId,
      ord: 96,
      location: '桥头',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '接头',
      exitJson: JSON.stringify({ dsl: 'beats(1)' })
    })
    linkSceneToChapter(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: shared.id })
    linkSceneToChapter(db, repos, { chapterId: seed.chapterIds[1]!, sceneId: shared.id })
    expect(() => removeScene(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: shared.id })).toThrowError(
      /仍被第 2 章引用/
    )

    unlinkSceneFromChapter(db, repos, { chapterId: seed.chapterIds[1]!, sceneId: shared.id })
    removeScene(db, repos, { chapterId: seed.chapterIds[0]!, sceneId: shared.id })
    expect(repos.scene.get(shared.id)).toBeNull()
    expect(repos.scene.listChaptersByScene(shared.id)).toEqual([])
  })

  it('场景库视图：演出章、链接章序与引用标记', () => {
    const { handle, seed } = setup()
    const { repos, db } = handle
    const empty = repos.scene.insert({
      projectId: seed.projectId,
      ord: 95,
      location: '渡口',
      participantsJson: JSON.stringify([seed.characterIds[0]]),
      goal: '等潮',
      exitJson: JSON.stringify({ dsl: 'beats(1)' })
    })
    linkSceneToChapter(db, repos, { chapterId: seed.chapterIds[1]!, sceneId: empty.id })
    const library = sceneLibraryEntries(repos, seed.projectId, seed.chapterIds[1]!)
    const row = library.find((item) => item.id === empty.id)!
    expect(row.linkedToCurrent).toBe(true)
    expect(row.ownerChapterOrd).toBeNull()
    expect(row.liveBeats).toBe(0)
    expect(row.linkedChapterOrds).toEqual([2])

    const performed = library.find((item) => item.id === seed.chapters[0]!.sceneIds[0]!)!
    expect(performed.ownerChapterOrd).toBe(1)
    expect(performed.liveBeats).toBeGreaterThan(0)
    expect(performed.ownedByCurrent).toBe(false)
  })
})
