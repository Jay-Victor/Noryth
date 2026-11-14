import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { OutboxPublisher } from '../../../src/main/db/outbox'
import { assertMirrorUnchanged, inspectMirror, renderChapterMarkdown } from '../../../src/main/doc/mirror'
import { hashText } from '../../../src/main/db/hash'
import type { OutboxRecord } from '../../../src/main/db/repos/outbox'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { testCommitBeat } from './support/test-writer'
import { publishOutbox } from './support/outbox'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-outbox-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

function commitOne(handle: ReturnType<typeof setup>['handle'], seed: ReturnType<typeof setup>['seed']) {
  const chapter = seed.chapters[0]!
  const old = handle.repos.beat.listLiveByChapter(chapter.id).find((beat) => beat.ord === 1)!
  return testCommitBeat(handle.db, handle.repos, {
    chapterId: chapter.id,
    sceneId: old.sceneId,
    ord: old.ord,
    speakerType: 'narrator',
    speakerId: 'narrator',
    body: '新写的一拍：灯芯爆了一下。',
    supersedesId: old.id
  })
}

describe('outbox 与 Markdown 镜像', () => {
  it('提交后发布：文件含 frontmatter 与新正文，outbox 标记 published', () => {
    const { handle, seed, dir } = setup()
    const result = commitOne(handle, seed)
    const report = publishOutbox(handle.db, dir)
    expect(report.published.length).toBe(1)
    expect(report.conflicts).toHaveLength(0)

    const file = join(dir, 'manuscript', 'ch-001.md')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('chapter_id: ch_001')
    expect(content).toContain(`revision: ${result.revisionId}`)
    expect(content).toContain('新写的一拍：灯芯爆了一下。')

    const row = handle.repos.outbox.get(report.published[0]!)
    expect(row?.publishedAt).not.toBeNull()
    expect(row?.attempts).toBe(0)
    expect(inspectMirror(handle.db, dir, seed.chapterIds[0]!).conflicted).toBe(false)
  })

  it('进程被杀后重试：未发布行由新 publisher 继续，hash 相同则跳过', () => {
    const { handle, seed, dir } = setup()
    commitOne(handle, seed)
    const pending = handle.repos.outbox.listPending(seed.projectId, new Date().toISOString())
    expect(pending).toHaveLength(1)

    // 模拟“重启”：旧实例没有发布，新实例从 published_at IS NULL 继续。
    const first = publishOutbox(handle.db, dir)
    expect(first.published).toHaveLength(1)

    // 再入队一份完全相同的行：磁盘 hash 已等于 expected，跳过写入。
    const row = handle.repos.outbox.get(first.published[0]!)!
    const duplicate = handle.repos.outbox.enqueue({
      projectId: seed.projectId,
      chapterId: row.chapterId!,
      revisionId: row.revisionId!,
      path: row.path,
      expectedHash: row.expectedHash
    })
    const second = publishOutbox(handle.db, dir)
    expect(second.published).toHaveLength(0)
    expect(second.skipped).toContain(duplicate.id)
  })

  it('外部改动 manuscript/ch-001.md → file_conflict，不覆盖磁盘也不改 DB', () => {
    const { handle, seed, dir } = setup()
    const file = join(dir, 'manuscript', 'ch-001.md')
    writeFileSync(file, '外部编辑器写入的正文\n', 'utf8')

    let thrown: unknown
    try {
      assertMirrorUnchanged(handle.db, dir, seed.chapterIds[0]!)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('file_conflict')
    expect(readFileSync(file, 'utf8')).toBe('外部编辑器写入的正文\n')

    const result = commitOne(handle, seed)
    const report = publishOutbox(handle.db, dir)
    expect(report.conflicts).toHaveLength(1)
    expect(report.published).toHaveLength(0)
    expect(readFileSync(file, 'utf8')).toBe('外部编辑器写入的正文\n')

    const pendingRow = handle.repos.outbox.listByChapter(seed.chapterIds[0]!).at(-1)!
    expect(pendingRow.revisionId).toBe(result.revisionId)
    expect(pendingRow.lastError).toBe('file_conflict')
    expect(pendingRow.attempts).toBe(1)
    expect(pendingRow.publishedAt).toBeNull()
  })

  it('更晚的 revision 已发布时，旧行只出队不回退镜像', () => {
    const { handle, seed, dir } = setup()
    const file = join(dir, 'manuscript', 'ch-001.md')
    const chapter = seed.chapters[0]!
    const oldRevisionId = chapter.revisionId

    // 先提交并发布新 revision。
    const result = commitOne(handle, seed)
    expect(publishOutbox(handle.db, dir).published).toHaveLength(1)
    const latestContent = readFileSync(file, 'utf8')
    expect(latestContent).toContain('新写的一拍：灯芯爆了一下。')

    // 再入队一条「旧 revision、更早 created_at」的待发布行（模拟退避后迟到的重试）。
    const oldContent = renderChapterMarkdown(handle.db, { chapterId: chapter.id, revisionId: oldRevisionId })
    const stale = handle.repos.outbox.enqueue({
      projectId: seed.projectId,
      chapterId: chapter.id,
      revisionId: oldRevisionId,
      path: 'manuscript/ch-001.md',
      expectedHash: hashText(oldContent),
      createdAt: '2020-01-01T00:00:00.000Z'
    })
    const report = publishOutbox(handle.db, dir)
    expect(report.skipped).toContain(stale.id)
    expect(report.published).toHaveLength(0)
    expect(readFileSync(file, 'utf8')).toBe(latestContent)
    expect(handle.repos.outbox.get(stale.id)!.publishedAt).not.toBeNull()
    expect(result.revisionId).not.toBe(oldRevisionId)
  })

  it('渲染失败按指数退避重试，未到时间不重试', () => {
    const { handle, seed, dir } = setup()
    commitOne(handle, seed)
    let clock = Date.parse('2026-11-14T10:00:00.000Z')
    const now = () => new Date(clock).toISOString()
    const failing = new OutboxPublisher({
      db: handle.db,
      projectDir: dir,
      now,
      backoffMs: () => 1000,
      render: () => {
        throw new Error('boom')
      }
    })
    const first = failing.publishPending()
    expect(first.failed).toHaveLength(1)
    const row = handle.repos.outbox.get(first.failed[0]!.id)!
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt).toBe(new Date(clock + 1000).toISOString())

    const working = new OutboxPublisher({
      db: handle.db,
      projectDir: dir,
      now,
      backoffMs: () => 1000,
      render: (item: OutboxRecord) =>
        renderChapterMarkdown(handle.db, { chapterId: item.chapterId!, revisionId: item.revisionId! })
    })
    expect(working.publishPending().published).toHaveLength(0)

    clock += 2000
    const retried = working.publishPending()
    expect(retried.published).toHaveLength(1)
    expect(handle.repos.outbox.get(row.id)!.attempts).toBe(1)
  })
})
