import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ToolCallTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type ToolCallStatus = 'ok' | 'error'

export interface ToolCallRecord {
  id: string
  projectId: string
  jobId: string
  turnId: string
  tool: string
  toolVersion: string
  actorId: string
  scopeJson: string
  argsHash: string
  resultIdsJson: string
  resultJson: string | null
  status: ToolCallStatus
  errorCode: string | null
  latencyMs: number
  degraded: string | null
  idempotencyKey: string | null
  createdAt: string
}

export interface NewToolCallInput {
  id?: string
  projectId: string
  jobId: string
  turnId: string
  tool: string
  toolVersion: string
  actorId: string
  scopeJson: string
  argsHash: string
  resultIdsJson?: string
  resultJson?: string | null
  status: ToolCallStatus
  errorCode?: string | null
  latencyMs: number
  degraded?: string | null
  idempotencyKey?: string | null
  createdAt?: string
}

type ToolCallRow = Selectable<ToolCallTable>

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    turnId: row.turn_id,
    tool: row.tool,
    toolVersion: row.tool_version,
    actorId: row.actor_id,
    scopeJson: row.scope_json,
    argsHash: row.args_hash,
    resultIdsJson: row.result_ids_json,
    resultJson: row.result_json,
    status: row.status as ToolCallStatus,
    errorCode: row.error_code,
    latencyMs: row.latency_ms,
    degraded: row.degraded,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  }
}

/** 审计表：只存 args_hash 与结果 ID，不存参数原文（PRD §7.2）。 */
export class ToolCallRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewToolCallInput): ToolCallRecord {
    const id = input.id ?? newId('tc')
    const values: Insertable<ToolCallTable> = {
      id,
      project_id: input.projectId,
      job_id: input.jobId,
      turn_id: input.turnId,
      tool: input.tool,
      tool_version: input.toolVersion,
      actor_id: input.actorId,
      scope_json: input.scopeJson,
      args_hash: input.argsHash,
      result_ids_json: input.resultIdsJson ?? '[]',
      result_json: input.resultJson ?? null,
      status: input.status,
      error_code: input.errorCode ?? null,
      latency_ms: input.latencyMs,
      degraded: input.degraded ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('tool_call').values(values))
    return this.get(id)!
  }

  get(id: string): ToolCallRecord | null {
    const row = firstRow<ToolCallRow>(
      this.runner,
      this.runner.db.selectFrom('tool_call').selectAll().where('id', '=', id)
    )
    return row ? mapToolCall(row) : null
  }

  findByIdempotency(projectId: string, idempotencyKey: string): ToolCallRecord | null {
    const row = firstRow<ToolCallRow>(
      this.runner,
      this.runner.db
        .selectFrom('tool_call')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('idempotency_key', '=', idempotencyKey)
    )
    return row ? mapToolCall(row) : null
  }

  listByTurn(turnId: string): ToolCallRecord[] {
    const rows = allRows<ToolCallRow>(
      this.runner,
      this.runner.db.selectFrom('tool_call').selectAll().where('turn_id', '=', turnId).orderBy('created_at')
    )
    return rows.map(mapToolCall)
  }
}
