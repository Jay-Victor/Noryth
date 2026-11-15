import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ForeshadowTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type ForeshadowStatus = 'open' | 'closed'

export interface ForeshadowRecord {
  id: string
  projectId: string
  text: string
  plantedChapterId: string | null
  plannedPayoffChapterId: string | null
  payoffChapterId: string | null
  status: ForeshadowStatus
  createdAt: string
  updatedAt: string
}

export interface NewForeshadowInput {
  id?: string
  projectId: string
  text: string
  plantedChapterId?: string | null
  plannedPayoffChapterId?: string | null
}

export interface ForeshadowPatch {
  text?: string
  plannedPayoffChapterId?: string | null
}

type ForeshadowRow = Selectable<ForeshadowTable>

function mapForeshadow(row: ForeshadowRow): ForeshadowRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    plantedChapterId: row.planted_chapter_id,
    plannedPayoffChapterId: row.planned_payoff_chapter_id,
    payoffChapterId: row.payoff_chapter_id,
    status: row.status as ForeshadowStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 伏笔（0009，PHASE-15 M1-10）。
 *
 * 只存作者手写的标注；不做自动识别、不进检索、不产生闸门判定。
 * 关闭伏笔写 `payoff_chapter_id`，不物理删除历史（除非作者删整条）。
 */
export class ForeshadowRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewForeshadowInput): ForeshadowRecord {
    const at = this.now()
    const id = input.id ?? newId('fs')
    const values: Insertable<ForeshadowTable> = {
      id,
      project_id: input.projectId,
      text: input.text,
      planted_chapter_id: input.plantedChapterId ?? null,
      planned_payoff_chapter_id: input.plannedPayoffChapterId ?? null,
      payoff_chapter_id: null,
      status: 'open',
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('foreshadow').values(values))
    return this.get(id)!
  }

  get(id: string): ForeshadowRecord | null {
    const row = firstRow<ForeshadowRow>(
      this.runner,
      this.runner.db.selectFrom('foreshadow').selectAll().where('id', '=', id)
    )
    return row ? mapForeshadow(row) : null
  }

  listByProject(projectId: string): ForeshadowRecord[] {
    return allRows<ForeshadowRow>(
      this.runner,
      this.runner.db.selectFrom('foreshadow').selectAll().where('project_id', '=', projectId).orderBy('created_at')
    ).map(mapForeshadow)
  }

  listOpen(projectId: string): ForeshadowRecord[] {
    return allRows<ForeshadowRow>(
      this.runner,
      this.runner.db
        .selectFrom('foreshadow')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('status', '=', 'open')
        .orderBy('created_at')
    ).map(mapForeshadow)
  }

  update(id: string, patch: ForeshadowPatch): ForeshadowRecord {
    const update: Record<string, unknown> = {}
    if (patch.text !== undefined) update.text = patch.text
    if (patch.plannedPayoffChapterId !== undefined) update.planned_payoff_chapter_id = patch.plannedPayoffChapterId
    if (Object.keys(update).length > 0) {
      update.updated_at = this.now()
      runStatement(
        this.runner,
        this.runner.db
          .updateTable('foreshadow')
          .set(update as never)
          .where('id', '=', id)
      )
    }
    return this.get(id)!
  }

  close(id: string, payoffChapterId: string): ForeshadowRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('foreshadow')
        .set({ status: 'closed', payoff_chapter_id: payoffChapterId, updated_at: this.now() })
        .where('id', '=', id)
    )
    return this.get(id)!
  }

  reopen(id: string): ForeshadowRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('foreshadow')
        .set({ status: 'open', payoff_chapter_id: null, updated_at: this.now() })
        .where('id', '=', id)
    )
    return this.get(id)!
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('foreshadow').where('id', '=', id))
  }
}
