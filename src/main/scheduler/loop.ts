import { AppError } from '../../shared/domain/app-error'
import type { ExitEvalNode } from '../../shared/dsl/exit'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import type { SceneInChapter } from '../db/repos/scene'
import { recomputeCoveredUntilSeq } from '../db/seq'
import { evaluateExit, parseExitInput } from './dsl'
import { sceneTransition } from './transitions'

/**
 * 调度循环的判定核心（DEV-PLAN §8.2 / PHASE-07 F2/F3/F6/F7）。
 *
 * 这里只回答「下一步做什么」，不调用模型、不写正文；真正的发牌在 auto.ts / service.ts。
 * 所有停止条件都必须能在不调模型的情况下判定，否则自动模式会烧钱。
 */

export const DEFAULT_CHAPTER_BUDGET_TOKENS = 120_000

export type PauseReason =
  | 'exit_satisfied'
  | 'max_beats'
  | 'budget_exceeded'
  | 'character_refusal'
  | 'storyboard_exhausted'
  | 'model_error'
  | 'author_paused'
  | 'gate_required'
  | 'draft_complete'

export const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  exit_satisfied: '出口条件已满足，场景收束',
  max_beats: '已达场景拍数上限，按 WARN 收束',
  budget_exceeded: '本章预算已用尽，自动模式暂停',
  character_refusal: '角色拒演：分镜与角色卡冲突，需要作者裁决',
  storyboard_exhausted: '分镜耗尽但出口未满足，请补分镜',
  model_error: '模型调用失败，已暂停当前拍',
  author_paused: '作者暂停',
  gate_required: '需要闸门确认',
  draft_complete: '本章草稿完成'
}

export interface SceneProgress {
  sceneId: string
  chapterOrd: number
  location: string
  goal: string
  status: string
  maxBeats: number
  beatCount: number
  totalBeats: number
  confirmedCount: number
  exitSatisfied: boolean
  exitNodes: ExitEvalNode[]
}

export interface BudgetState {
  limit: number
  spent: number
  remaining: number
  exceeded: boolean
}

export function chapterBudget(repos: Repos, chapter: ChapterRecord): BudgetState {
  const limit = chapter.budgetTokens ?? DEFAULT_CHAPTER_BUDGET_TOKENS
  const usage = repos.turnMetric.sumByChapter(chapter.id)
  const spent = usage.tokensIn + usage.tokensOut
  return {
    limit,
    spent,
    remaining: Math.max(0, limit - spent),
    exceeded: spent >= limit
  }
}

function activeFacts(repos: Repos, projectId: string) {
  return repos.world.listByProject(projectId).map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    truth: fact.truth,
    validFromSeq: fact.validFromSeq,
    validToSeq: fact.validToSeq
  }))
}

function activeEdges(repos: Repos) {
  return repos.relationship.listActiveAll().map((edge) => ({
    from: edge.fromId,
    to: edge.toId,
    axis: edge.axis,
    value: edge.value,
    sinceSeq: edge.sinceSeq,
    validToSeq: edge.validToSeq
  }))
}

export function confirmedCountOf(beats: readonly BeatRecord[]): number {
  return beats.filter((beat) => beat.status === 'confirmed' || beat.status === 'author_edited').length
}

