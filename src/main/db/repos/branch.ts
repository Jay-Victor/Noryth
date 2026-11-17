import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { RevisionBranchTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

/**
 * 分支（PHASE-16 §5.2 / M1-21）。
 *
 * 分支只承载 draft revision：final 永远 `branch_id = NULL`（主线）。
 * `head_revision_id` 是分支的当前末梢，随 `commitBeat` / patch / fork 移动；
 * revision 本身仍然只 INSERT，head 的移动只改这一张 bookkeeping 表。
 */

export type BranchStatus = 'open' | 'merged' | 'archived'

export interface BranchRecord {
  id: string
  projectId: string
  chapterId: string
  name: string
  baseRevisionId: string
  headRevisionId: string
  status: BranchStatus
  createdAt: string
  updatedAt: string
}

export interface NewBranchInput {
  id?: string
  projectId: string
  chapterId: string
  name: string
  baseRevisionId: string
  headRevisionId: string
  status?: BranchStatus
  createdAt?: string
}

type BranchRow = Selectable<RevisionBranchTable>

function mapBranch(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    name: row.name,
    baseRevisionId: row.base_revision_id,
    headRevisionId: row.head_revision_id,
    status: row.status as BranchStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class BranchRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewBranchInput): BranchRecord {
    const id = input.id ?? newId('brn')
    const at = input.createdAt ?? this.now()
    const values: Insertable<RevisionBranchTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      name: input.name,
      base_revision_id: input.baseRevisionId,
      head_revision_id: input.headRevisionId,
      status: input.status ?? 'open',
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('revision_branch').values(values))
    return this.get(id)!
  }

  get(id: string): BranchRecord | null {
    const row = firstRow<BranchRow>(
      this.runner,
      this.runner.db.selectFrom('revision_branch').selectAll().where('id', '=', id)
    )
    return row ? mapBranch(row) : null
  }

  listByChapter(chapterId: string): BranchRecord[] {
    const rows = allRows<BranchRow>(
      this.runner,
      this.runner.db
        .selectFrom('revision_branch')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .orderBy('id')
    )
    return rows.map(mapBranch)
  }

  findByName(chapterId: string, name: string): BranchRecord | null {
    const row = firstRow<BranchRow>(
      this.runner,
      this.runner.db
        .selectFrom('revision_branch')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .where('name', '=', name)
    )
    return row ? mapBranch(row) : null
  }

  /** 分支末梢移动：只有这里 UPDATE 分支行（revision 不动）。 */
  setHead(id: string, revisionId: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('revision_branch')
        .set({ head_revision_id: revisionId, updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  setStatus(id: string, status: BranchStatus): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('revision_branch')
        .set({ status, updated_at: this.now() })
        .where('id', '=', id)
    )
  }
}
