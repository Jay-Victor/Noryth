import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { BlueprintChangeTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type BlueprintChangeStatus = 'proposed' | 'applied' | 'rejected'

export interface BlueprintChangeRecord {
  id: string
  projectId: string
  proposalId: string | null
  opsJson: string
  impactJson: string
  status: BlueprintChangeStatus
  actor: string
  createdAt: string
  appliedAt: string | null
}

export interface NewBlueprintChangeInput {
  id?: string
  projectId: string
  proposalId?: string | null
  opsJson: string
  impactJson?: string
  actor: string
}

type BlueprintChangeRow = Selectable<BlueprintChangeTable>

function mapChange(row: BlueprintChangeRow): BlueprintChangeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    opsJson: row.ops_json,
    impactJson: row.impact_json,
    status: row.status as BlueprintChangeStatus,
    actor: row.actor,
    createdAt: row.created_at,
    appliedAt: row.applied_at
  }
}

/**
 * 蓝图变更记录（0009，PHASE-15 M1-8 / §5.2）。
 *
 * 一条变更一行：`ops_json` 是待应用的 op，`impact_json` 是 T29 的分析结果。
 * 应用后写 `applied_at`；拒绝只改状态，记录永久保留。
 */
export class BlueprintChangeRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewBlueprintChangeInput): BlueprintChangeRecord {
    const id = input.id ?? newId('bpc')
    const values: Insertable<BlueprintChangeTable> = {
      id,
      project_id: input.projectId,
      proposal_id: input.proposalId ?? null,
      ops_json: input.opsJson,
      impact_json: input.impactJson ?? '{}',
      status: 'proposed',
      actor: input.actor,
      created_at: this.now(),
      applied_at: null
    }
    runStatement(this.runner, this.runner.db.insertInto('blueprint_change').values(values))
    return this.get(id)!
  }

  get(id: string): BlueprintChangeRecord | null {
    const row = firstRow<BlueprintChangeRow>(
      this.runner,
      this.runner.db.selectFrom('blueprint_change').selectAll().where('id', '=', id)
    )
    return row ? mapChange(row) : null
  }

  listByProject(projectId: string): BlueprintChangeRecord[] {
    return allRows<BlueprintChangeRow>(
      this.runner,
      this.runner.db
        .selectFrom('blueprint_change')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
    ).map(mapChange)
  }

  setImpact(id: string, impactJson: string): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('blueprint_change').set({ impact_json: impactJson }).where('id', '=', id)
    )
  }

  setStatus(id: string, status: BlueprintChangeStatus, appliedAt: string | null = null): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('blueprint_change')
        .set({ status, applied_at: appliedAt })
        .where('id', '=', id)
    )
  }
}
