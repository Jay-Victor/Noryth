import { afterEach, describe, expect, it } from 'vitest'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { testCommitBeat } from './support/test-writer'
import { loadLiveManifest, recomputeRevisionHash } from '../../../src/main/db/revision'
import { hashManifestRows } from '../../../src/main/db/hash'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-rev-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

describe('revision 清单', () => {
  it('基线清单覆盖 2 章 × 3 场 × 8 拍 = 24 行/章', () => {
    const { handle, seed } = setup()
    for (const chapter of seed.chapters) {
      expect(handle.repos.revision.countMembers(chapter.revisionId)).toBe(24)
      expect(loadLiveManifest(handle.db, chapter.id)).toHaveLength(24)
      expect(recomputeRevisionHash(handle.db, chapter.revisionId)).toBe(
        handle.repos.revision.get(chapter.revisionId)!.contentHash
      )
    }
  })

  it('一次拍提交：+1 行正文、+1 个 revision，清单仍是 24 行（不复制整章）', () => {
    const { handle, seed } = setup()
    const chapter = seed.chapters[0]!
    const old = handle.repos.beat.listLiveByChapter(chapter.id).find((beat) => beat.ord === 1)!
    const beatsBefore = handle.repos.beat.listByChapter(chapter.id).length
    const revisionsBefore = handle.repos.revision.listByChapter(chapter.id).length

    const result = testCommitBeat(handle.db, handle.repos, {
      chapterId: chapter.id,
      sceneId: old.sceneId,
      ord: old.ord,
      speakerType: 'narrator',
      speakerId: 'narrator',
      body: '她把茶盏推回去，摇了摇头。',
      supersedesId: old.id,
      status: 'confirmed',
      expectedRevision: chapter.revisionId
    })

    expect(handle.repos.beat.listByChapter(chapter.id)).toHaveLength(beatsBefore + 1)
    expect(handle.repos.revision.listByChapter(chapter.id)).toHaveLength(revisionsBefore + 1)
    expect(handle.repos.revision.countMembers(result.revisionId)).toBe(24)
    expect(handle.repos.beat.get(old.id)!.status).toBe('superseded')

    const live = loadLiveManifest(handle.db, chapter.id)
    expect(live).toHaveLength(24)
    expect(hashManifestRows(live)).toBe(result.contentHash)
    expect(recomputeRevisionHash(handle.db, result.revisionId)).toBe(result.contentHash)
    expect(handle.repos.revision.get(result.revisionId)!.contentHash).toBe(result.contentHash)

    const updatedChapter = handle.repos.chapter.get(chapter.id)!
    expect(updatedChapter.currentRevisionId).toBe(result.revisionId)
    expect(updatedChapter.coveredUntilSeq).toBe(result.seq)
  })

  it('final 快照清单可建、hash 可复算、成员数等于现行拍数', () => {
    const { handle, seed } = setup()
    const chapter = seed.chapters[1]!
    const manifest = loadLiveManifest(handle.db, chapter.id)
    const snapshot = handle.repos.revision.insert({
      chapterId: chapter.id,
      parentRevisionId: chapter.revisionId,
      kind: 'final',
      contentHash: hashManifestRows(manifest),
      createdBy: 'author'
    })
    handle.repos.revision.insertMembers(
      snapshot.id,
      manifest.map((member) => ({
        revisionId: snapshot.id,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )
    expect(handle.repos.revision.countMembers(snapshot.id)).toBe(24)
    expect(recomputeRevisionHash(handle.db, snapshot.id)).toBe(snapshot.contentHash)
  })

  it('expected_revision 不匹配时拒绝提交且不写任何行', () => {
    const { handle, seed } = setup()
    const chapter = seed.chapters[0]!
    const before = handle.repos.beat.listByChapter(chapter.id).length
    expect(() =>
      testCommitBeat(handle.db, handle.repos, {
        chapterId: chapter.id,
        sceneId: chapter.sceneIds[0]!,
        ord: 1,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '不该落盘',
        expectedRevision: 'rev_missing'
      })
    ).toThrowError(/revision changed/)
    expect(handle.repos.beat.listByChapter(chapter.id)).toHaveLength(before)
    expect(handle.repos.revision.listByChapter(chapter.id)).toHaveLength(1)
  })
})
