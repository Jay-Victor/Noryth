import type { Insertable, Selectable, UpdateObject } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { Database, SceneTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type SceneStatus = 'planned' | 'open' | 'closing' | 'closed' | 'paused'

export interface SceneRecord {
  id: string
  projectId: string
  ord: number
  location: string
  participantsJson: string
  goal: string
  entry: string
  exitJson: string
  status: SceneStatus
  maxBeats: number
  createdAt: string
  updatedAt: string
}

export interface NewSceneInput {
  id?: string
  projectId: string
  ord: number
  location: string
  participantsJson: string
  goal: string
  entry?: string
  exitJson: string
  status?: SceneStatus
  maxBeats?: number
  createdAt?: string
  updatedAt?: string
}

export interface ScenePatch {
  location?: string
  participantsJson?: string
  goal?: string
  entry?: string
  exitJson?: string
  status?: SceneStatus
  maxBeats?: number
  ord?: number
}

export interface SceneInChapter {
  scene: SceneRecord
  chapterOrd: number
}

type SceneRow = Selectable<SceneTable>
type SceneJoinRow = SceneRow & { chapter_ord: number }

function mapScene(row: SceneRow): SceneRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ord: row.ord,
    location: row.location,
    participantsJson: row.participants_json,
    goal: row.goal,
    entry: row.entry,
    exitJson: row.exit_json,
    status: row.status as SceneStatus,
    maxBeats: row.max_beats,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class SceneRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewSceneInput): SceneRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('scn')
    const values: Insertable<SceneTable> = {
      id,
      project_id: input.projectId,
      ord: input.ord,
      location: input.location,
      participants_json: input.participantsJson,
      goal: input.goal,
      entry: input.entry ?? '',
      exit_json: input.exitJson,
      status: input.status ?? 'planned',
      ...(input.maxBeats === undefined ? {} : { max_beats: input.maxBeats }),
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('scene').values(values))
    return this.get(id)!
  }

  get(id: string): SceneRecord | null {
    const row = firstRow<SceneRow>(
      this.runner,
      this.runner.db.selectFrom('scene').selectAll().where('id', '=', id)
    )
    return row ? mapScene(row) : null
  }

  listByProject(projectId: string): SceneRecord[] {
    const rows = allRows<SceneRow>(
      this.runner,
      this.runner.db.selectFrom('scene').selectAll().where('project_id', '=', projectId).orderBy('ord')
    )
    return rows.map(mapScene)
  }

  /** 章内场景按 chapter_scene.ord 排序（C1 的读取侧）。 */
  listByChapter(chapterId: string): SceneInChapter[] {
    const rows = allRows<SceneJoinRow>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_scene')
        .innerJoin('scene', 'scene.id', 'chapter_scene.scene_id')
        .selectAll('scene')
        .select('chapter_scene.ord as chapter_ord')
        .where('chapter_scene.chapter_id', '=', chapterId)
        .orderBy('chapter_scene.ord')
    )
    return rows.map((row) => ({ scene: mapScene(row), chapterOrd: row.chapter_ord }))
  }

  linkToChapter(chapterId: string, sceneId: string, ord: number): void {
    runStatement(
      this.runner,
      this.runner.db.insertInto('chapter_scene').values({ chapter_id: chapterId, scene_id: sceneId, ord })
    )
  }

  unlinkFromChapter(chapterId: string, sceneId: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .deleteFrom('chapter_scene')
        .where('chapter_id', '=', chapterId)
        .where('scene_id', '=', sceneId)
    )
  }

  update(id: string, patch: ScenePatch): SceneRecord {
    const update: UpdateObject<Database, 'scene'> = {}
    if (patch.location !== undefined) update.location = patch.location
    if (patch.participantsJson !== undefined) update.participants_json = patch.participantsJson
    if (patch.goal !== undefined) update.goal = patch.goal
    if (patch.entry !== undefined) update.entry = patch.entry
    if (patch.exitJson !== undefined) update.exit_json = patch.exitJson
    if (patch.status !== undefined) update.status = patch.status
    if (patch.maxBeats !== undefined) update.max_beats = patch.maxBeats
    if (patch.ord !== undefined) update.ord = patch.ord
    if (Object.keys(update).length > 0) {
      update.updated_at = this.now()
      runStatement(this.runner, this.runner.db.updateTable('scene').set(update).where('id', '=', id))
    }
    return this.get(id)!
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('scene').where('id', '=', id))
  }
}
