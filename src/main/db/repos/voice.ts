import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { VoiceMetricTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export interface VoiceMetricRecord {
  id: string
  projectId: string
  chapterId: string
  sceneId: string
  revisionId: string
  metricsJson: string
  thresholdVersion: string
  createdAt: string
}

export interface NewVoiceMetricInput {
  id?: string
  projectId: string
  chapterId: string
  sceneId: string
  revisionId: string
  metricsJson: string
  thresholdVersion: string
  createdAt?: string
}

type VoiceRow = Selectable<VoiceMetricTable>

function mapVoice(row: VoiceRow): VoiceMetricRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    sceneId: row.scene_id,
    revisionId: row.revision_id,
    metricsJson: row.metrics_json,
    thresholdVersion: row.threshold_version,
    createdAt: row.created_at
  }
}

/**
 * 声音指标缓存（PHASE-19 §5.4）：只做行级读写，不判断「该不该算」。
 * 唯一键是 `(scene_id, revision_id)`；重算覆盖同一行，不追加历史。
 */
export class VoiceMetricRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  /** 同 (scene, revision) 覆盖；返回值是覆盖后的行。 */
  upsert(input: NewVoiceMetricInput): VoiceMetricRecord {
    const existing = this.getBySceneRevision(input.sceneId, input.revisionId)
    const createdAt = input.createdAt ?? this.now()
    if (existing) {
      runStatement(
        this.runner,
        this.runner.db
          .updateTable('voice_metric')
          .set({
            metrics_json: input.metricsJson,
            threshold_version: input.thresholdVersion,
            created_at: createdAt
          })
          .where('id', '=', existing.id)
      )
      return this.get(existing.id)!
    }
    const id = input.id ?? newId('vm')
    const values: Insertable<VoiceMetricTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      scene_id: input.sceneId,
      revision_id: input.revisionId,
      metrics_json: input.metricsJson,
      threshold_version: input.thresholdVersion,
      created_at: createdAt
    }
    runStatement(this.runner, this.runner.db.insertInto('voice_metric').values(values))
    return this.get(id)!
  }

  get(id: string): VoiceMetricRecord | null {
    const row = firstRow<VoiceRow>(
      this.runner,
      this.runner.db.selectFrom('voice_metric').selectAll().where('id', '=', id)
    )
    return row ? mapVoice(row) : null
  }

  getBySceneRevision(sceneId: string, revisionId: string): VoiceMetricRecord | null {
    const row = firstRow<VoiceRow>(
      this.runner,
      this.runner.db
        .selectFrom('voice_metric')
        .selectAll()
        .where('scene_id', '=', sceneId)
        .where('revision_id', '=', revisionId)
    )
    return row ? mapVoice(row) : null
  }

  /** 场景最近一行（可能对应旧 revision，用于 stale 判定与展示）。 */
  latestByScene(sceneId: string): VoiceMetricRecord | null {
    const row = firstRow<VoiceRow>(
      this.runner,
      this.runner.db
        .selectFrom('voice_metric')
        .selectAll()
        .where('scene_id', '=', sceneId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
    )
    return row ? mapVoice(row) : null
  }

  listByChapter(projectId: string, chapterId: string): VoiceMetricRecord[] {
    const rows = allRows<VoiceRow>(
      this.runner,
      this.runner.db
        .selectFrom('voice_metric')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('chapter_id', '=', chapterId)
        .orderBy('scene_id')
        .orderBy('created_at')
    )
    return rows.map(mapVoice)
  }
}
