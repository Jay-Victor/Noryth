import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from './project-db'
import { hashFile } from './hash'
import { recomputeRevisionHash } from './revision'
import { OutboxRepo } from './repos/outbox'
import { systemClock, type Clock } from './repos/common'

export type VerifySeverity = 'error' | 'warn'

export interface VerifyIssue {
  code: string
  severity: VerifySeverity
  message: string
  details?: unknown
}

export interface VerifyStats {
  chapters: number
  beats: number
  liveBeats: number
  revisions: number
  outboxRows: number
  mirrorsChecked: number
}

export interface VerifyReport {
  ok: boolean
  checkedAt: string
  issues: VerifyIssue[]
  stats: VerifyStats
}

export interface VerifyOptions {
  projectDir?: string
  /** 默认 true；只校验 DB 时可关闭。 */
  checkMirror?: boolean
  now?: Clock
}

interface ChapterRevisionRow {
  chapter_id: string
  revision_id: string
  content_hash: string
  live_beats: number
  members: number
}

/**
 * `db.verify()`（DEV-PLAN §5.11 / PHASE-02 §5.4）：
 * 1. integrity_check + foreign_key_check
 * 2. 孤儿：beat.created_revision_id / revision_beat / chapter.current_revision_id
 * 3. seq：章内唯一 + seq_head >= max(seq) + 同一槽位单调（新版本 seq 必须大于被替换版本）
 * 4. 双活：同 (scene_id, ord) 多条非 superseded
 * 5. 镜像：outbox 最新行与 manuscript 文件 hash（只告警，不改 DB）
 *
 * 第 3 条按 ADR-0005 §4 修正：不再要求「阅读顺序 seq 递增」——重生成/编辑较早的拍
 * 会分配更大的 seq，阅读顺序单调会把合法操作报成错误（DEV-PLAN §5.3 只要求 as_of 单调）。
 *
 * `ok` 只由 error 决定；镜像/外部改动是 warn，不阻塞打开。
 */
