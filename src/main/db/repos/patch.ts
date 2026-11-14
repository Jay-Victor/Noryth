import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { PatchTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type PatchStatus = 'proposed' | 'accepted' | 'rejected' | 'applied' | 'superseded'

export interface PatchRecord {
  id: string
  projectId: string
  proposalId: string
  revisionId: string
  beatId: string
  before: string
  after: string
  reason: string
  issueRef: string
  status: PatchStatus
  appliedRevisionId: string | null
  createdAt: string
  decidedAt: string | null
}

export interface NewPatchInput {
  id?: string
  projectId: string
  proposalId: string
  revisionId: string
  beatId: string
  before: string
  after: string
  reason: string
  issueRef: string
  status?: PatchStatus
  createdAt?: string
}

type PatchRow = Selectable<PatchTable>

function mapPatch(row: PatchRow): PatchRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    revisionId: row.revision_id,
    beatId: row.beat_id,
    before: row.before,
    after: row.after,
    reason: row.reason,
    issueRef: row.issue_ref,
    status: row.status as PatchStatus,
    appliedRevisionId: row.applied_revision_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

export class PatchRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewPatchInput): PatchRecord {
    const id = input.id ?? newId('pat')
    const values: Insertable<PatchTable> = {
      id,
      project_id: input.projectId,
      proposal_id: input.proposalId,
      revision_id: input.revisionId,
      beat_id: input.beatId,
      before: input.before,
      after: input.after,
      reason: input.reason,
      issue_ref: input.issueRef,
      status: input.status ?? 'proposed',
      applied_revision_id: null,
      created_at: input.createdAt ?? this.now(),
      decided_at: null
    }
    runStatement(this.runner, this.runner.db.insertInto('patch').values(values))
    return this.get(id)!
  }

  get(id: string): PatchRecord | null {
    const row = firstRow<PatchRow>(
      this.runner,
      this.runner.db.selectFrom('patch').selectAll().where('id', '=', id)
    )
    return row ? mapPatch(row) : null
  }

  listByRevision(revisionId: string): PatchRecord[] {
    const rows = allRows<PatchRow>(
      this.runner,
      this.runner.db
        .selectFrom('patch')
        .selectAll()
        .where('revision_id', '=', revisionId)
        .orderBy('created_at')
    )
    return rows.map(mapPatch)
  }

  /** 决策只记录结果；真正写正文发生在阶段 08/09 的 apply 流程。 */
  setDecision(id: string, status: PatchStatus): PatchRecord {
    runStatement(
      this.runner,
      this.runner.db.updateTable('patch').set({ status, decided_at: this.now() }).where('id', '=', id)
    )
    return this.get(id)!
  }

  markApplied(id: string, appliedRevisionId: string): PatchRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('patch')
        .set({ status: 'applied', applied_revision_id: appliedRevisionId, decided_at: this.now() })
        .where('id', '=', id)
    )
    return this.get(id)!
  }
}
