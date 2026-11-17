import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { exportManuscript } from '../../../src/main/doc/export'
import { openTestDb } from '../db/support/db'
import { seedFixture } from '../db/support/fixture'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function titleOf(handle: ReturnType<typeof openTestDb>, chapterId: string): string {
  const chapter = handle.repos.chapter.get(chapterId)!
  return handle.repos.outline.get(chapter.outlineNodeId)?.title ?? ''
}

function setup() {
  const dir = tempDir('noryth-export-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { dir: dir.path, handle, seed }
}

describe('导出（PRD §5.5 / J2 第 13 步）', () => {
  it('Markdown 带 revision 与 content_hash，正文来自 revision 清单', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const before = handle.repos.revision.listByChapter(chapterId).length
    const result = await exportManuscript(handle.repos, dir, { chapterId, format: 'md', includeNotes: false })
    const content = readFileSync(result.path, 'utf8')

    expect(result.path.endsWith('.md')).toBe(true)
    expect(result.chapters).toBe(1)
    expect(result.words).toBeGreaterThan(0)
    expect(content).toContain(`<!-- revision: ${result.revisionIds[0]}`)
    const latest = handle.repos.revision.listByChapter(chapterId).at(-1)!
    expect(content).toContain(`content_hash: ${latest.contentHash}`)
    expect(content).toContain(titleOf(handle, chapterId))

    // 导出是只读：不新增 revision
    expect(handle.repos.revision.listByChapter(chapterId)).toHaveLength(before)
    expect(result.bytes).toBe(Buffer.byteLength(content, 'utf8'))
  })

  it('「仅正文」不带批注；「正文 + 批注」附最近一份报告的建议', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const revision = handle.repos.revision.listByChapter(chapterId).at(-1)!
    handle.repos.review.insertReport({
      projectId: seed.projectId,
      chapterId,
      revisionId: revision.id,
      round: 1,
      verdict: 'fail',
      blockingJson: JSON.stringify([
        { issue_id: 'is_1', type: 'timeline_error', beat_id: 'bt_001', evidence: '雨夜', why: '时间线冲突', suggestion: '改天光' }
      ])
    })

    const plain = await exportManuscript(handle.repos, dir, { chapterId, format: 'md', includeNotes: false })
    expect(readFileSync(plain.path, 'utf8')).not.toContain('批注')

    const annotated = await exportManuscript(handle.repos, dir, { chapterId, format: 'md', includeNotes: true })
    const content = readFileSync(annotated.path, 'utf8')
    expect(content).toContain('### 批注')
    expect(content).toContain('时间线冲突')
  })

  it('TXT 不带 Markdown 标记；整本导出包含所有章', async () => {
    const { dir, handle, seed } = setup()
    const result = await exportManuscript(handle.repos, dir, { format: 'txt', includeNotes: false })
    const content = readFileSync(result.path, 'utf8')
    expect(result.chapters).toBe(seed.chapterIds.length)
    expect(result.revisionIds).toHaveLength(seed.chapterIds.length)
    expect(content.startsWith('#')).toBe(false)
    expect(content).not.toContain('<!--')
    for (const chapterId of seed.chapterIds) expect(content).toContain(titleOf(handle, chapterId))
  })

  it('没有章节时拒绝导出', async () => {
    const dir = tempDir('noryth-export-empty-')
    cleanups.push(dir.cleanup)
    const handle = openTestDb(dir.path)
    cleanups.push(() => handle.db.close())
    handle.repos.project.create({
      title: '空项目',
      genre: '',
      pov: 'first',
      targetWords: null,
      embeddingModel: 'hash-bigram-v1',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: 7
    })
    await expect(exportManuscript(handle.repos, dir.path, { format: 'md', includeNotes: false })).rejects.toThrow()
    await expect(
      exportManuscript(handle.repos, dir.path, { format: 'docx', scope: 'chapter', includeNotes: false })
    ).rejects.toThrow()
  })
})
