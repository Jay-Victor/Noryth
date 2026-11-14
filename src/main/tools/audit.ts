import type { ToolCallRepo } from '../db/repos/tool-call'
import type { ErrorCode } from '../../shared/domain/errors'

/**
 * tool_call 审计（PRD §4.9.7）：只存 args_hash 与结果 ID，不存参数原文。
 * scope_json 只存 ID 与 as_of；未授权尝试额外标 unauthorized。
 */

export interface AuditScope {
  actorId: string
  characterId: string | null
  asOf: number
  expectedRevision: string | null
  unauthorized?: boolean
}

export function scopeJson(scope: AuditScope): string {
  return JSON.stringify({
    actor_id: scope.actorId,
    character_id: scope.characterId,
    as_of: scope.asOf,
    expected_revision: scope.expectedRevision,
    ...(scope.unauthorized ? { unauthorized: true } : {})
  })
}

export interface AuditEntry {
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
  status: 'ok' | 'error'
  errorCode?: ErrorCode | null
  latencyMs: number
  degraded?: string | null
  idempotencyKey?: string | null
}

export interface AuditSink {
  record(entry: AuditEntry): void
}

export class RepoAuditSink implements AuditSink {
  constructor(private readonly repo: ToolCallRepo) {}

  record(entry: AuditEntry): void {
    this.repo.insert({
      projectId: entry.projectId,
      jobId: entry.jobId,
      turnId: entry.turnId,
      tool: entry.tool,
      toolVersion: entry.toolVersion,
      actorId: entry.actorId,
      scopeJson: entry.scopeJson,
      argsHash: entry.argsHash,
      resultIdsJson: entry.resultIdsJson,
      resultJson: entry.resultJson ?? null,
      status: entry.status,
      errorCode: entry.errorCode ?? null,
      latencyMs: entry.latencyMs,
      degraded: entry.degraded ?? null,
      idempotencyKey: entry.idempotencyKey ?? null
    })
  }
}

/** 单元测试用：保留条目，断言审计内容。 */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = []
  record(entry: AuditEntry): void {
    this.entries.push(entry)
  }
}
