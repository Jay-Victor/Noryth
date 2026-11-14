import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { BeatTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type SpeakerType = 'character' | 'narrator'
export type BeatStatus =
  | 'proposed'
  | 'generating'
  | 'draft'
  | 'waiting_for_human'
  | 'confirmed'
  | 'regenerating'
  | 'rejected'
  | 'author_edited'
  | 'stale'
  | 'superseded'
  | 'interrupted'
export type DecidedBy = 'author' | 'auto'

export interface BeatRecord {
  id: string
  chapterId: string
  sceneId: string
  ord: number
  seq: number | null
  speakerType: SpeakerType
  speakerId: string
  intent: string
  body: string
  groundingJson: string
  traceRef: string | null
  status: BeatStatus
  supersedesId: string | null
  createdRevisionId: string
  maxWords: number | null
  wordCount: number
  authorEdited: number
  decidedBy: DecidedBy | null
  createdAt: string
  updatedAt: string
}

export interface NewBeatInput {
  id?: string
  chapterId: string
  sceneId: string
  ord: number
  seq?: number | null
  speakerType: SpeakerType
  speakerId: string
  intent?: string
  body?: string
  groundingJson?: string
  traceRef?: string | null
  status: BeatStatus
  supersedesId?: string | null
  createdRevisionId: string
  maxWords?: number | null
  wordCount?: number
  authorEdited?: number
  decidedBy?: DecidedBy | null
  createdAt?: string
  updatedAt?: string
}

type BeatRow = Selectable<BeatTable>

function mapBeat(row: BeatRow): BeatRecord {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    sceneId: row.scene_id,
    ord: row.ord,
    seq: row.seq,
    speakerType: row.speaker_type as SpeakerType,
    speakerId: row.speaker_id,
    intent: row.intent,
    body: row.body,
    groundingJson: row.grounding_json,
    traceRef: row.trace_ref,
    status: row.status as BeatStatus,
    supersedesId: row.supersedes_id,
    createdRevisionId: row.created_revision_id,
    maxWords: row.max_words,
    wordCount: row.word_count,
    authorEdited: row.author_edited,
    decidedBy: row.decided_by as DecidedBy | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * beat 是 append-only 的正文版本表（DEV-PLAN §5.4）。
 * 本类只提供 INSERT 与状态/元数据更新：正文一旦写入不再 UPDATE，
 * 修改必须新增一行 beat 并 supersede 旧行（阶段 07 的 DocController 负责）。
 */
export class BeatRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewBeatInput): BeatRecord {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? newId('bt')
    const values: Insertable<BeatTable> = {
      id,
      chapter_id: input.chapterId,
      scene_id: input.sceneId,
      ord: input.ord,
      seq: input.seq ?? null,
      speaker_type: input.speakerType,
      speaker_id: input.speakerId,
      intent: input.intent ?? '',
      body: input.body ?? '',
      grounding_json: input.groundingJson ?? '[]',
      trace_ref: input.traceRef ?? null,
      status: input.status,
      supersedes_id: input.supersedesId ?? null,
      created_revision_id: input.createdRevisionId,
      max_words: input.maxWords ?? null,
      word_count: input.wordCount ?? 0,
      author_edited: input.authorEdited ?? 0,
      decided_by: input.decidedBy ?? null,
      created_at: at,
      updated_at: input.updatedAt ?? at
    }
    runStatement(this.runner, this.runner.db.insertInto('beat').values(values))
    return this.get(id)!
  }

  get(id: string): BeatRecord | null {
    const row = firstRow<BeatRow>(
      this.runner,
      this.runner.db.selectFrom('beat').selectAll().where('id', '=', id)
    )
    return row ? mapBeat(row) : null
  }

  listByChapter(chapterId: string): BeatRecord[] {
    const rows = allRows<BeatRow>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('scene_id')
        .orderBy('ord')
    )
    return rows.map(mapBeat)
  }

  /** 按章内场景顺序 + 拍序读取现行版本（C2 的读取侧）。 */
  listLiveByChapter(chapterId: string): BeatRecord[] {
    const rows = allRows<BeatRow>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .innerJoin('chapter_scene', (join) =>
          join
            .onRef('chapter_scene.chapter_id', '=', 'beat.chapter_id')
            .onRef('chapter_scene.scene_id', '=', 'beat.scene_id')
        )
        .selectAll('beat')
        .where('beat.chapter_id', '=', chapterId)
        .where('beat.status', '<>', 'superseded')
        .orderBy('chapter_scene.ord')
        .orderBy('beat.ord')
    )
    return rows.map(mapBeat)
  }

  listLiveByScene(sceneId: string): BeatRecord[] {
    const rows = allRows<BeatRow>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .selectAll()
        .where('scene_id', '=', sceneId)
        .where('status', '<>', 'superseded')
        .orderBy('ord')
    )
    return rows.map(mapBeat)
  }

  /** 只改状态，不碰正文；C3 由 beat_supersedes_once 唯一索引兜底。 */
  markSuperseded(id: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('beat')
        .set({ status: 'superseded', updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  setStatus(id: string, status: BeatStatus, decidedBy: DecidedBy | null = null): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('beat')
        .set({ status, decided_by: decidedBy, updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  nextOrd(sceneId: string): number {
    const row = firstRow<{ ord: number | null }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .select((eb) => eb.fn.max('ord').as('ord'))
        .where('scene_id', '=', sceneId)
        .where('status', '<>', 'superseded')
    )
    return (row?.ord ?? 0) + 1
  }

  countLive(chapterId: string): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('beat')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('chapter_id', '=', chapterId)
        .where('status', '<>', 'superseded')
    )
    return row?.count ?? 0
  }

  /** 启动扫描用：按状态找卡住的拍（DEV-PLAN §9.4 / PRD §6.6）。 */
  listByStatuses(statuses: readonly BeatStatus[]): BeatRecord[] {
    if (statuses.length === 0) return []
    const rows = allRows<BeatRow>(
      this.runner,
      this.runner.db.selectFrom('beat').selectAll().where('status', 'in', statuses as BeatStatus[])
    )
    return rows.map(mapBeat)
  }
}
