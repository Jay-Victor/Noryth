import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import { hashFile } from '../db/hash'
import { OutboxRepo } from '../db/repos/outbox'
import { ChapterRepo } from '../db/repos/chapter'

export interface RenderChapterInput {
  chapterId: string
  revisionId: string
}

/** Markdown 镜像文件名固定为 manuscript/ch-001.md（DEV-PLAN §5.1）。 */
export function chapterMirrorRelPath(chapterOrd: number): string {
  return `manuscript/ch-${String(chapterOrd).padStart(3, '0')}.md`
}

/**
 * 渲染一章的 Markdown 镜像（DEV-PLAN §5.8）。
 * frontmatter 不含 hash，避免自指；正文只来自 revision_beat 清单，按场景/拍序拼。
 * 标题用 JSON 字符串形式，保证任何中文标点都能作为 YAML 标量解析。
 */
export function renderChapterMarkdown(db: Db, input: RenderChapterInput): string {
  const chapter = db
    .prepare(
      `SELECT c.id AS id, c.ord AS ord, o.title AS title
       FROM chapter c JOIN outline_node o ON o.id = c.outline_node_id
       WHERE c.id = ?`
    )
    .get(input.chapterId) as { id: string; ord: number; title: string } | undefined
  if (!chapter) {
    throw new AppError('internal_error', `chapter ${input.chapterId} not found for mirror render`)
  }
  const revision = db
    .prepare('SELECT id, chapter_id FROM revision WHERE id = ?')
    .get(input.revisionId) as { id: string; chapter_id: string } | undefined
  if (!revision || revision.chapter_id !== chapter.id) {
    throw new AppError('internal_error', `revision ${input.revisionId} does not belong to chapter`)
  }
  const bodies = db
    .prepare(
      `SELECT b.body AS body
       FROM revision_beat rb JOIN beat b ON b.id = rb.beat_id
       WHERE rb.revision_id = ?
       ORDER BY rb.scene_ord, rb.beat_ord`
    )
    .all(input.revisionId) as Array<{ body: string }>

  const frontmatter = [
    '---',
    `chapter_id: ${chapter.id}`,
    `revision: ${revision.id}`,
    `title: ${JSON.stringify(chapter.title)}`,
    '---'
  ].join('\n')

  const prose = bodies
    .map((row) => row.body.replace(/\r\n/g, '\n').trimEnd())
    .filter((body) => body.length > 0)
    .join('\n\n')

  return `${frontmatter}\n\n${prose}${prose.length > 0 ? '\n' : ''}`
}

/**
 * 原子发布：临时文件 → fsync → rename。
 * 任何一步失败都不会留下半写的目标文件；临时文件由下次发布覆盖。
 */
export function writeMirrorAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export interface MirrorState {
  chapterId: string
  path: string
  exists: boolean
  expectedHash: string | null
  diskHash: string | null
  size: number | null
  mtimeMs: number | null
  /** true = 磁盘内容既不是当前 revision，也不是上一份已发布内容（外部改动）。 */
  conflicted: boolean
  pending: boolean
}

/**
 * 打开/切章/保存前的镜像检查。
 * hash 覆盖 mtime + size：内容没变 hash 不会变；内容变了 hash 必变。
 * 不在这里改 DB，也不覆盖文件——调用方负责冻结该章写入并让作者选择。
 */
export function inspectMirror(db: Db, projectDir: string, chapterId: string): MirrorState {
  const chapter = new ChapterRepo(db).get(chapterId)
  const latest = new OutboxRepo(db).latestForChapter(chapterId)
  const path = latest?.path ?? (chapter ? chapterMirrorRelPath(chapter.ord) : '')
  const absolute = join(projectDir, path)
  const expectedHash = latest?.expectedHash ?? null
  const pending = latest ? latest.publishedAt === null : false

  if (!existsSync(absolute)) {
    return {
      chapterId,
      path,
      exists: false,
      expectedHash,
      diskHash: null,
      size: null,
      mtimeMs: null,
      conflicted: false,
      pending
    }
  }
  const stat = statSync(absolute)
  const diskHash = hashFile(absolute)
  return {
    chapterId,
    path,
    exists: true,
    expectedHash,
    diskHash,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    conflicted: expectedHash !== null && diskHash !== expectedHash,
    pending
  }
}

/** 外部改动时抛 file_conflict（错误码唯一来源：shared/domain/errors.ts）。 */
export function assertMirrorUnchanged(db: Db, projectDir: string, chapterId: string): MirrorState {
  const state = inspectMirror(db, projectDir, chapterId)
  if (state.conflicted) {
    throw new AppError('file_conflict', `mirror ${state.path} was modified outside Noryth`, {
      chapterId,
      path: state.path,
      expectedHash: state.expectedHash,
      diskHash: state.diskHash
    })
  }
  return state
}

export function mirrorFileHash(file: string): string | null {
  return existsSync(file) ? hashFile(file) : null
}

/** 发布后自检：写进去的字节必须与 expected_hash 一致。 */
export function verifyMirrorWrite(file: string, expectedHash: string): boolean {
  return existsSync(file) && hashFile(file) === expectedHash
}
