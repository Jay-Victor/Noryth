import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import { capabilitiesFor, defaultModelFor, estimateCostCny } from '../model/presets'
import {
  chapterBudget,
  confirmedCountOf,
  decideNext,
  DEFAULT_CHAPTER_BUDGET_TOKENS,
  PAUSE_REASON_TEXT,
  type BudgetState,
  type LoopDecision,
  type PauseReason
} from './loop'

/**
 * 自动模式（PHASE-07 F6 / DEV-PLAN §8.5）。
 *
 * 预检必须在开跑前给出：剩余拍数、预估 token/费用区间、max_beats、预算余额。
 * 运行中每拍检查一次；四类停止条件（出口 / max_beats / 预算 / 耗尽）与
 * 模型错误、拒演都由 `decideNext` + `runBeatTurn` 的返回值决定，不靠 UI。
 */

export interface AutoPreflight {
  chapterId: string
  ready: boolean
  blockers: string[]
  /** 剩余未确认的拍。 */
  remainingBeats: number
  /** 场景拍数上限合计。 */
  maxBeats: number
  /** 最近 5 拍中位数；没有历史时 900。 */
  estimatedTokensPerBeat: number
  estimatedTokens: { min: number; max: number }
  estimatedCostCny: { min: number; max: number }
  budget: BudgetState
  consecutiveBeats: number
}

const DEFAULT_TOKENS_PER_BEAT = 900

export function autoPreflight(repos: Repos, chapterId: string): AutoPreflight {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  const beats = repos.beat.listLiveByChapter(chapter.id)
  const remaining = beats.filter(
    (beat) => beat.status !== 'confirmed' && beat.status !== 'author_edited' && beat.status !== 'superseded'
  )
  const scenes = repos.scene.listByChapter(chapter.id)
  const maxBeats = scenes.reduce((sum, entry) => sum + entry.scene.maxBeats, 0)
  const budget = chapterBudget(repos, chapter)

  const usage = repos.turnMetric.sumByChapter(chapter.id)
  const perBeat = usage.turns > 0 ? Math.max(1, Math.round((usage.tokensIn + usage.tokensOut) / usage.turns)) : DEFAULT_TOKENS_PER_BEAT
  const estimatedTokens = { min: Math.round(remaining.length * perBeat * 0.7), max: Math.round(remaining.length * perBeat * 1.3) }

  const project = repos.project.get()
  const provider = project?.defaultPreset ?? 'deepseek'
  const capabilities = capabilitiesFor(provider, defaultModelFor(provider))
  const estimate = (tokens: number): number =>
    estimateCostCny(capabilities, Math.round(tokens * 0.7), Math.round(tokens * 0.3)) ?? 0

  const blockers: string[] = []
  if (remaining.length === 0) blockers.push('没有剩余拍')
  if (project?.setupState !== 'complete') blockers.push('setup_incomplete')
  if (project?.blueprintLockedAt === null) blockers.push('蓝图未过 G1')
  if (budget.exceeded) blockers.push('预算已用尽')

  return {
    chapterId,
    ready: blockers.length === 0,
    blockers,
    remainingBeats: remaining.length,
    maxBeats,
    estimatedTokensPerBeat: perBeat,
    estimatedTokens,
    estimatedCostCny: { min: estimate(estimatedTokens.min), max: estimate(estimatedTokens.max) },
    budget,
    consecutiveBeats: remaining.length
  }
}

export interface AutoRunHooks {
  /** 每拍开始前通知 UI（beats 模式由 service 直接发）。 */
  onBeatStart?: (beat: BeatRecord) => void
  onBeatDone?: (beat: BeatRecord) => void
  onPause?: (reason: PauseReason, detail: Record<string, unknown>) => void
  onSceneClosed?: (sceneId: string, reason: string) => void
  onComplete?: () => void
  /** 作者在运行中点了暂停：在拍边界停下。 */
  shouldPause?: () => boolean
  /** 取消：立即停止读流（AbortSignal 由 service 传入 runBeatTurn）。 */
  shouldCancel?: () => boolean
}

export interface AutoRunResult {
  stopped: PauseReason | 'cancelled' | 'complete'
  beatsRun: number
  message: string
}

/**
 * 自动模式驱动：一拍一拍跑，直到停止条件。
 *
 * `runBeat` 由 service 注入（负责 job、适配器与事件）；本函数只决定「跑不跑下一拍」。
 * 这样 loop 的判定逻辑可以单测，不需要模型。
 */
export async function runAutoLoop(
  repos: Repos,
  chapter: ChapterRecord,
  hooks: AutoRunHooks,
  runBeat: (beat: BeatRecord) => Promise<{ status: 'committed' | 'refused' | 'failed'; code?: string }>,
  closeSceneById: (sceneId: string, reason: 'exit_satisfied' | 'max_beats') => boolean
): Promise<AutoRunResult> {
  let beatsRun = 0
  for (;;) {
    if (hooks.shouldCancel?.()) {
      return { stopped: 'cancelled', beatsRun, message: '已取消' }
    }
    if (hooks.shouldPause?.()) {
      hooks.onPause?.('author_paused', { beatsRun })
      return { stopped: 'author_paused', beatsRun, message: PAUSE_REASON_TEXT.author_paused }
    }

    const current = repos.chapter.get(chapter.id)
    if (!current) throw new AppError('project_not_found', `chapter ${chapter.id} not found`)
    const decision: LoopDecision = decideNext(repos, current, { auto: true, budget: chapterBudget(repos, current) })

    if (decision.kind === 'complete') {
      hooks.onComplete?.()
      return { stopped: 'complete', beatsRun, message: PAUSE_REASON_TEXT.draft_complete }
    }
    if (decision.kind === 'pause') {
      hooks.onPause?.(decision.reason, { beatsRun })
      return { stopped: decision.reason, beatsRun, message: PAUSE_REASON_TEXT[decision.reason] }
    }
    if (decision.kind === 'close_scene') {
      const chapterComplete = closeSceneById(decision.scene.scene.id, decision.reason)
      hooks.onSceneClosed?.(decision.scene.scene.id, decision.reason)
      if (chapterComplete) continue
      continue
    }
    if (decision.kind === 'exhausted') {
      hooks.onPause?.('storyboard_exhausted', { sceneId: decision.scene.scene.id, beatsRun })
      return { stopped: 'storyboard_exhausted', beatsRun, message: PAUSE_REASON_TEXT.storyboard_exhausted }
    }

    hooks.onBeatStart?.(decision.beat)
    const outcome = await runBeat(decision.beat)
    beatsRun += 1
    if (outcome.status === 'refused') {
      hooks.onPause?.('character_refusal', { beatId: decision.beat.id, beatsRun })
      return { stopped: 'character_refusal', beatsRun, message: PAUSE_REASON_TEXT.character_refusal }
    }
    if (outcome.status === 'failed') {
      hooks.onPause?.('model_error', { beatId: decision.beat.id, code: outcome.code, beatsRun })
      return { stopped: 'model_error', beatsRun, message: PAUSE_REASON_TEXT.model_error }
    }
    hooks.onBeatDone?.(decision.beat)
  }
}

/** 自动模式每拍结束后的预算检查（DEV-PLAN §8.5 第 5 步）：超了必须停。 */
export function autoBudgetExceeded(repos: Repos, chapter: ChapterRecord): boolean {
  return chapterBudget(repos, chapter).exceeded
}

export { DEFAULT_CHAPTER_BUDGET_TOKENS, confirmedCountOf, PAUSE_REASON_TEXT }
export type { PauseReason, BudgetState }
