import { sql, type Insertable, type Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { OutboxTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type OutboxKind = 'manuscript_md'

export interface OutboxRecord {
  id: string
  projectId: string
  kind: OutboxKind
  path: string
  expectedHash: string
  attempts: number
  lastError: string | null
  publishedAt: string | null
  createdAt: string
  chapterId: string | null
  revisionId: string | null
  nextAttemptAt: string | null
}

export interface EnqueueOutboxInput {
  id?: string
  projectId: string
  kind?: OutboxKind
  path: string
  expectedHash: string
  chapterId: string
  revisionId: string
  createdAt?: string
}

type OutboxRow = Selectable<OutboxTable>

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as OutboxKind,
    path: row.path,
    expectedHash: row.expected_hash,
    attempts: row.attempts,
    lastError: row.last_error,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    chapterId: row.chapter_id,
    revisionId: row.revision_id,
    nextAttemptAt: row.next_attempt_at
  }
}

/**
 * outbox 是「提交事务里写、提交后发布」的唯一队列（DEV-PLAN §5.8）。
 * path 存相对项目根的路径，项目搬家后仍可发布。
 */
export class OutboxRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  enqueue(input: EnqueueOutboxInput): OutboxRecord {
    const id = input.id ?? newId('obx')
    const values: Insertable<OutboxTable> = {
      id,
      project_id: input.projectId,
      kind: input.kind ?? 'manuscript_md',
      path: input.path,
      expected_hash: input.expectedHash,
      last_error: null,
      published_at: null,
      created_at: input.createdAt ?? this.now(),
      chapter_id: input.chapterId,
      revision_id: input.revisionId,
      next_attempt_at: null
    }
    runStatement(this.runner, this.runner.db.insertInto('outbox').values(values))
    return this.get(id)!
  }

  get(id: string): OutboxRecord | null {
    const row = firstRow<OutboxRow>(
      this.runner,
      this.runner.db.selectFrom('outbox').selectAll().where('id', '=', id)
    )
    return row ? mapOutbox(row) : null
  }

  /** 未发布且到达重试时间的行；published_at 为 NULL 即 pending。 */
  listPending(projectId: string, dueAt: string, limit = 100): OutboxRecord[] {
    const rows = allRows<OutboxRow>(
      this.runner,
      this.runner.db
        .selectFrom('outbox')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('published_at', 'is', null)
        .where((eb) =>
          eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', dueAt)])
        )
        .orderBy('created_at')
        .orderBy(sql`rowid`)
        .limit(limit)
    )
    return rows.map(mapOutbox)
  }

  listByChapter(chapterId: string): OutboxRecord[] {
    const rows = allRows<OutboxRow>(
      this.runner,
      this.runner.db
        .selectFrom('outbox')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .orderBy(sql`rowid`)
    )
    return rows.map(mapOutbox)
  }

  latestForChapter(chapterId: string): OutboxRecord | null {
    const row = firstRow<OutboxRow>(
      this.runner,
      this.runner.db
        .selectFrom('outbox')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at', 'desc')
        .orderBy(sql`rowid`, 'desc')
        .limit(1)
    )
    return row ? mapOutbox(row) : null
  }

  /**
   * 是否已有「更晚入队且已发布」的行。
   * 退避重试可能让旧行走在新行之后；旧行此时不能再覆盖镜像。
   */
  hasNewerPublished(chapterId: string, createdAt: string, id: string): boolean {
    const row = firstRow<{ hit: number }>(
      this.runner,
      this.runner.db
        .selectFrom('outbox')
        .select(sql<number>`1`.as('hit'))
        .where('chapter_id', '=', chapterId)
        .where('published_at', 'is not', null)
        .where(
          sql<boolean>`(created_at > ${createdAt} or (created_at = ${createdAt} and rowid > (select rowid from outbox where id = ${id})))`
        )
        .limit(1)
    )
    return row !== undefined
  }

  /** 上一份已发布内容的 hash；用于区分「文件只是旧版本」和「被外部改过」。 */
  latestPublishedHash(chapterId: string, excludeId?: string): string | null {
    let query = this.runner.db
      .selectFrom('outbox')
      .select('expected_hash')
      .where('chapter_id', '=', chapterId)
      .where('published_at', 'is not', null)
      .orderBy('published_at', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .limit(1)
    if (excludeId) query = query.where('id', '<>', excludeId)
    const row = firstRow<{ expected_hash: string }>(this.runner, query)
    return row?.expected_hash ?? null
  }

  markPublished(id: string, at = this.now()): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('outbox')
        .set({ published_at: at, last_error: null, next_attempt_at: null })
        .where('id', '=', id)
    )
  }

  recordFailure(id: string, error: string, nextAttemptAt: string | null): OutboxRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('outbox')
        .set({ attempts: sql`attempts + 1`, last_error: error, next_attempt_at: nextAttemptAt })
        .where('id', '=', id)
    )
    return this.get(id)!
  }

  pendingCount(projectId: string): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('outbox')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('project_id', '=', projectId)
        .where('published_at', 'is', null)
    )
    return row?.count ?? 0
  }
}
