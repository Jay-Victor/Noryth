import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ChapterTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type ChapterStatus =
  | 'planned'
  | 'storyboard_ready'
  | 'drafting'
  | 'draft_complete'
  | 'under_review'
  | 'revising'
  | 'approved'
  | 'finalized'
  | 'paused'
  | 'abandoned'

export interface ChapterRecord {
  id: string
  projectId: string
  outlineNodeId: string
  ord: number
  status: ChapterStatus
  coveredUntilSeq: number
  currentRevisionId: string | null
  finalRevisionId: string | null
  openedAt: string | null
  finalizedAt: string | null
}

export interface NewChapterInput {
  id?: string
  projectId: string
  outlineNodeId: string
  ord: number
  status?: ChapterStatus
  coveredUntilSeq?: number
  currentRevisionId?: string | null
  finalRevisionId?: string | null
  openedAt?: string | null
  finalizedAt?: string | null
}

type ChapterRow = Selectable<ChapterTable>

function mapChapter(row: ChapterRow): ChapterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    outlineNodeId: row.outline_node_id,
    ord: row.ord,
    status: row.status as ChapterStatus,
    coveredUntilSeq: row.covered_until_seq,
    currentRevisionId: row.current_revision_id,
    finalRevisionId: row.final_revision_id,
    openedAt: row.opened_at,
    finalizedAt: row.finalized_at
  }
}

export class ChapterRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewChapterInput): ChapterRecord {
    const id = input.id ?? newId('ch')
    const values: Insertable<ChapterTable> = {
      id,
      project_id: input.projectId,
      outline_node_id: input.outlineNodeId,
      ord: input.ord,
      status: input.status ?? 'planned',
      covered_until_seq: input.coveredUntilSeq ?? 0,
      current_revision_id: input.currentRevisionId ?? null,
      final_revision_id: input.finalRevisionId ?? null,
      opened_at: input.openedAt ?? null,
      finalized_at: input.finalizedAt ?? null
    }
    runStatement(this.runner, this.runner.db.insertInto('chapter').values(values))
    return this.get(id)!
  }

  get(id: string): ChapterRecord | null {
    const row = firstRow<ChapterRow>(
      this.runner,
      this.runner.db.selectFrom('chapter').selectAll().where('id', '=', id)
    )
    return row ? mapChapter(row) : null
  }

  listByProject(projectId: string): ChapterRecord[] {
    const rows = allRows<ChapterRow>(
      this.runner,
      this.runner.db.selectFrom('chapter').selectAll().where('project_id', '=', projectId).orderBy('ord')
    )
    return rows.map(mapChapter)
  }

  setStatus(id: string, status: ChapterStatus): void {
    runStatement(this.runner, this.runner.db.updateTable('chapter').set({ status }).where('id', '=', id))
  }

  setCurrentRevision(id: string, revisionId: string | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ current_revision_id: revisionId }).where('id', '=', id)
    )
  }

  setFinalRevision(id: string, revisionId: string | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ final_revision_id: revisionId }).where('id', '=', id)
    )
  }

  setCoveredUntilSeq(id: string, seq: number): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ covered_until_seq: seq }).where('id', '=', id)
    )
  }

  markOpened(id: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ opened_at: this.now() })
        .where('id', '=', id)
        .where('opened_at', 'is', null)
    )
  }

  markFinalized(id: string, revisionId: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ status: 'finalized', final_revision_id: revisionId, finalized_at: this.now() })
        .where('id', '=', id)
    )
  }
}
