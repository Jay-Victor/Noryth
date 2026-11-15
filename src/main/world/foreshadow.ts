import { AppError } from '../../shared/domain/app-error'
import type {
  ForeshadowCreateInput,
  ForeshadowListOpenOutput,
  ForeshadowState,
  ForeshadowUpdateInput,
  ForeshadowView
} from '../../shared/schema/foreshadow'
import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { ForeshadowRecord } from '../db/repos/foreshadow'

/**
 * 伏笔（PHASE-15 M1-10 / PRD §4.10 T22）。
 *
 * 只做作者标注与节奏提示：
 * - 距离 = 当前章 ord − 埋设章 ord（当前章早于埋设章时为 0）。
 * - 超过计划回收章仍未回收 → `overdue`，文案只说「已 N 章未回收」。
 * - 不产生任何闸门判定、不进检索、不参与审批报告。
 */

function chapterOrds(repos: Repos, projectId: string): Map<string, { ord: number; title: string }> {
  const result = new Map<string, { ord: number; title: string }>()
  for (const chapter of repos.chapter.listByProject(projectId)) {
    result.set(chapter.id, {
      ord: chapter.ord,
      title: repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`
    })
  }
  return result
}

function currentOrder(
  chapters: ChapterRecord[],
  chapterId: string | null | undefined
): { id: string | null; ord: number | null } {
  if (chapterId !== null && chapterId !== undefined) {
    const chapter = chapters.find((item) => item.id === chapterId)
    if (chapter) return { id: chapter.id, ord: chapter.ord }
  }
  const last = chapters[chapters.length - 1]
  return last ? { id: last.id, ord: last.ord } : { id: null, ord: null }
}

function viewOf(
  record: ForeshadowRecord,
  ords: Map<string, { ord: number; title: string }>,
  currentOrd: number | null
): ForeshadowView {
  const plantedOrd = record.plantedChapterId === null ? null : (ords.get(record.plantedChapterId)?.ord ?? null)
  const plannedOrd =
    record.plannedPayoffChapterId === null ? null : (ords.get(record.plannedPayoffChapterId)?.ord ?? null)
  const payoffOrd = record.payoffChapterId === null ? null : (ords.get(record.payoffChapterId)?.ord ?? null)
  const distance =
    plantedOrd === null || currentOrd === null ? 0 : Math.max(0, currentOrd - plantedOrd)
  const overdue = record.status === 'open' && plannedOrd !== null && currentOrd !== null && currentOrd > plannedOrd
  return {
    id: record.id,
    text: record.text,
    status: record.status,
    plantedChapterId: record.plantedChapterId,
    plantedOrd,
    plannedPayoffChapterId: record.plannedPayoffChapterId,
    plannedPayoffOrd: plannedOrd,
    payoffChapterId: record.payoffChapterId,
    payoffOrd,
    distance,
    overdue,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function requireRecord(repos: Repos, projectId: string, foreshadowId: string): ForeshadowRecord {
  const record = repos.foreshadow.get(foreshadowId)
  if (!record || record.projectId !== projectId) {
    throw new AppError('invalid_args', '伏笔不存在')
  }
  return record
}

function requireChapter(repos: Repos, projectId: string, chapterId: string): ChapterRecord {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter || chapter.projectId !== projectId) {
    throw new AppError('invalid_args', '伏笔引用的章节不存在')
  }
  return chapter
}

export function foreshadowState(
  repos: Repos,
  projectId: string,
  chapterId?: string | null,
  readOnly = false
): ForeshadowState {
  const chapters = repos.chapter.listByProject(projectId)
  const ords = chapterOrds(repos, projectId)
  const current = currentOrder(chapters, chapterId)
  const items = repos.foreshadow
    .listByProject(projectId)
    .map((record) => viewOf(record, ords, current.ord))
  return {
    readOnly,
    chapterId: current.id,
    chapterOrd: current.ord,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      ord: chapter.ord,
      title: ords.get(chapter.id)?.title ?? `第 ${chapter.ord} 章`
    })),
    items,
    openCount: items.filter((item) => item.status === 'open').length,
    closedCount: items.filter((item) => item.status === 'closed').length
  }
}

export function createForeshadow(repos: Repos, projectId: string, input: ForeshadowCreateInput): ForeshadowView {
  requireChapter(repos, projectId, input.plantedChapterId)
  if (input.plannedPayoffChapterId !== undefined && input.plannedPayoffChapterId !== null) {
    requireChapter(repos, projectId, input.plannedPayoffChapterId)
  }
  const record = repos.foreshadow.insert({
    projectId,
    text: input.text.trim(),
    plantedChapterId: input.plantedChapterId,
    plannedPayoffChapterId: input.plannedPayoffChapterId ?? null
  })
  const ords = chapterOrds(repos, projectId)
  const chapters = repos.chapter.listByProject(projectId)
  const current = currentOrder(chapters, record.plantedChapterId)
  return viewOf(record, ords, current.ord)
}

export function updateForeshadow(repos: Repos, projectId: string, input: ForeshadowUpdateInput): ForeshadowView {
  const record = requireRecord(repos, projectId, input.foreshadowId)
  if (input.text !== undefined && input.text.trim().length === 0) {
    throw new AppError('invalid_args', '伏笔文本不能为空')
  }
  if (input.plannedPayoffChapterId !== undefined && input.plannedPayoffChapterId !== null) {
    requireChapter(repos, projectId, input.plannedPayoffChapterId)
  }
  const updated = repos.foreshadow.update(record.id, {
    ...(input.text === undefined ? {} : { text: input.text.trim() }),
    ...(input.plannedPayoffChapterId === undefined ? {} : { plannedPayoffChapterId: input.plannedPayoffChapterId })
  })
  const ords = chapterOrds(repos, projectId)
  const chapters = repos.chapter.listByProject(projectId)
  return viewOf(updated, ords, currentOrder(chapters, updated.plantedChapterId).ord)
}

export function closeForeshadow(
  repos: Repos,
  projectId: string,
  input: { foreshadowId: string; payoffChapterId: string }
): ForeshadowView {
  const record = requireRecord(repos, projectId, input.foreshadowId)
  requireChapter(repos, projectId, input.payoffChapterId)
  if (record.status === 'closed') {
    throw new AppError('invalid_args', '这条伏笔已经回收')
  }
  const closed = repos.foreshadow.close(record.id, input.payoffChapterId)
  const ords = chapterOrds(repos, projectId)
  const chapters = repos.chapter.listByProject(projectId)
  return viewOf(closed, ords, currentOrder(chapters, closed.plantedChapterId).ord)
}

export function reopenForeshadow(repos: Repos, projectId: string, foreshadowId: string): ForeshadowView {
  const record = requireRecord(repos, projectId, foreshadowId)
  const reopened = repos.foreshadow.reopen(record.id)
  const ords = chapterOrds(repos, projectId)
  const chapters = repos.chapter.listByProject(projectId)
  return viewOf(reopened, ords, currentOrder(chapters, reopened.plantedChapterId).ord)
}

export function removeForeshadow(repos: Repos, projectId: string, foreshadowId: string): { removed: boolean } {
  requireRecord(repos, projectId, foreshadowId)
  repos.foreshadow.remove(foreshadowId)
  return { removed: true }
}

/** T22：只读，返回 open 列表 + 埋设章 + 距离；`as_of` 只影响「从哪一章算距离」。 */
export function listOpenForeshadow(
  repos: Repos,
  projectId: string,
  asOfChapterId?: string
): ForeshadowListOpenOutput {
  const chapters = repos.chapter.listByProject(projectId)
  const ords = chapterOrds(repos, projectId)
  const current = currentOrder(chapters, asOfChapterId)
  const items = repos.foreshadow.listOpen(projectId).map((record) => {
    const view = viewOf(record, ords, current.ord)
    return {
      id: view.id,
      text: view.text,
      status: view.status,
      planted_chapter_id: view.plantedChapterId,
      planted_chapter_ord: view.plantedOrd,
      distance: view.distance,
      planned_payoff_chapter_id: view.plannedPayoffChapterId,
      overdue: view.overdue,
      note:
        view.distance === 0
          ? '本章埋设'
          : view.overdue
            ? `已 ${view.distance} 章未回收（超计划）`
            : `已 ${view.distance} 章未回收`
    }
  })
  return {
    as_of_chapter_id: current.id,
    as_of_ord: current.ord,
    items
  }
}
