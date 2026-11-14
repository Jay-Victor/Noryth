import { sql, type Insertable, type Selectable, type UpdateObject } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { CharacterTable, Database } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type CharacterStatus = 'active' | 'archived'

export interface CharacterRecord {
  id: string
  projectId: string
  name: string
  cardJson: string
  cardVersion: number
  status: CharacterStatus
  createdAt: string
  updatedAt: string
}

export interface NewCharacterInput {
  id?: string
  projectId: string
  name: string
  cardJson: string
  cardVersion?: number
  status?: CharacterStatus
  createdAt?: string
  updatedAt?: string
}

type CharacterRow = Selectable<CharacterTable>

function mapCharacter(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    cardJson: row.card_json,
    cardVersion: row.card_version,
    status: row.status as CharacterStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class CharacterRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewCharacterInput): CharacterRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('chr')
    const values: Insertable<CharacterTable> = {
      id,
      project_id: input.projectId,
      name: input.name,
      card_json: input.cardJson,
      ...(input.cardVersion === undefined ? {} : { card_version: input.cardVersion }),
      status: input.status ?? 'active',
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('character').values(values))
    return this.get(id)!
  }

  get(id: string): CharacterRecord | null {
    const row = firstRow<CharacterRow>(
      this.runner,
      this.runner.db.selectFrom('character').selectAll().where('id', '=', id)
    )
    return row ? mapCharacter(row) : null
  }

  byName(projectId: string, name: string): CharacterRecord | null {
    const row = firstRow<CharacterRow>(
      this.runner,
      this.runner.db
        .selectFrom('character')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('name', '=', name)
    )
    return row ? mapCharacter(row) : null
  }

  list(projectId: string, options: { status?: CharacterStatus } = {}): CharacterRecord[] {
    let query = this.runner.db
      .selectFrom('character')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('name')
    if (options.status) query = query.where('status', '=', options.status)
    return allRows<CharacterRow>(this.runner, query).map(mapCharacter)
  }

  /** 角色卡改动递增 card_version；ID 保持稳定（PRD §7.1）。 */
  updateCard(id: string, cardJson: string): CharacterRecord {
    const update: UpdateObject<Database, 'character'> = {
      card_json: cardJson,
      card_version: sql`card_version + 1`,
      updated_at: this.now()
    }
    runStatement(this.runner, this.runner.db.updateTable('character').set(update).where('id', '=', id))
    return this.get(id)!
  }

  setStatus(id: string, status: CharacterStatus): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('character').set({ status, updated_at: this.now() }).where('id', '=', id)
    )
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('character').where('id', '=', id))
  }
}
