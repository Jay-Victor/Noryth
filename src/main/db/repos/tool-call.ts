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
  /** 归属章（迁移 0011）；规划会话与项目级工具为 null。 */
  chapterId: string | null
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
  chapterId?: string | null
}

type ToolCallRow = Selectable<ToolCallTable>

/** 审计面板的过滤条件（PHASE-18 §5.3）：章 / Agent / 状态。 */
export interface ToolCallFilter {
  chapterId?: string
  actorId?: string
  status?: ToolCallStatus
  tool?: string
  limit?: number
  offset?: number
}

export const TOOL_CALL_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

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
    createdAt: row.created_at,
    chapterId: row.chapter_id
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
      created_at: input.createdAt ?? this.now(),
      chapter_id: input.chapterId ?? null
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

  /**
   * 面板列表：时间倒序分页（PHASE-18 §5.3）。
   *
   * 过滤条件逐条 where，不写泛型辅助函数：Kysely 在 selectAll 与 countAll
   * 两条查询上的 builder 类型不同，复制四行条件比类型体操便宜。
   */
  listByProject(projectId: string, filter: ToolCallFilter = {}): ToolCallRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? TOOL_CALL_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const offset = Math.max(filter.offset ?? 0, 0)
    let query = this.runner.db
      .selectFrom('tool_call')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
    if (filter.chapterId !== undefined) query = query.where('chapter_id', '=', filter.chapterId)
    if (filter.actorId !== undefined) query = query.where('actor_id', '=', filter.actorId)
    if (filter.status !== undefined) query = query.where('status', '=', filter.status)
    if (filter.tool !== undefined) query = query.where('tool', '=', filter.tool)
    return allRows<ToolCallRow>(this.runner, query).map(mapToolCall)
  }

  countByProject(projectId: string, filter: ToolCallFilter = {}): number {
    let query = this.runner.db
      .selectFrom('tool_call')
      .select((expr) => expr.fn.countAll<number>().as('count'))
      .where('project_id', '=', projectId)
    if (filter.chapterId !== undefined) query = query.where('chapter_id', '=', filter.chapterId)
    if (filter.actorId !== undefined) query = query.where('actor_id', '=', filter.actorId)
    if (filter.status !== undefined) query = query.where('status', '=', filter.status)
    if (filter.tool !== undefined) query = query.where('tool', '=', filter.tool)
    const row = firstRow<{ count: number }>(this.runner, query)
    return row ? Number(row.count) : 0
  }

  /** 面板的 Agent 过滤项：只返回本项目出现过的 actor，按首次出现排序。 */
  distinctActors(projectId: string): string[] {
    const rows = allRows<{ actor_id: string }>(
      this.runner,
      this.runner.db
        .selectFrom('tool_call')
        .select('actor_id')
        .distinct()
        .where('project_id', '=', projectId)
        .orderBy('actor_id')
    )
    return rows.map((row) => row.actor_id)
  }
}
