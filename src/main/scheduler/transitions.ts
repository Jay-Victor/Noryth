import { AppError } from '../../shared/domain/app-error'
import type { BeatStatus } from '../db/repos/beat'
import type { ChapterStatus } from '../db/repos/chapter'
import type { SceneStatus } from '../db/repos/scene'

/**
 * 状态机即表（DEV-PLAN §8.1 / PRD §6.5）。
 *
 * 只描述「事件 → 下一状态」；副作用（写 job 心跳、通知、covered_until_seq）由
 * 调度器在调用前后处理。非法迁移一律抛 `invalid_args`，不允许静默忽略——
 * 阶段 07 的「11 个拍状态迁移全覆盖 + 非法路径报错」两件事都靠这张表。
 */

export type BeatEvent =
  | 'GENERATE'
  | 'DELTA'
  | 'COMPLETE'
  | 'FAIL'
  | 'CANCEL'
  | 'WAIT'
  | 'AUTO_ACCEPT'
  | 'REJECT'
  | 'CONFIRM'
  | 'REGENERATE'
  | 'EDIT'
  | 'UPSTREAM_CHANGED'
  | 'REPLACE'
  | 'RERUN'
  | 'REQUEUE'
  | 'IGNORE'
  | 'RETRY'
  | 'DISCARD'

export const BEAT_STATES = [
  'proposed',
  'generating',
  'draft',
  'waiting_for_human',
  'confirmed',
  'regenerating',
  'rejected',
  'author_edited',
  'stale',
  'superseded',
  'interrupted'
] as const satisfies readonly BeatStatus[]

export const BEAT_TRANSITIONS: Readonly<Record<BeatStatus, Readonly<Partial<Record<BeatEvent, BeatStatus>>>>> = {
  proposed: { GENERATE: 'generating' },
  generating: { DELTA: 'generating', COMPLETE: 'draft', FAIL: 'interrupted', CANCEL: 'interrupted' },
  draft: { WAIT: 'waiting_for_human', AUTO_ACCEPT: 'confirmed', REJECT: 'rejected', REGENERATE: 'regenerating' },
  waiting_for_human: { CONFIRM: 'confirmed', REGENERATE: 'regenerating', EDIT: 'author_edited' },
  // COMPLETE：同一事务里插入新拍 draft，旧拍留 superseded（无孤儿、无双活）
  regenerating: { COMPLETE: 'superseded', FAIL: 'waiting_for_human' },
  author_edited: { UPSTREAM_CHANGED: 'stale' },
  confirmed: { UPSTREAM_CHANGED: 'stale', REPLACE: 'superseded' },
  // REQUEUE：作者选择「替换并重跑后续」，把 stale 拍排进下一轮发牌（interrupted 可重试）。
  stale: { RERUN: 'regenerating', REQUEUE: 'interrupted', IGNORE: 'confirmed' },
  interrupted: { RETRY: 'generating', DISCARD: 'rejected' },
  rejected: { RETRY: 'generating' },
  superseded: {}
}

export type ChapterEvent =
  | 'STORYBOARD_READY'
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'COMPLETE'
  | 'REVIEW'
  | 'REVISE'
  | 'APPROVE'
  | 'FINALIZE'
  | 'ABANDON'

export const CHAPTER_TRANSITIONS: Readonly<
  Record<ChapterStatus, Readonly<Partial<Record<ChapterEvent, ChapterStatus>>>>
> = {
  planned: { STORYBOARD_READY: 'storyboard_ready', ABANDON: 'abandoned' },
  storyboard_ready: { START: 'drafting', ABANDON: 'abandoned' },
  drafting: { PAUSE: 'paused', COMPLETE: 'draft_complete', ABANDON: 'abandoned' },
  draft_complete: { REVIEW: 'under_review', START: 'drafting' },
  under_review: { REVISE: 'revising', APPROVE: 'approved' },
  revising: { REVIEW: 'under_review', APPROVE: 'approved', ABANDON: 'abandoned' },
  approved: { FINALIZE: 'finalized', REVISE: 'revising' },
  finalized: {},
  paused: { RESUME: 'drafting', ABANDON: 'abandoned' },
  abandoned: {}
}

export type SceneEvent = 'OPEN' | 'CLOSE_START' | 'CLOSE' | 'PAUSE' | 'RESUME'

export const SCENE_TRANSITIONS: Readonly<
  Record<SceneStatus, Readonly<Partial<Record<SceneEvent, SceneStatus>>>>
> = {
  planned: { OPEN: 'open', CLOSE: 'closed' },
  open: { CLOSE_START: 'closing', PAUSE: 'paused', CLOSE: 'closed' },
  closing: { CLOSE: 'closed' },
  closed: {},
  paused: { RESUME: 'open', CLOSE: 'closed' }
}

export type JobEvent = 'RUN' | 'SUCCEED' | 'FAIL' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'INTERRUPT'

export const JOB_TRANSITIONS: Readonly<
  Record<string, Readonly<Partial<Record<JobEvent, string>>>>
> = {
  queued: { RUN: 'running', CANCEL: 'cancelled' },
  running: { SUCCEED: 'succeeded', FAIL: 'failed', PAUSE: 'paused', CANCEL: 'cancelled', INTERRUPT: 'interrupted' },
  paused: { RESUME: 'running', CANCEL: 'cancelled' },
  succeeded: {},
  failed: {},
  cancelled: {},
  interrupted: {}
}

function illegal(kind: string, from: string, event: string, allowed: readonly string[]): AppError {
  return new AppError('invalid_args', `${kind} 状态 ${from} 不接受事件 ${event}`, {
    from,
    event,
    allowed
  })
}

export function beatTransition(from: BeatStatus, event: BeatEvent): BeatStatus {
  const next = BEAT_TRANSITIONS[from][event]
  if (!next) {
    throw illegal('beat', from, event, Object.keys(BEAT_TRANSITIONS[from]))
  }
  return next
}

export function canBeatTransition(from: BeatStatus, event: BeatEvent): boolean {
  return BEAT_TRANSITIONS[from][event] !== undefined
}

export function chapterTransition(from: ChapterStatus, event: ChapterEvent): ChapterStatus {
  const next = CHAPTER_TRANSITIONS[from][event]
  if (!next) throw illegal('chapter', from, event, Object.keys(CHAPTER_TRANSITIONS[from]))
  return next
}

export function sceneTransition(from: SceneStatus, event: SceneEvent): SceneStatus {
  const next = SCENE_TRANSITIONS[from][event]
  if (!next) throw illegal('scene', from, event, Object.keys(SCENE_TRANSITIONS[from]))
  return next
}

export function jobTransition(from: string, event: JobEvent): string {
  const table = JOB_TRANSITIONS[from]
  if (!table) throw new AppError('invalid_args', `未知 job 状态 ${from}`, { from })
  const next = table[event]
  if (!next) throw illegal('job', from, event, Object.keys(table))
  return next
}

/** 所有可达状态（测试用来保证 11 个拍状态都有入边或出边，不存在死代码）。 */
export function reachableBeatStates(): BeatStatus[] {
  const seen = new Set<BeatStatus>(['proposed'])
  let changed = true
  while (changed) {
    changed = false
    for (const state of BEAT_STATES) {
      if (!seen.has(state)) continue
      for (const next of Object.values(BEAT_TRANSITIONS[state])) {
        if (next && !seen.has(next)) {
          seen.add(next)
          changed = true
        }
      }
    }
  }
  return BEAT_STATES.filter((state) => seen.has(state))
}