export function verifyDatabase(db: Db, options: VerifyOptions = {}): VerifyReport {
  const issues: VerifyIssue[] = []
  const now = options.now ?? systemClock
  const error = (code: string, message: string, details?: unknown): void => {
    issues.push({ code, severity: 'error', message, details })
  }
  const warn = (code: string, message: string, details?: unknown): void => {
    issues.push({ code, severity: 'warn', message, details })
  }

  const integrity = db.pragma('integrity_check') as Array<Record<string, unknown>>
  for (const row of integrity) {
    const value = Object.values(row)[0]
    if (value !== 'ok') error('integrity_check', `integrity_check: ${String(value)}`, row)
  }

  const fkRows = db.pragma('foreign_key_check') as Array<Record<string, unknown>>
  if (fkRows.length > 0) {
    error('foreign_key_check', `foreign_key_check found ${fkRows.length} row(s)`, fkRows.slice(0, 20))
  }

  const orphanBeats = db
    .prepare(
      `SELECT b.id AS id, b.created_revision_id AS revision_id
       FROM beat b LEFT JOIN revision r ON r.id = b.created_revision_id
       WHERE r.id IS NULL LIMIT 20`
    )
    .all() as Array<{ id: string; revision_id: string }>
  if (orphanBeats.length > 0) {
    error('orphan_beat_revision', `${orphanBeats.length} beat(s) reference a missing revision`, orphanBeats)
  }

  const orphanMembers = db
    .prepare(
      `SELECT rb.revision_id AS revision_id, rb.beat_id AS beat_id
       FROM revision_beat rb LEFT JOIN beat b ON b.id = rb.beat_id
       WHERE b.id IS NULL LIMIT 20`
    )
    .all() as Array<{ revision_id: string; beat_id: string }>
  if (orphanMembers.length > 0) {
    error('orphan_revision_beat', `${orphanMembers.length} revision_beat row(s) reference a missing beat`, orphanMembers)
  }

  const orphanCurrent = db
    .prepare(
      `SELECT c.id AS chapter_id, c.current_revision_id AS revision_id
       FROM chapter c LEFT JOIN revision r ON r.id = c.current_revision_id
       WHERE c.current_revision_id IS NOT NULL
         AND (r.id IS NULL OR r.chapter_id <> c.id) LIMIT 20`
    )
    .all() as Array<{ chapter_id: string; revision_id: string }>
  if (orphanCurrent.length > 0) {
    error('orphan_current_revision', `${orphanCurrent.length} chapter(s) point to a missing/foreign revision`, orphanCurrent)
  }

  const orphanFinal = db
    .prepare(
      `SELECT c.id AS chapter_id, c.final_revision_id AS revision_id
       FROM chapter c LEFT JOIN revision r ON r.id = c.final_revision_id
       WHERE c.final_revision_id IS NOT NULL
         AND (r.id IS NULL OR r.chapter_id <> c.id) LIMIT 20`
    )
    .all() as Array<{ chapter_id: string; revision_id: string }>
  if (orphanFinal.length > 0) {
    error('orphan_final_revision', `${orphanFinal.length} chapter(s) point to a missing/foreign final revision`, orphanFinal)
  }

  const unlinkedBeats = db
    .prepare(
      `SELECT b.id AS id, b.chapter_id AS chapter_id, b.scene_id AS scene_id
       FROM beat b
       LEFT JOIN chapter_scene cs ON cs.chapter_id = b.chapter_id AND cs.scene_id = b.scene_id
       WHERE cs.scene_id IS NULL LIMIT 20`
    )
    .all() as Array<{ id: string; chapter_id: string; scene_id: string }>
  if (unlinkedBeats.length > 0) {
    error('beat_scene_unlinked', `${unlinkedBeats.length} beat(s) belong to a scene not linked to their chapter`, unlinkedBeats)
  }

  const doubleLive = db
    .prepare(
      `SELECT scene_id, ord, COUNT(*) AS count
       FROM beat WHERE status <> 'superseded'
       GROUP BY scene_id, ord HAVING COUNT(*) > 1 LIMIT 20`
    )
    .all() as Array<{ scene_id: string; ord: number; count: number }>
  if (doubleLive.length > 0) {
    error('double_live_beat', `${doubleLive.length} (scene, ord) slot(s) have more than one live beat`, doubleLive)
  }

  const project = db.prepare('SELECT id, seq_head FROM project LIMIT 1').get() as
    | { id: string; seq_head: number }
    | undefined
  if (!project) {
    error('project_missing', 'project row is missing')
  } else {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM beat').get() as { seq: number }
    if (project.seq_head < maxSeq.seq) {
      error('seq_head_behind', `project.seq_head ${project.seq_head} < max(beat.seq) ${maxSeq.seq}`)
    }
  }

  const nullSeqConfirmed = db
    .prepare(
      `SELECT COUNT(*) AS count FROM beat
       WHERE status IN ('confirmed','author_edited') AND seq IS NULL`
    )
    .get() as { count: number }
  if (nullSeqConfirmed.count > 0) {
    error('confirmed_without_seq', `${nullSeqConfirmed.count} confirmed beat(s) have no seq`)
  }

  // seq 唯一：同章两个活拍不能共享同一叙事序。
  const duplicateSeq = db
    .prepare(
      `SELECT chapter_id, seq, COUNT(*) AS count
       FROM beat WHERE status <> 'superseded' AND seq IS NOT NULL
       GROUP BY chapter_id, seq HAVING COUNT(*) > 1 LIMIT 20`
    )
    .all() as Array<{ chapter_id: string; seq: number; count: number }>
  if (duplicateSeq.length > 0) {
    error('seq_duplicate', `${duplicateSeq.length} chapter/seq pair(s) are used by more than one live beat`, duplicateSeq)
  }

  // 同一槽位单调：新版本的 seq 必须大于该槽位历史上任何被替换版本的 seq。
  const slotSeq = db
    .prepare(
      `SELECT live.id AS id, live.seq AS seq, previous.max_seq AS previous_max_seq
       FROM beat live
       JOIN (
         SELECT scene_id, ord, MAX(seq) AS max_seq
         FROM beat WHERE status = 'superseded'
         GROUP BY scene_id, ord
       ) previous ON previous.scene_id = live.scene_id AND previous.ord = live.ord
       WHERE live.status <> 'superseded' AND live.seq IS NOT NULL
         AND live.seq <= previous.max_seq
       LIMIT 20`
    )
    .all() as Array<{ id: string; seq: number; previous_max_seq: number }>
  if (slotSeq.length > 0) {
    error('seq_not_monotonic', `${slotSeq.length} slot(s) reuse an older seq than the version they replaced`, slotSeq)
  }

  const revisionRows = db
    .prepare(
      `SELECT c.id AS chapter_id, c.current_revision_id AS revision_id, r.content_hash AS content_hash,
              (SELECT COUNT(*) FROM beat b WHERE b.chapter_id = c.id AND b.status <> 'superseded') AS live_beats,
              (SELECT COUNT(*) FROM revision_beat rb WHERE rb.revision_id = c.current_revision_id) AS members
       FROM chapter c JOIN revision r ON r.id = c.current_revision_id
       WHERE c.current_revision_id IS NOT NULL`
    )
    .all() as ChapterRevisionRow[]

  const checkedRevisions = new Set<string>()
  for (const row of revisionRows) {
    const recomputed = recomputeRevisionHash(db, row.revision_id)
    if (recomputed !== row.content_hash) {
      error('revision_hash_mismatch', `revision ${row.revision_id} hash drifted`, {
        stored: row.content_hash,
        recomputed
      })
    }
    if (row.members !== row.live_beats) {
      error(
        'revision_manifest_incomplete',
        `revision ${row.revision_id}: ${row.members} member(s) but ${row.live_beats} live beat(s)`,
        { chapterId: row.chapter_id }
      )
    }
    checkedRevisions.add(row.revision_id)
  }

  const finalRows = db
    .prepare(
      `SELECT c.final_revision_id AS revision_id, r.content_hash AS content_hash
       FROM chapter c JOIN revision r ON r.id = c.final_revision_id
       WHERE c.final_revision_id IS NOT NULL`
    )
    .all() as Array<{ revision_id: string; content_hash: string }>
  for (const row of finalRows) {
    if (checkedRevisions.has(row.revision_id)) continue
    checkedRevisions.add(row.revision_id)
    if (recomputeRevisionHash(db, row.revision_id) !== row.content_hash) {
      error('revision_hash_mismatch', `final revision ${row.revision_id} hash drifted`)
    }
  }

  const stats: VerifyStats = {
    chapters: (db.prepare('SELECT COUNT(*) AS count FROM chapter').get() as { count: number }).count,
    beats: (db.prepare('SELECT COUNT(*) AS count FROM beat').get() as { count: number }).count,
    liveBeats: (
      db.prepare("SELECT COUNT(*) AS count FROM beat WHERE status <> 'superseded'").get() as { count: number }
    ).count,
    revisions: (db.prepare('SELECT COUNT(*) AS count FROM revision').get() as { count: number }).count,
    outboxRows: (db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count,
    mirrorsChecked: 0
  }

  if (options.projectDir && options.checkMirror !== false) {
    const outboxColumns = (db.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
    if (!outboxColumns.includes('chapter_id')) {
      warn('outbox_schema_outdated', 'outbox has no chapter_id (schema 1 project opened read-only)')
    } else {
      const outbox = new OutboxRepo(db)
      const chapters = db.prepare('SELECT id FROM chapter ORDER BY ord').all() as Array<{ id: string }>
      for (const chapter of chapters) {
        const latest = outbox.latestForChapter(chapter.id)
        if (!latest) continue
        stats.mirrorsChecked += 1
        const absolute = join(options.projectDir, latest.path)
        if (!existsSync(absolute)) {
          warn('mirror_missing', `mirror ${latest.path} is missing`, { chapterId: chapter.id })
          continue
        }
        const diskHash = hashFile(absolute)
        if (diskHash !== latest.expectedHash) {
          warn('mirror_hash_mismatch', `mirror ${latest.path} does not match its revision`, {
            chapterId: chapter.id,
            expectedHash: latest.expectedHash,
            diskHash
          })
        }
      }
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    checkedAt: now(),
    issues,
    stats
  }
}

/** DEV-PLAN §5.11：结果写 logs/verify-<date>.json，供诊断包读取。 */
export function writeVerifyReport(projectDir: string, report: VerifyReport): string {
  const stamp = report.checkedAt.slice(0, 10)
  const file = join(projectDir, 'logs', `verify-${stamp}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return file
}
