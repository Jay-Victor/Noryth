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

  /**
   * 记忆浏览器的过滤（UI-DESIGN §7.4）：角色、类型、章节、状态、pin。
   * 全部条件进 SQL，不在 renderer 里做「先全量再筛」。
   */
  listFiltered(
    projectId: string,
    filter: {
      characterId?: string
      kind?: MemoryKind
      chapterId?: string
      status?: MemoryStatus | 'all'
      pinnedOnly?: boolean
    } = {}
  ): MemoryEntryRecord[] {
    let query = this.runner.db
      .selectFrom('memory_entry')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('learned_seq', 'desc')
      .orderBy('id')
    if (filter.characterId) query = query.where('character_id', '=', filter.characterId)
    if (filter.kind) query = query.where('kind', '=', filter.kind)
    if (filter.chapterId) query = query.where('source_chapter_id', '=', filter.chapterId)
    if (filter.status && filter.status !== 'all') query = query.where('status', '=', filter.status)
    if (filter.pinnedOnly === true) query = query.where('pinned', '=', 1)
    return allRows<MemoryRow>(this.runner, query).map(mapMemory)
  }

  /** pinned 独立成段（DEV-PLAN §10.4）：最多 5 条，不参与相关性排序。 */
  listPinned(characterId: string, asOf: number, limit = 5): MemoryEntryRecord[] {
    const rows = allRows<MemoryRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_entry')
        .selectAll()
        .where('character_id', '=', characterId)
        .where('pinned', '=', 1)
        .where('status', '=', 'active')
        .where('learned_seq', '<=', asOf)
        .orderBy('importance', 'desc')
        .orderBy('learned_seq', 'desc')
        .limit(limit)
    )
    return rows
      .map(mapMemory)
      .filter((entry) => entry.validToSeq === null || entry.validToSeq > asOf)
  }

  /** 软失效：标记错误 / 作者否决，不物理删除（PRD §6.4）。 */
  markInvalid(id: string, status: Extract<MemoryStatus, 'inactive' | 'superseded'> = 'inactive'): void {
    runStatement(this.runner, this.runner.db.updateTable('memory_entry').set({ status }).where('id', '=', id))
  }

  /**
   * 索引重建（PHASE-14 M1-20）：`embedding_model != 当前模型` 的 active 条目，分批取。
   * 只重建 active：inactive / superseded 不再参与召回，重算它们只烧 CPU。
   */
  listByModelMismatch(projectId: string, model: string, limit = 32): MemoryEntryRecord[] {
    const rows = allRows<MemoryRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_entry')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('status', '=', 'active')
        .where('embedding_model', '!=', model)
        .orderBy('learned_seq')
        .orderBy('id')
        .limit(Math.max(1, Math.min(200, Math.trunc(limit))))
    )
    return rows.map(mapMemory)
  }

  countByModelMismatch(projectId: string, model: string): number {
    const row = this.runner.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM memory_entry WHERE project_id = ? AND status = 'active' AND embedding_model != ?"
      )
      .get(projectId, model) as { count: number } | undefined
    return row?.count ?? 0
  }

  setEmbeddingModel(id: string, model: string): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('memory_entry').set({ embedding_model: model }).where('id', '=', id)
    )
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