/** 场景出口求值：事实 as_of = 当前 seq_head，拍数 = 本场已确认拍。 */
export function evaluateSceneExit(
  repos: Repos,
  chapter: ChapterRecord,
  scene: SceneInChapter,
  beats: readonly BeatRecord[]
): { satisfied: boolean; nodes: ExitEvalNode[]; decidable: boolean; reason: string | null } {
  const raw = parseJson(scene.scene.exitJson)
  const validation = parseExitInput(raw)
  if (!validation.ast) {
    return {
      satisfied: false,
      nodes: [],
      decidable: false,
      reason: validation.reasons[0] ?? '出口条件不是可判定 DSL'
    }
  }
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')
  const evaluation = evaluateExit(validation.ast, {
    facts: activeFacts(repos, chapter.projectId),
    edges: activeEdges(repos),
    beatCount: confirmedCountOf(beats),
    asOfSeq: project.seqHead
  })
  return { satisfied: evaluation.satisfied, nodes: evaluation.nodes, decidable: true, reason: null }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function sceneProgress(repos: Repos, chapter: ChapterRecord): SceneProgress[] {
  return repos.scene.listByChapter(chapter.id).map((entry) => {
    const beats = repos.beat.listLiveByScene(entry.scene.id)
    const exit = evaluateSceneExit(repos, chapter, entry, beats)
    return {
      sceneId: entry.scene.id,
      chapterOrd: entry.chapterOrd,
      location: entry.scene.location,
      goal: entry.scene.goal,
      status: entry.scene.status,
      maxBeats: entry.scene.maxBeats,
      beatCount: confirmedCountOf(beats),
      totalBeats: beats.length,
      confirmedCount: confirmedCountOf(beats),
      exitSatisfied: exit.satisfied,
      exitNodes: exit.nodes
    }
  })
}

export type LoopDecision =
  | { kind: 'beat'; beat: BeatRecord }
  | { kind: 'close_scene'; scene: SceneInChapter; reason: 'exit_satisfied' | 'max_beats' }
  | { kind: 'exhausted'; scene: SceneInChapter }
  | { kind: 'complete' }
  | { kind: 'pause'; reason: PauseReason }

/**
 * 下一个可发牌的拍：
 * 按 (sceneOrd, beatOrd) 顺序，所有更早的槽位必须已确认（confirmed/author_edited），
 * 当前槽位必须是 proposed / rejected / interrupted（待生成或可重试）。
 *
 * 这样「一次只发一拍」且「不会跳过未确认的拍」由数据形状保证，不靠调用方自觉。
 */
export function nextActionableBeat(repos: Repos, chapterId: string): BeatRecord | null {
  // 已收束场景里剩下的拍不再发牌（出口/拍数/耗尽都会留下未生成的拍）。
  const openScenes = new Set(
    repos.scene
      .listByChapter(chapterId)
      .filter((entry) => entry.scene.status !== 'closed')
      .map((entry) => entry.scene.id)
  )
  for (const beat of repos.beat.listLiveByChapter(chapterId)) {
    if (!openScenes.has(beat.sceneId)) continue
    if (beat.status === 'confirmed' || beat.status === 'author_edited') continue
    if (beat.status === 'proposed' || beat.status === 'rejected' || beat.status === 'interrupted') return beat
    // 其他状态（draft / waiting_for_human / generating / stale ...）说明有拍没处理完。
    return null
  }
  return null
}

export interface DecideOptions {
  auto: boolean
  budget: BudgetState
}

/**
 * 循环判定（纯读）。
 *
 * 返回 `complete` 之前必须确认所有场景都 closed——章状态只在这里推进，
 * 避免 UI 与调度器各写一次 draft_complete。
 */
export function decideNext(repos: Repos, chapter: ChapterRecord, options: DecideOptions): LoopDecision {
  const scenes = repos.scene.listByChapter(chapter.id)
  if (scenes.length === 0) return { kind: 'pause', reason: 'storyboard_exhausted' }
  const open = scenes.find((entry) => entry.scene.status !== 'closed')
  if (!open) return { kind: 'complete' }

  // 预算先于发牌：自动模式超预算立即停，不静默续跑（DEV-PLAN §8.5 第 5 步）。
  if (options.auto && options.budget.exceeded) return { kind: 'pause', reason: 'budget_exceeded' }

  const beats = repos.beat.listLiveByScene(open.scene.id)
  const exit = evaluateSceneExit(repos, chapter, open, beats)
  // 每拍后检查收束：出口满足就关场景，不再为这一场发牌。
  if (exit.satisfied) return { kind: 'close_scene', scene: open, reason: 'exit_satisfied' }
  if (confirmedCountOf(beats) >= open.scene.maxBeats) {
    return { kind: 'close_scene', scene: open, reason: 'max_beats' }
  }

  const beat = nextActionableBeat(repos, chapter.id)
  if (beat) return { kind: 'beat', beat }
  return { kind: 'exhausted', scene: open }
}

/** 关场景：closing → closed；写 scheduler_event（出口是否满足作为 payload）。 */
export function closeScene(
  db: Db,
  repos: Repos,
  input: { chapter: ChapterRecord; scene: SceneInChapter; reason: 'exit_satisfied' | 'max_beats'; jobId?: string | null }
): { chapterComplete: boolean; warn: string | null } {
  const beats = repos.beat.listLiveByScene(input.scene.scene.id)
  const exit = evaluateSceneExit(repos, input.chapter, input.scene, beats)
  const from = input.scene.scene.status
  if (from !== 'closed') {
    if (from === 'planned') {
      repos.scene.update(input.scene.scene.id, { status: sceneTransition(from, 'CLOSE') })
    } else {
      repos.scene.update(input.scene.scene.id, { status: sceneTransition(from, 'CLOSE_START') })
      repos.scene.update(input.scene.scene.id, { status: sceneTransition('closing', 'CLOSE') })
    }
  }
  const warn = input.reason === 'max_beats' && !exit.satisfied ? 'exit_conditions_unsatisfied' : null
  repos.schedulerEvent.insert({
    projectId: input.chapter.projectId,
    chapterId: input.chapter.id,
    jobId: input.jobId ?? null,
    kind: 'scene_closed',
    reason: input.reason,
    payloadJson: JSON.stringify({ scene_id: input.scene.scene.id, warn, exit: exit.nodes })
  })

  const remaining = repos.scene.listByChapter(input.chapter.id).filter((entry) => entry.scene.status !== 'closed')
  if (remaining.length > 0) return { chapterComplete: false, warn }
  return { chapterComplete: true, warn }
}

/** 章草稿完成：drafting/paused → draft_complete（PRD §6.5）。 */
export function markChapterComplete(
  db: Db,
  repos: Repos,
  chapter: ChapterRecord,
  jobId?: string | null
): string {
  const from = chapter.status
  if (from !== 'draft_complete') {
    repos.chapter.setStatus(chapter.id, 'draft_complete')
  }
  recomputeCoveredUntilSeq(db, chapter.id)
  repos.schedulerEvent.insert({
    projectId: chapter.projectId,
    chapterId: chapter.id,
    jobId: jobId ?? null,
    kind: 'chapter_complete',
    reason: null,
    payloadJson: JSON.stringify({ from })
  })
  return 'draft_complete'
}
