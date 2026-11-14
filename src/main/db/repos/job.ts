import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { JobTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type JobType =
  | 'beat.generate'
  | 'review.run'
  | 'patch.propose'
  | 'memory.extract'
  | 'memory.apply'
  | 'memory.rebuild'
  | 'export.run'
  | 'index.rebuild'
  | 'backup.create'

export type JobStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface JobRecord {
  id: string
  projectId: string
  type: JobType
  status: JobStatus
  expectedRevision: string | null
  epoch: number
  idempotencyKey: string
  payloadJson: string
  resultJson: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface NewJobInput {
  id?: string
  projectId: string
  type: JobType
  status?: JobStatus
  expectedRevision?: string | null
  epoch: number
  idempotencyKey: string
  payloadJson: string
  createdAt?: string
  updatedAt?: string
}

type JobRow = Selectable<JobTable>

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    expectedRevision: row.expected_revision,
    epoch: row.epoch,
    idempotencyKey: row.idempotency_key,
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class JobRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewJobInput): JobRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('job')
    const values: Insertable<JobTable> = {
      id,
      project_id: input.projectId,
      type: input.type,
      status: input.status ?? 'queued',
      expected_revision: input.expectedRevision ?? null,
      epoch: input.epoch,
      idempotency_key: input.idempotencyKey,
      payload_json: input.payloadJson,
      result_json: null,
      error_code: null,
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('job').values(values))
    return this.get(id)!
  }

  get(id: string): JobRecord | null {
    const row = firstRow<JobRow>(
      this.runner,
      this.runner.db.selectFrom('job').selectAll().where('id', '=', id)
    )
    return row ? mapJob(row) : null
  }

  findByIdempotency(projectId: string, idempotencyKey: string): JobRecord | null {
    const row = firstRow<JobRow>(
      this.runner,
      this.runner.db
        .selectFrom('job')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('idempotency_key', '=', idempotencyKey)
    )
    return row ? mapJob(row) : null
  }

  listByStatus(projectId: string, status: JobStatus): JobRecord[] {
    const rows = allRows<JobRow>(
      this.runner,
      this.runner.db
        .selectFrom('job')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('status', '=', status)
        .orderBy('created_at')
    )
    return rows.map(mapJob)
  }

  setStatus(
    id: string,
    status: JobStatus,
    result: { resultJson?: string | null; errorCode?: string | null } = {}
  ): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('job')
        .set({
          status,
          result_json: result.resultJson ?? null,
          error_code: result.errorCode ?? null,
          updated_at: this.now()
        })
        .where('id', '=', id)
    )
  }
}
