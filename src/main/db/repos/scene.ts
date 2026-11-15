import type { Insertable, Selectable, UpdateObject } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { Database, SceneTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type SceneStatus = 'planned' | 'open' | 'closing' | 'closed' | 'paused'
/** 时间轴（PHASE-12 M1-2）：main 参与故事时间；flashback / dream 永不参与。 */
export type SceneTimeline = 'main' | 'flashback' | 'dream'
export const SCENE_TIMELINES: readonly SceneTimeline[] = ['main', 'flashback', 'dream']

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
  storyStart: string | null
  storyEnd: string | null
  timeline: SceneTimeline
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
  storyStart?: string | null
  storyEnd?: string | null
  timeline?: SceneTimeline
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
  /** undefined = 不改；null = 清空。 */
  storyStart?: string | null
  storyEnd?: string | null
  timeline?: SceneTimeline
}

export interface SceneInChapter {
  scene: SceneRecord
  chapterOrd: number
}

/** 场景被哪些章链接（`chapter_scene` 是章内顺序的唯一真相）。 */
export interface SceneChapterLink {
  sceneId: string
  chapterId: string
  chapterOrd: number
  /** 章内顺序。 */
  ord: number
}

/** 场景的「演出归属」：live 拍属于哪一章。 */
export interface SceneUsage {
  sceneId: string
  chapterId: string
  chapterOrd: number
  liveBeats: number
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
    storyStart: row.story_start,
    storyEnd: row.story_end,
    timeline: row.timeline as SceneTimeline,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 场景 repo：只做查询与行级写入，不判断「能不能链接/能不能 fork」。
 * 多对多语义（PHASE-12 §5.1）在 `scheduler/scene-library.ts` 判定。
 */

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
      story_start: input.storyStart ?? null,
      story_end: input.storyEnd ?? null,
      ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
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

  /** 场景被哪些章链接（含章序与章内顺序）；供演出唯一性与场景库使用。 */
  listChaptersByScene(sceneId: string): SceneChapterLink[] {
    const rows = allRows<{ scene_id: string; chapter_id: string; chapter_ord: number; ord: number }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_scene')
        .innerJoin('chapter', 'chapter.id', 'chapter_scene.chapter_id')
        .select([
          'chapter_scene.scene_id as scene_id',
          'chapter_scene.chapter_id as chapter_id',
          'chapter_scene.ord as ord',
          'chapter.ord as chapter_ord'
        ])
        .where('chapter_scene.scene_id', '=', sceneId)
        .orderBy('chapter.ord')
    )
    return rows.map((row) => ({
      sceneId: row.scene_id,
      chapterId: row.chapter_id,
      chapterOrd: row.chapter_ord,
      ord: row.ord
    }))
  }

  /** 项目内所有章↔场景链接（场景库一次性读，避免逐场查询）。 */
  listLinksByProject(projectId: string): SceneChapterLink[] {
    const rows = allRows<{ scene_id: string; chapter_id: string; chapter_ord: number; ord: number }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_scene')
        .innerJoin('scene', 'scene.id', 'chapter_scene.scene_id')
        .innerJoin('chapter', 'chapter.id', 'chapter_scene.chapter_id')
        .select([
          'chapter_scene.scene_id as scene_id',
          'chapter_scene.chapter_id as chapter_id',
          'chapter_scene.ord as ord',
          'chapter.ord as chapter_ord'
        ])
        .where('scene.project_id', '=', projectId)
        .orderBy('chapter.ord')
        .orderBy('chapter_scene.ord')
    )
    return rows.map((row) => ({
      sceneId: row.scene_id,
      chapterId: row.chapter_id,
      chapterOrd: row.chapter_ord,
      ord: row.ord
    }))
  }

  /**
   * 场景的 live 拍归属（按章分组）。
   * 正常项目里一个场景最多一行；多于一行说明跨章共享正文，由 `db.verify()` 拦截。
   */
  listUsageByProject(projectId: string): SceneUsage[] {
    const rows = allRows<{ scene_id: string; chapter_id: string; chapter_ord: number; count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .innerJoin('scene', 'scene.id', 'beat.scene_id')
        .innerJoin('chapter', 'chapter.id', 'beat.chapter_id')
        .select([
          'beat.scene_id as scene_id',
          'beat.chapter_id as chapter_id',
          'chapter.ord as chapter_ord'
        ])
        .select((eb) => eb.fn.count('beat.id').as('count'))
        .where('scene.project_id', '=', projectId)
        .where('beat.status', '<>', 'superseded')
        .groupBy(['beat.scene_id', 'beat.chapter_id', 'chapter.ord'])
    )
    return rows.map((row) => ({
      sceneId: row.scene_id,
      chapterId: row.chapter_id,
      chapterOrd: row.chapter_ord,
      liveBeats: Number(row.count)
    }))
  }

  /** 场景是否有 live 拍（= 已在某章演出）。 */
  liveBeatCount(sceneId: string): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .select((eb) => eb.fn.count('beat.id').as('count'))
        .where('scene_id', '=', sceneId)
        .where('status', '<>', 'superseded')
    )
    return Number(row?.count ?? 0)
  }

  /** 场景的演出章；未演出返回 null。 */
  ownerChapter(sceneId: string): { chapterId: string; chapterOrd: number } | null {
    const row = firstRow<{ chapter_id: string; chapter_ord: number }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .innerJoin('chapter', 'chapter.id', 'beat.chapter_id')
        .select(['beat.chapter_id as chapter_id', 'chapter.ord as chapter_ord'])
        .where('beat.scene_id', '=', sceneId)
        .where('beat.status', '<>', 'superseded')
        .groupBy(['beat.chapter_id', 'chapter.ord'])
        .orderBy('chapter.ord')
        .limit(1)
    )
    return row ? { chapterId: row.chapter_id, chapterOrd: row.chapter_ord } : null
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

  /** 解链后重排，保持 1..n 连续（PK 是 (chapter_id, ord)）。 */
  replaceChapterOrder(chapterId: string, sceneIds: readonly string[]): void {
    runStatement(this.runner, this.runner.db.deleteFrom('chapter_scene').where('chapter_id', '=', chapterId))
    sceneIds.forEach((sceneId, index) => this.linkToChapter(chapterId, sceneId, index + 1))
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
    if (patch.storyStart !== undefined) update.story_start = patch.storyStart
    if (patch.storyEnd !== undefined) update.story_end = patch.storyEnd
    if (patch.timeline !== undefined) update.timeline = patch.timeline
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
