import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { MemoryAuditTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

/**
 * 记忆审计（PHASE-09 H4 / PRD §5.4）。
 *
 * 每条记忆必须能追溯到定稿章与拍；标记错误、重建、supersede 都要留痕。
 * 审计不物理删除，也不改业务行：它只回答「谁在什么时候因为什么动了哪一条」。
 */

export type MemoryAuditAction =
  | 'extract'
  | 'apply'
  | 'invalidate'
  | 'rebuild'
  | 'supersede'
  | 'evidence_mismatch'
  | 'archive'
  | 'restore'

export type MemoryAuditEntity = 'memory_entry' | 'world_fact' | 'belief' | 'relationship' | 'proposal'

export interface MemoryAuditRecord {
  id: string
  projectId: string
  jobId: string | null
  action: MemoryAuditAction
  actor: string
  entityType: MemoryAuditEntity
  entityId: string
  detailJson: string
  createdAt: string
}

export interface NewMemoryAuditInput {
  id?: string
  projectId: string
  jobId?: string | null
  action: MemoryAuditAction
  actor: string
  entityType: MemoryAuditEntity
  entityId: string
  detail?: Record<string, unknown>
  createdAt?: string
}

type AuditRow = Selectable<MemoryAuditTable>

function mapAudit(row: AuditRow): MemoryAuditRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    action: row.action as MemoryAuditAction,
    actor: row.actor,
    entityType: row.entity_type as MemoryAuditEntity,
    entityId: row.entity_id,
    detailJson: row.detail_json,
    createdAt: row.created_at
  }
}

export class MemoryAuditRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewMemoryAuditInput): MemoryAuditRecord {
    const id = input.id ?? newId('maud')
    const values: Insertable<MemoryAuditTable> = {
      id,
      project_id: input.projectId,
      job_id: input.jobId ?? null,
      action: input.action,
      actor: input.actor,
      entity_type: input.entityType,
      entity_id: input.entityId,
      detail_json: JSON.stringify(input.detail ?? {}),
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_audit').values(values))
    return this.get(id)!
  }

  get(id: string): MemoryAuditRecord | null {
    const row = firstRow<AuditRow>(
      this.runner,
      this.runner.db.selectFrom('memory_audit').selectAll().where('id', '=', id)
    )
    return row ? mapAudit(row) : null
  }

  listByProject(projectId: string, limit = 200): MemoryAuditRecord[] {
    const rows = allRows<AuditRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_audit')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .limit(limit)
    )
    return rows.map(mapAudit)
  }

  listByEntity(entityId: string): MemoryAuditRecord[] {
    const rows = allRows<AuditRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_audit')
        .selectAll()
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
    )
    return rows.map(mapAudit)
  }
}
