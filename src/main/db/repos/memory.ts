import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { MemoryEntryTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type MemoryKind = 'experience' | 'fact' | 'relationship' | 'cognition'
export type MemoryStatus = 'active' | 'inactive' | 'superseded'

export interface MemoryEntryRecord {
  id: string
  projectId: string
  characterId: string
  kind: MemoryKind
  text: string
  learnedSeq: number
  sourceChapterId: string
  sourceRevisionId: string
  sourceBeatId: string | null
  importance: number
  pinned: number
  validFromSeq: number | null
  validToSeq: number | null
  supersedesId: string | null
  embeddingModel: string
  status: MemoryStatus
  createdAt: string
}

export interface NewMemoryEntryInput {
  id?: string
  projectId: string
  characterId: string
  kind: MemoryKind
  text: string
  learnedSeq: number
  sourceChapterId: string
  sourceRevisionId: string
  sourceBeatId?: string | null
  importance?: number
  pinned?: number
  validFromSeq?: number | null
  validToSeq?: number | null
  supersedesId?: string | null
  embeddingModel: string
  status?: MemoryStatus
  createdAt?: string
}

type MemoryRow = Selectable<MemoryEntryTable>

function mapMemory(row: MemoryRow): MemoryEntryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    kind: row.kind as MemoryKind,
    text: row.text,
    learnedSeq: row.learned_seq,
    sourceChapterId: row.source_chapter_id,
    sourceRevisionId: row.source_revision_id,
    sourceBeatId: row.source_beat_id,
    importance: row.importance,
    pinned: row.pinned,
    validFromSeq: row.valid_from_seq,
    validToSeq: row.valid_to_seq,
    supersedesId: row.supersedes_id,
    embeddingModel: row.embedding_model,
    status: row.status as MemoryStatus,
    createdAt: row.created_at
  }
}

/**
 * 记忆不物理删除：退出召回靠 status + valid_to_seq（DEV-PLAN §10）。
 * learned_seq 由调用方传入来源拍 seq，本类不分配 seq。
 */
export class MemoryRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewMemoryEntryInput): MemoryEntryRecord {
    const id = input.id ?? newId('mem')
    const values: Insertable<MemoryEntryTable> = {
      id,
      project_id: input.projectId,
      character_id: input.characterId,
      kind: input.kind,
      text: input.text,
      learned_seq: input.learnedSeq,
      source_chapter_id: input.sourceChapterId,
      source_revision_id: input.sourceRevisionId,
      source_beat_id: input.sourceBeatId ?? null,
      importance: input.importance ?? 0.5,
      pinned: input.pinned ?? 0,
      valid_from_seq: input.validFromSeq ?? null,
      valid_to_seq: input.validToSeq ?? null,
      supersedes_id: input.supersedesId ?? null,
      embedding_model: input.embeddingModel,
      status: input.status ?? 'active',
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_entry').values(values))
    return this.get(id)!
  }

  get(id: string): MemoryEntryRecord | null {
    const row = firstRow<MemoryRow>(
      this.runner,
      this.runner.db.selectFrom('memory_entry').selectAll().where('id', '=', id)
    )
    return row ? mapMemory(row) : null
  }

  listByCharacter(characterId: string, options: { status?: MemoryStatus } = {}): MemoryEntryRecord[] {
    let query = this.runner.db
      .selectFrom('memory_entry')
      .selectAll()
      .where('character_id', '=', characterId)
      .orderBy('learned_seq')
    if (options.status) query = query.where('status', '=', options.status)
    return allRows<MemoryRow>(this.runner, query).map(mapMemory)
  }

  /** 隔离自检用：项目全量条目（只返回 ID 级信息，供跨角色探针核对）。 */
  listByProject(projectId: string, options: { status?: MemoryStatus } = {}): MemoryEntryRecord[] {
    let query = this.runner.db
      .selectFrom('memory_entry')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('learned_seq')
    if (options.status) query = query.where('status', '=', options.status)
    return allRows<MemoryRow>(this.runner, query).map(mapMemory)
  }

  listBySource(chapterId: string): MemoryEntryRecord[] {
    const rows = allRows<MemoryRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_entry')
        .selectAll()
        .where('source_chapter_id', '=', chapterId)
        .orderBy('learned_seq')
    )
    return rows.map(mapMemory)
  }

  setStatus(id: string, status: MemoryStatus): void {
    runStatement(this.runner, this.runner.db.updateTable('memory_entry').set({ status }).where('id', '=', id))
  }

  /** 取代链：新条目写 supersedes_id，旧条目软失效（C6 由唯一索引兜底）。 */
  supersede(oldId: string, newIdValue: string): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('memory_entry').set({ status: 'superseded' }).where('id', '=', oldId)
    )
    runStatement(
      this.runner,
      this.runner.db.updateTable('memory_entry').set({ supersedes_id: oldId }).where('id', '=', newIdValue)
    )
  }

  closeValidity(id: string, seq: number): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('memory_entry').set({ valid_to_seq: seq }).where('id', '=', id)
    )
  }
}
