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
  /** 章级人民币预算（0013，PHASE-20 M2-3）；null = 默认 ¥5.00。 */
  budgetCny: number | null
  /** 蓝图变更后的跨章标脏（0009）；只提示，不改状态与正文。 */
  invalidatedAt: string | null
  invalidatedReason: string | null
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
  /** 蓝图变更标脏（PHASE-15）；只给提示，不改状态。 */
  invalidatedAt: string | null
}

interface ChapterSummaryRow {
  id: string
  ord: number
  status: string
  final_revision_id: string | null
  invalidated_at: string | null
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
    budgetTokens: row.budget_tokens,
    budgetCny: row.budget_cny,
    invalidatedAt: row.invalidated_at,
    invalidatedReason: row.invalidated_reason
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
          'chapter.invalidated_at as invalidated_at',
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
          'chapter.invalidated_at',
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
      finalized: row.final_revision_id !== null,
      invalidatedAt: row.invalidated_at
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

  /** 章级人民币预算（PHASE-20 M2-3）：null = 默认 ¥5.00；负数由 schema 与 CHECK 双层拒绝。 */
  setBudgetCny(id: string, budgetCny: number | null): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('chapter').set({ budget_cny: budgetCny }).where('id', '=', id)
    )
  }

  /**
   * 报表字数口径（PHASE-20 §5.5）：定稿章取 final revision 清单，
   * 其余章取 current revision；没有 revision 的章计 0，不读 live 拍。
   * 两次聚合（final / current）后按章择一，避免逐章查询。
   */
  wordCountsFromRevisions(projectId: string): Map<string, number> {
    const finalRows = allRows<{ chapter_id: string; words: number | null }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter')
        .innerJoin('revision_beat', 'revision_beat.revision_id', 'chapter.final_revision_id')
        .innerJoin('beat', 'beat.id', 'revision_beat.beat_id')
        .select([
          'chapter.id as chapter_id',
          (eb) => eb.fn.sum<number>('beat.word_count').as('words')
        ])
        .where('chapter.project_id', '=', projectId)
        .groupBy('chapter.id')
    )
    const currentRows = allRows<{ chapter_id: string; words: number | null }>(
      this.runner,
      this.runner.db
        .selectFrom('chapter')
        .innerJoin('revision_beat', 'revision_beat.revision_id', 'chapter.current_revision_id')
        .innerJoin('beat', 'beat.id', 'revision_beat.beat_id')
        .select([
          'chapter.id as chapter_id',
          (eb) => eb.fn.sum<number>('beat.word_count').as('words')
        ])
        .where('chapter.project_id', '=', projectId)
        .groupBy('chapter.id')
    )
    const counts = new Map<string, number>()
    for (const row of currentRows) counts.set(row.chapter_id, Number(row.words ?? 0))
    for (const row of finalRows) counts.set(row.chapter_id, Number(row.words ?? 0))
    return counts
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

  /**
   * 蓝图变更后的跨章标脏（PHASE-15 §5.2）。
   *
   * 只写两列：不改章状态、不建 revision、不动正文。已定稿章同样标记，
   * 因为「下游是否还符合新蓝图」需要作者自己判断。
   */
  markInvalidated(id: string, reason: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ invalidated_at: this.now(), invalidated_reason: reason })
        .where('id', '=', id)
    )
  }

  /** 作者选择「忽略」：清掉标记，正文与状态都不动。 */
  clearInvalidation(id: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('chapter')
        .set({ invalidated_at: null, invalidated_reason: null })
        .where('id', '=', id)
    )
  }
}
