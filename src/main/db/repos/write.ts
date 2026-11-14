import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { SchedulerEventTable, StoryboardDraftTable, WriteMessageTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

/**
 * 创作台的三张表（0004_writing.sql）：
 * - `storyboard_draft`：G2 之前的唯一分镜真相；G2 通过才物化到 scene/beat。
 * - `write_message`：编排对话；只讨论分镜与出口，不写正文。
 * - `scheduler_event`：暂停原因 / 出口判定 / 收束，重启后仍可显示。
 */

export interface StoryboardDraftRecord {
  chapterId: string
  projectId: string
  rev: number
  scenesJson: string
  updatedBy: 'author' | 'orchestrator'
  updatedAt: string
}

type DraftRow = Selectable<StoryboardDraftTable>

function mapDraft(row: DraftRow): StoryboardDraftRecord {
  return {
    chapterId: row.chapter_id,
    projectId: row.project_id,
    rev: row.rev,
    scenesJson: row.scenes_json,
    updatedBy: row.updated_by as 'author' | 'orchestrator',
    updatedAt: row.updated_at
  }
}

export class StoryboardDraftRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  /** 写草案：同章只保留一行，每次更新 rev + 1（编辑器与编排提案共用）。 */
  save(input: {
    chapterId: string
    projectId: string
    scenesJson: string
    updatedBy: 'author' | 'orchestrator'
  }): StoryboardDraftRecord {
    const at = this.now()
    const existing = this.get(input.chapterId)
    if (existing) {
      runStatement(
        this.runner,
        this.runner.db
          .updateTable('storyboard_draft')
          .set({
            scenes_json: input.scenesJson,
            updated_by: input.updatedBy,
            rev: existing.rev + 1,
            updated_at: at
          })
          .where('chapter_id', '=', input.chapterId)
      )
      return this.get(input.chapterId)!
    }
    const values: Insertable<StoryboardDraftTable> = {
      chapter_id: input.chapterId,
      project_id: input.projectId,
      rev: 1,
      scenes_json: input.scenesJson,
      updated_by: input.updatedBy,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('storyboard_draft').values(values))
    return this.get(input.chapterId)!
  }

  get(chapterId: string): StoryboardDraftRecord | null {
    const row = firstRow<DraftRow>(
      this.runner,
      this.runner.db.selectFrom('storyboard_draft').selectAll().where('chapter_id', '=', chapterId)
    )
    return row ? mapDraft(row) : null
  }

  remove(chapterId: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('storyboard_draft').where('chapter_id', '=', chapterId))
  }
}

export interface WriteMessageRecord {
  id: string
  projectId: string
  chapterId: string
  role: 'author' | 'orchestrator' | 'system'
  kind: 'text' | 'storyboard' | 'pause' | 'refusal'
  body: string
  metaJson: string
  createdAt: string
}

type MessageRow = Selectable<WriteMessageTable>

function mapMessage(row: MessageRow): WriteMessageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    role: row.role as WriteMessageRecord['role'],
    kind: row.kind as WriteMessageRecord['kind'],
    body: row.body,
    metaJson: row.meta_json,
    createdAt: row.created_at
  }
}

export class WriteMessageRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    projectId: string
    chapterId: string
    role: WriteMessageRecord['role']
    kind?: WriteMessageRecord['kind']
    body?: string
    metaJson?: string
    createdAt?: string
  }): WriteMessageRecord {
    const id = input.id ?? newId('wmsg')
    const at = input.createdAt ?? this.now()
    const values: Insertable<WriteMessageTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      role: input.role,
      kind: input.kind ?? 'text',
      body: input.body ?? '',
      meta_json: input.metaJson ?? '{}',
      created_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('write_message').values(values))
    return this.get(id)!
  }

  get(id: string): WriteMessageRecord | null {
    const row = firstRow<MessageRow>(
      this.runner,
      this.runner.db.selectFrom('write_message').selectAll().where('id', '=', id)
    )
    return row ? mapMessage(row) : null
  }

  listByChapter(chapterId: string, limit = 100): WriteMessageRecord[] {
    const rows = allRows<MessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('write_message')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .limit(limit)
    )
    return rows.map(mapMessage)
  }
}

export type SchedulerEventKind =
  | 'started'
  | 'beat_committed'
  | 'beat_confirmed'
  | 'paused'
  | 'resumed'
  | 'scene_closed'
  | 'chapter_complete'
  | 'stopped'

export interface SchedulerEventRecord {
  id: string
  projectId: string
  chapterId: string
  jobId: string | null
  kind: SchedulerEventKind
  reason: string | null
  payloadJson: string
  createdAt: string
}

type EventRow = Selectable<SchedulerEventTable>

function mapEvent(row: EventRow): SchedulerEventRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    jobId: row.job_id,
    kind: row.kind as SchedulerEventKind,
    reason: row.reason,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  }
}

export class SchedulerEventRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    projectId: string
    chapterId: string
    jobId?: string | null
    kind: SchedulerEventKind
    reason?: string | null
    payloadJson?: string
    createdAt?: string
  }): SchedulerEventRecord {
    const id = input.id ?? newId('evt')
    const at = input.createdAt ?? this.now()
    const values: Insertable<SchedulerEventTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      job_id: input.jobId ?? null,
      kind: input.kind,
      reason: input.reason ?? null,
      payload_json: input.payloadJson ?? '{}',
      created_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('scheduler_event').values(values))
    return this.get(id)!
  }

  get(id: string): SchedulerEventRecord | null {
    const row = firstRow<EventRow>(
      this.runner,
      this.runner.db.selectFrom('scheduler_event').selectAll().where('id', '=', id)
    )
    return row ? mapEvent(row) : null
  }

  listByChapter(chapterId: string, limit = 200): SchedulerEventRecord[] {
    const rows = allRows<EventRow>(
      this.runner,
      this.runner.db
        .selectFrom('scheduler_event')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .limit(limit)
    )
    return rows.map(mapEvent)
  }

  /** 最近一次暂停/停止/完成事件；重启后用于恢复「暂停原因横幅」。 */
  latestPause(chapterId: string): SchedulerEventRecord | null {
    const row = firstRow<EventRow>(
      this.runner,
      this.runner.db
        .selectFrom('scheduler_event')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .where('kind', 'in', ['paused', 'stopped', 'chapter_complete'] as SchedulerEventKind[])
        .orderBy('created_at', 'desc')
        .limit(1)
    )
    return row ? mapEvent(row) : null
  }
}
