import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { RevisionBeatTable, RevisionTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type RevisionKind = 'draft' | 'final'
export type RevisionCreatedBy = 'author' | 'doc_controller' | 'reviewer'

export interface RevisionRecord {
  id: string
  chapterId: string
  parentRevisionId: string | null
  kind: RevisionKind
  contentHash: string
  createdBy: RevisionCreatedBy
  note: string | null
  createdAt: string
}

export interface RevisionMemberRecord {
  revisionId: string
  beatId: string
  sceneOrd: number
  beatOrd: number
}

export interface ManifestMemberRecord extends RevisionMemberRecord {
  sceneId: string
  speakerType: 'character' | 'narrator'
  speakerId: string
  body: string
}

export interface NewRevisionInput {
  id?: string
  chapterId: string
  parentRevisionId?: string | null
  kind: RevisionKind
  contentHash: string
  createdBy: RevisionCreatedBy
  note?: string | null
  createdAt?: string
}

type RevisionRow = Selectable<RevisionTable>
type MemberRow = Selectable<RevisionBeatTable>
type ManifestRow = MemberRow & {
  scene_id: string
  speaker_type: string
  speaker_id: string
  body: string
}

function mapRevision(row: RevisionRow): RevisionRecord {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    parentRevisionId: row.parent_revision_id,
    kind: row.kind as RevisionKind,
    contentHash: row.content_hash,
    createdBy: row.created_by as RevisionCreatedBy,
    note: row.note,
    createdAt: row.created_at
  }
}

function mapMember(row: MemberRow): RevisionMemberRecord {
  return {
    revisionId: row.revision_id,
    beatId: row.beat_id,
    sceneOrd: row.scene_ord,
    beatOrd: row.beat_ord
  }
}

/**
 * revision 是不可变清单头，只 INSERT，无 UPDATE/DELETE（DEV-PLAN §5.4）。
 * content_hash 必须在插入前算好；插入后只能复算校验。
 */
export class RevisionRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewRevisionInput): RevisionRecord {
    const id = input.id ?? newId('rev')
    const values: Insertable<RevisionTable> = {
      id,
      chapter_id: input.chapterId,
      parent_revision_id: input.parentRevisionId ?? null,
      kind: input.kind,
      content_hash: input.contentHash,
      created_by: input.createdBy,
      note: input.note ?? null,
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('revision').values(values))
    return this.get(id)!
  }

  get(id: string): RevisionRecord | null {
    const row = firstRow<RevisionRow>(
      this.runner,
      this.runner.db.selectFrom('revision').selectAll().where('id', '=', id)
    )
    return row ? mapRevision(row) : null
  }

  listByChapter(chapterId: string): RevisionRecord[] {
    const rows = allRows<RevisionRow>(
      this.runner,
      this.runner.db
        .selectFrom('revision')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
    )
    return rows.map(mapRevision)
  }

  insertMembers(revisionId: string, members: readonly RevisionMemberRecord[]): void {
    if (members.length === 0) return
    const values: Insertable<RevisionBeatTable>[] = members.map((member) => ({
      revision_id: revisionId,
      beat_id: member.beatId,
      scene_ord: member.sceneOrd,
      beat_ord: member.beatOrd
    }))
    runStatement(this.runner, this.runner.db.insertInto('revision_beat').values(values))
  }

  listMembers(revisionId: string): RevisionMemberRecord[] {
    const rows = allRows<MemberRow>(
      this.runner,
      this.runner.db
        .selectFrom('revision_beat')
        .selectAll()
        .where('revision_id', '=', revisionId)
        .orderBy('scene_ord')
        .orderBy('beat_ord')
    )
    return rows.map(mapMember)
  }

  /** 清单成员 + 正文；仅供 hash 复算与渲染，不改变任何行。 */
  manifest(revisionId: string): ManifestMemberRecord[] {
    const rows = allRows<ManifestRow>(
      this.runner,
      this.runner.db
        .selectFrom('revision_beat')
        .innerJoin('beat', 'beat.id', 'revision_beat.beat_id')
        .select([
          'revision_beat.revision_id',
          'revision_beat.beat_id',
          'revision_beat.scene_ord',
          'revision_beat.beat_ord',
          'beat.scene_id',
          'beat.speaker_type',
          'beat.speaker_id',
          'beat.body'
        ])
        .where('revision_beat.revision_id', '=', revisionId)
        .orderBy('revision_beat.scene_ord')
        .orderBy('revision_beat.beat_ord')
    )
    return rows.map((row) => ({
      ...mapMember(row),
      sceneId: row.scene_id,
      speakerType: row.speaker_type as 'character' | 'narrator',
      speakerId: row.speaker_id,
      body: row.body
    }))
  }

  countMembers(revisionId: string): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('revision_beat')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('revision_id', '=', revisionId)
    )
    return row?.count ?? 0
  }
}
