import { sql, type Insertable, type Selectable, type Updateable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { firstRow, runStatement } from '../kysely'
import type { ProjectTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type Pov = 'first' | 'third_limited' | 'third_omniscient'
export type ProjectStatus = 'active' | 'archived'
export type SetupState = 'pending' | 'complete' | 'failed'
export type ModelPreset = 'openai' | 'deepseek' | 'tongyi'

export interface ProjectRecord {
  id: string
  title: string
  genre: string
  pov: Pov
  targetWords: number | null
  status: ProjectStatus
  setupState: SetupState
  embeddingModel: string
  embeddingDim: number
  defaultPreset: ModelPreset
  seqHead: number
  writeEpoch: number
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

export interface NewProjectInput {
  id?: string
  title: string
  genre?: string
  pov: Pov
  targetWords?: number | null
  status?: ProjectStatus
  setupState?: SetupState
  embeddingModel: string
  embeddingDim: number
  defaultPreset: ModelPreset
  schemaVersion: number
  createdAt?: string
  updatedAt?: string
}

export interface ProjectMetaPatch {
  title?: string
  genre?: string
  targetWords?: number | null
}

type ProjectRow = Selectable<ProjectTable>

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    pov: row.pov as Pov,
    targetWords: row.target_words,
    status: row.status as ProjectStatus,
    setupState: row.setup_state as SetupState,
    embeddingModel: row.embedding_model,
    embeddingDim: row.embedding_dim,
    defaultPreset: row.default_preset as ModelPreset,
    seqHead: row.seq_head,
    writeEpoch: row.write_epoch,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 一个项目文件只有一行 project（DEV-PLAN §5.5）。 */
export class ProjectRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  get(): ProjectRecord | null {
    const row = firstRow<ProjectRow>(
      this.runner,
      this.runner.db.selectFrom('project').selectAll().limit(1)
    )
    return row ? mapProject(row) : null
  }

  getById(id: string): ProjectRecord | null {
    const row = firstRow<ProjectRow>(
      this.runner,
      this.runner.db.selectFrom('project').selectAll().where('id', '=', id)
    )
    return row ? mapProject(row) : null
  }

  create(input: NewProjectInput): ProjectRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('prj')
    const values: Insertable<ProjectTable> = {
      id,
      title: input.title,
      genre: input.genre ?? '',
      pov: input.pov,
      target_words: input.targetWords ?? null,
      status: input.status ?? 'active',
      setup_state: input.setupState ?? 'pending',
      embedding_model: input.embeddingModel,
      embedding_dim: input.embeddingDim,
      default_preset: input.defaultPreset,
      schema_version: input.schemaVersion,
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('project').values(values))
    return this.getById(id)!
  }

  updateMeta(id: string, patch: ProjectMetaPatch): ProjectRecord {
    const update: Updateable<ProjectTable> = {}
    if (patch.title !== undefined) update.title = patch.title
    if (patch.genre !== undefined) update.genre = patch.genre
    if (patch.targetWords !== undefined) update.target_words = patch.targetWords
    if (Object.keys(update).length > 0) {
      update.updated_at = this.now()
      runStatement(this.runner, this.runner.db.updateTable('project').set(update).where('id', '=', id))
    }
    return this.getById(id)!
  }

  setSchemaVersion(id: string, version: number): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('project')
        .set({ schema_version: version, updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  setSetupState(id: string, state: SetupState): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('project')
        .set({ setup_state: state, updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  setStatus(id: string, status: ProjectStatus): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('project').set({ status, updated_at: this.now() }).where('id', '=', id)
    )
  }

  /** write_epoch 只在回退、重开定稿、导入外部版本时 +1（DEV-PLAN §9.2）。 */
  incrementWriteEpoch(id: string): number {
    const row = firstRow<{ write_epoch: number }>(
      this.runner,
      this.runner.db
        .updateTable('project')
        .set({ write_epoch: sql`write_epoch + 1`, updated_at: this.now() })
        .where('id', '=', id)
        .returning('write_epoch')
    )
    if (!row) throw new Error(`project ${id} not found`)
    return row.write_epoch
  }

  finalizedChapterCount(): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('status', '=', 'finalized')
    )
    return row?.count ?? 0
  }

  finalizedWordCount(): number {
    const row = firstRow<{ words: number }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .innerJoin('chapter', 'chapter.id', 'beat.chapter_id')
        .select(sql<number>`coalesce(sum(beat.word_count), 0)`.as('words'))
        .where('chapter.status', '=', 'finalized')
        .where('beat.status', '<>', 'superseded')
    )
    return row?.words ?? 0
  }
}
