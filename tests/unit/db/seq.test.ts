import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { allocateSeq, readSeqHead, recomputeCoveredUntilSeq } from '../../../src/main/db/seq'
import { withTransaction } from '../../../src/main/db/tx'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-seq-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed }
}

describe('seq 分配', () => {
  it('不在写事务内分配会失败', () => {
    const { handle, seed } = setup()
    try {
      allocateSeq(handle.db, seed.projectId)
      throw new Error('expected allocateSeq to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('internal_error')
    }
  })

  it('同一事务内连续分配单调 +1，并写回 seq_head', () => {
    const { handle, seed } = setup()
    const allocated = withTransaction(handle.db, () => [
      allocateSeq(handle.db, seed.projectId),
      allocateSeq(handle.db, seed.projectId),
      allocateSeq(handle.db, seed.projectId)
    ])
    expect(allocated[1]).toBe(allocated[0]! + 1)
    expect(allocated[2]).toBe(allocated[1]! + 1)
    expect(readSeqHead(handle.db, seed.projectId)).toBe(allocated[2])
  })

  it('covered_until_seq 只取 confirmed/author_edited 的最大 seq', () => {
    const { handle, seed } = setup()
    const chapter = seed.chapters[0]!
    const live = handle.repos.beat.listLiveByChapter(chapter.id)
    const first = live[0]!
    const later = live[live.length - 1]!
    expect(recomputeCoveredUntilSeq(handle.db, chapter.id)).toBe(0)

    handle.repos.beat.setStatus(first.id, 'confirmed', 'author')
    expect(recomputeCoveredUntilSeq(handle.db, chapter.id)).toBe(first.seq)
    handle.repos.beat.setStatus(later.id, 'author_edited', 'author')
    expect(recomputeCoveredUntilSeq(handle.db, chapter.id)).toBe(later.seq)
    expect(handle.repos.chapter.get(chapter.id)!.coveredUntilSeq).toBe(later.seq)
  })

  it('记忆 learned_seq 使用来源拍 seq，不重新分配', () => {
    const { handle, seed } = setup()
    const chapter = seed.chapters[0]!
    const before = readSeqHead(handle.db, seed.projectId)
    const source = handle.repos.beat.listLiveByChapter(chapter.id)[0]!
    const memory = handle.repos.memory.insert({
      projectId: seed.projectId,
      characterId: seed.characterIds[0]!,
      kind: 'fact',
      text: '她记得供桌下有一只匣子',
      learnedSeq: source.seq!,
      sourceChapterId: chapter.id,
      sourceRevisionId: chapter.revisionId,
      sourceBeatId: source.id,
      embeddingModel: 'bge-small-zh-v1.5'
    })
    expect(memory.learnedSeq).toBe(source.seq)
    expect(readSeqHead(handle.db, seed.projectId)).toBe(before)
  })
})
