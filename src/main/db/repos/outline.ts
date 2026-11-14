import { sql, type Insertable, type Selectable, type UpdateObject } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { Database, OutlineNodeTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type OutlineKind = 'main' | 'volume' | 'chapter'
export type OutlineStatus = 'draft' | 'approved' | 'locked'

export interface OutlineNodeRecord {
  id: string
  projectId: string
  parentId: string | null
  kind: OutlineKind
  ord: number
  title: string
  content: string
  status: OutlineStatus
  version: number
  createdAt: string
  updatedAt: string
}

export interface NewOutlineNodeInput {
  id?: string
  projectId: string
  parentId?: string | null
  kind: OutlineKind
  ord: number
  title: string
  content?: string
  status?: OutlineStatus
  createdAt?: string
  updatedAt?: string
}

export interface OutlineNodePatch {
  title?: string
  content?: string
  status?: OutlineStatus
}

type OutlineRow = Selectable<OutlineNodeTable>

function mapOutline(row: OutlineRow): OutlineNodeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    kind: row.kind as OutlineKind,
    ord: row.ord,
    title: row.title,
    content: row.content,
    status: row.status as OutlineStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class OutlineRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewOutlineNodeInput): OutlineNodeRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('out')
    const values: Insertable<OutlineNodeTable> = {
      id,
      project_id: input.projectId,
      parent_id: input.parentId ?? null,
      kind: input.kind,
      ord: input.ord,
      title: input.title,
      content: input.content ?? '',
      status: input.status ?? 'draft',
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('outline_node').values(values))
    return this.get(id)!
  }

  get(id: string): OutlineNodeRecord | null {
    const row = firstRow<OutlineRow>(
      this.runner,
      this.runner.db.selectFrom('outline_node').selectAll().where('id', '=', id)
    )
    return row ? mapOutline(row) : null
  }

  listByProject(projectId: string): OutlineNodeRecord[] {
    const rows = allRows<OutlineRow>(
      this.runner,
      this.runner.db
        .selectFrom('outline_node')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('kind')
        .orderBy('ord')
    )
    return rows.map(mapOutline)
  }

  children(parentId: string): OutlineNodeRecord[] {
    const rows = allRows<OutlineRow>(
      this.runner,
      this.runner.db.selectFrom('outline_node').selectAll().where('parent_id', '=', parentId).orderBy('ord')
    )
    return rows.map(mapOutline)
  }

  /** 内容改动递增 version；排序与父子关系不在本方法里改。 */
  update(id: string, patch: OutlineNodePatch): OutlineNodeRecord {
    const update: UpdateObject<Database, 'outline_node'> = {}
    if (patch.title !== undefined) update.title = patch.title
    if (patch.content !== undefined) update.content = patch.content
    if (patch.status !== undefined) update.status = patch.status
    if (Object.keys(update).length > 0) {
      update.version = sql`version + 1`
      update.updated_at = this.now()
      runStatement(this.runner, this.runner.db.updateTable('outline_node').set(update).where('id', '=', id))
    }
    return this.get(id)!
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('outline_node').where('id', '=', id))
  }
}
