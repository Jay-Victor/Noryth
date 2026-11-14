import { AppError } from '../../shared/domain/app-error'
import type { Db } from './project-db'
import { systemClock, type Clock } from './repos/common'

/**
 * 叙事序分配（DEV-PLAN §5.3）：
 * - project.seq_head 是唯一计数器，只在写事务内递增；
 * - 一拍提交、一次世界事实断言、一次关系边变化各分配一个 seq；
 * - 同一次记忆应用的多条条目共享同一个 seq（调用方传同一个值，不重复调用）。
 */
export function allocateSeq(db: Db, projectId: string, now: Clock = systemClock): number {
  if (!db.inTransaction) {
    throw new AppError('internal_error', 'seq allocation requires a write transaction')
  }
  const row = db
    .prepare('UPDATE project SET seq_head = seq_head + 1, updated_at = ? WHERE id = ? RETURNING seq_head')
    .get(now(), projectId) as { seq_head: number } | undefined
  if (!row) {
    throw new AppError('project_not_found', `project ${projectId} not found`)
  }
  return row.seq_head
}

export function readSeqHead(db: Db, projectId: string): number {
  const row = db.prepare('SELECT seq_head FROM project WHERE id = ?').get(projectId) as
    | { seq_head: number }
    | undefined
  if (!row) throw new AppError('project_not_found', `project ${projectId} not found`)
  return row.seq_head
}

/**
 * chapter.covered_until_seq = 本章 confirmed/author_edited 拍的最大 seq。
 * 每次提交与定稿后重算（DEV-PLAN §5.3 第 4 条）。
 */
export function recomputeCoveredUntilSeq(db: Db, chapterId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq
       FROM beat
       WHERE chapter_id = ? AND status IN ('confirmed','author_edited') AND seq IS NOT NULL`
    )
    .get(chapterId) as { seq: number }
  db.prepare('UPDATE chapter SET covered_until_seq = ? WHERE id = ?').run(row.seq, chapterId)
  return row.seq
}
