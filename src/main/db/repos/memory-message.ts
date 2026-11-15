import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, runStatement } from '../kysely'
import type { MemoryMessageTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

/**
 * 记忆台对话（UI-DESIGN §7.3）。
 *
 * 讨论只用于解释来源与冲突，永不写长期状态；[应用] 是唯一写入入口。
 * 与创作台的 write_message、审批台的 review_message 分开存，避免审计流互相污染。
 */

export type MemoryMessageRole = 'author' | 'memory' | 'system'
export type MemoryMessageKind = 'text' | 'proposal' | 'apply' | 'pause'

export interface MemoryMessageRecord {
  id: string
  projectId: string
  chapterId: string | null
  jobId: string | null
  role: MemoryMessageRole
  kind: MemoryMessageKind
  body: string
  metaJson: string
  createdAt: string
}

export interface NewMemoryMessageInput {
  id?: string
  projectId: string
  chapterId?: string | null
  jobId?: string | null
  role: MemoryMessageRole
  kind?: MemoryMessageKind
  body?: string
  meta?: Record<string, unknown>
  createdAt?: string
}

type MessageRow = Selectable<MemoryMessageTable>

function mapMessage(row: MessageRow): MemoryMessageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    jobId: row.job_id,
    role: row.role as MemoryMessageRole,
    kind: row.kind as MemoryMessageKind,
    body: row.body,
    metaJson: row.meta_json,
    createdAt: row.created_at
  }
}

export class MemoryMessageRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewMemoryMessageInput): MemoryMessageRecord {
    const id = input.id ?? newId('mmsg')
    const values: Insertable<MemoryMessageTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId ?? null,
      job_id: input.jobId ?? null,
      role: input.role,
      kind: input.kind ?? 'text',
      body: input.body ?? '',
      meta_json: JSON.stringify(input.meta ?? {}),
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_message').values(values))
    return this.get(id)!
  }

  get(id: string): MemoryMessageRecord | null {
    const row = this.runner.raw.prepare('SELECT * FROM memory_message WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? mapMessage(row) : null
  }

  /** 按章取；chapterId 为空时取全项目（提案历史跨章浏览）。 */
  list(projectId: string, chapterId: string | null, limit = 80): MemoryMessageRecord[] {
    const sql =
      chapterId === null
        ? 'SELECT * FROM memory_message WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
        : 'SELECT * FROM memory_message WHERE project_id = ? AND chapter_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    const params = chapterId === null ? [projectId, limit] : [projectId, chapterId, limit]
    const rows = this.runner.raw.prepare(sql).all(...params) as MessageRow[]
    return rows.map(mapMessage).reverse()
  }

  listByJob(projectId: string, jobId: string): MemoryMessageRecord[] {
    const rows = allRows<MessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_message')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('job_id', '=', jobId)
        .orderBy('created_at')
    )
    return rows.map(mapMessage)
  }
}
