import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ChapterTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type ChapterStatus =
  | 'planned'
  | 'storyboard_ready'
  | 'drafting'
  | 'draft_complete'
  | 'under_review'
  | 'revising'
  | 'approved'
  | 'finalized'
  | 'paused'
  | 'abandoned'

export interface ChapterRecord {
  id: string
  projectId: string
  outlineNodeId: string
  ord: number
  status: ChapterStatus
  coveredUntilSeq: number
  currentRevisionId: string | null
  finalRevisionId: string | null
  openedAt: string | null
  finalizedAt: string | null
  budgetTokens: number | null
}

export interface NewChapterInput {
  id?: string
  projectId: string
  outlineNodeId: string
  ord: number
  status?: ChapterStatus
  coveredUntilSeq?: number
  currentRevisionId?: string | null
  finalRevisionId?: string | null
  openedAt?: string | null
  finalizedAt?: string | null
}

/** 章节列表行（PHASE-11 M1-9）：只有摘要，没有正文。 */
export interface ChapterSummaryRecord {
  id: string
  ord: number
  title: string
  status: ChapterStatus
  sceneCount: number
  beatCount: number
  confirmedCount: number
  wordCount: number
  finalized: boolean
}

interface ChapterSummaryRow {
  id: string
  ord: number
  status: string
  final_revision_id: string | null
  title: string | null
  beat_count: number
  confirmed_count: number
  word_count: number | null
}

type ChapterRow = Selectable<ChapterTable>

function mapChapter(row: ChapterRow): ChapterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    outlineNodeId: row.outline_node_id,
    ord: row.ord,
    status: row.status as ChapterStatus,
    coveredUntilSeq: row.covered_until_seq,
    currentRevisionId: row.current_revision_id,
    finalRevisionId: row.final_revision_id,
    openedAt: row.opened_at,
    finalizedAt: row.finalized_at,
    budgetTokens: row.budget_tokens
  }
}

export class ChapterRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewChapterInput): ChapterRecord {
    const id = input.id ?? newId('ch')
    const values: Insertable<ChapterTable> = {
      id,
      project_id: input.projectId,
      outline_node_id: input.outlineNodeId,
      ord: input.ord,
      status: input.status ?? 'planned',
      covered_until_seq: input.coveredUntilSeq ?? 0,
      current_revision_id: input.currentRevisionId ?? null,
      final_revision_id: input.finalRevisionId ?? null,
      opened_at: input.openedAt ?? null,
      finalized_at: input.finalizedAt ?? null
    }
    runStatement(this.runner, this.runner.db.insertInto('chapter').values(values))
    return this.get(id)!
  }

  get(id: string): ChapterRecord | null {
    const row = firstRow<ChapterRow>(
      this.runner,
      this.runner.db.selectFrom('chapter').selectAll().where('id', '=', id)
    )
    return row ? mapChapter(row) : null
  }

  listByProject(projectId: string): ChapterRecord[] {
    const rows = allRows<ChapterRow>(
      this.runner,
      this.runner.db.selectFrom('chapter').selectAll().where('project_id', '=', projectId).orderBy('ord')
    )
    return rows.map(mapChapter)
  }

  /**
   * 章节列表摘要（PHASE-11 M1-9）：只取计数，不加载任何正文。
   *
   * 30 章 × 3 场 × 8 拍的规模下，逐章 `listLiveByChapter` 会把 14 万字全部
   * 读进内存（每次切章都重来一遍）。这里固定两条聚合查询，和章数无关。
   */
  listSummaries(projectId: string): ChapterSummaryRecord[] {
    const rows = allRows<ChapterSummaryRow>(
      this.runner,
      this.runner.db
        .selectFrom('chapter')
        .leftJoin('outline_node', 'outline_node.id', 'chapter.outline_node_id')
        .leftJoin('beat', (join) =>
          join.onRef('beat.chapter_id', '=', 'chapter.id').on('beat.status', '<>', 'superseded')
        )
        .select([
          'chapter.id as id',
          'chapter.ord as ord',
          'chapter.status as status',
          'chapter.final_revision_id as final_revision_id',
          'outline_node.title as title',
          (eb) => eb.fn.count<number>('beat.id').as('beat_count'),
          (eb) =>
            eb.fn
              .count<number>('beat.id')
              .filterWhere('beat.status', 'in', ['confirmed', 'author_edited'])
              .as('confirmed_count'),
          (eb) => eb.fn.coalesce(eb.fn.sum<number>('beat.word_count'), eb.val(0)).as('word_count')
        ])
        .where('chapter.project_id', '=', projectId)
        .groupBy([
          'chapter.id',
          'chapter.ord',
          'chapter.status',
          'chapter.final_revision_id',
          'outline_node.title'
        ])
        .orderBy('chapter.ord')
    )

    const sceneRows = allRows<{ chapter_id: string; scene_count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_scene')
        .innerJoin('chapter', 'chapter.id', 'chapter_scene.chapter_id')
        .select([
          'chapter_scene.chapter_id as chapter_id',
          (eb) => eb.fn.countAll<number>().as('scene_count')
        ])
        .where('chapter.project_id', '=', projectId)
        .groupBy('chapter_scene.chapter_id')
    )
    const scenes = new Map(sceneRows.map((row) => [row.chapter_id, Number(row.scene_count)]))

    return rows.map((row) => ({
      id: row.id,
      ord: row.ord,
      status: row.status as ChapterStatus,
      title: row.title ?? `第 ${row.ord} 章`,
      sceneCount: scenes.get(row.id) ?? 0,
      beatCount: Number(row.beat_count),
      confirmedCount: Number(row.confirmed_count),
      wordCount: Number(row.word_count),
      finalized: row.final_revision_id !== null
    }))
  }

  setStatus(id: string, status: ChapterStatus): void {
    runStatement(this.runner, this.runner.db.updateTable('chapter').set({ status }).where('id', '=', id))
  }

  setCurrentRevision(id: string, revisionId: string | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ current_revision_id: revisionId }).where('id', '=', id)
    )
  }

  setFinalRevision(id: string, revisionId: string | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ final_revision_id: revisionId }).where('id', '=', id)
    )
  }

  setCoveredUntilSeq(id: string, seq: number): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ covered_until_seq: seq }).where('id', '=', id)
    )
  }

  /** 章预算（DEV-PLAN §8.5）：null = 用创作台默认值。 */
  setBudgetTokens(id: string, budgetTokens: number | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ budget_tokens: budgetTokens }).where('id', '=', id)
    )
  }

  markOpened(id: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ opened_at: this.now() })
        .where('id', '=', id)
        .where('opened_at', 'is', null)
    )
  }

  markFinalized(id: string, revisionId: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ status: 'finalized', final_revision_id: revisionId, finalized_at: this.now() })
        .where('id', '=', id)
    )
  }
}
