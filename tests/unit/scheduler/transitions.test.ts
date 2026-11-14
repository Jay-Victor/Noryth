import { describe, expect, it } from 'vitest'
import {
  BEAT_STATES,
  BEAT_TRANSITIONS,
  CHAPTER_TRANSITIONS,
  JOB_TRANSITIONS,
  SCENE_TRANSITIONS,
  beatTransition,
  canBeatTransition,
  chapterTransition,
  jobTransition,
  reachableBeatStates,
  sceneTransition,
  type BeatEvent
} from '../../../src/main/scheduler/transitions'

/**
 * 状态机即表（PHASE-07 §1 第 3 条 / DEV-PLAN §8.1）：
 * 11 个拍状态全部可达；每条边都能走；非法迁移必须抛错。
 */

const ALL_EVENTS: BeatEvent[] = [
  'GENERATE',
  'DELTA',
  'COMPLETE',
  'FAIL',
  'CANCEL',
  'WAIT',
  'AUTO_ACCEPT',
  'REJECT',
  'CONFIRM',
  'REGENERATE',
  'EDIT',
  'UPSTREAM_CHANGED',
  'REPLACE',
  'RERUN',
  'IGNORE',
  'RETRY',
  'DISCARD'
]

describe('拍状态机', () => {
  it('11 个状态全部可达，没有死状态', () => {
    expect(BEAT_STATES).toHaveLength(11)
    expect(new Set(reachableBeatStates())).toEqual(new Set(BEAT_STATES))
  })

  it('每条声明的边都返回目标状态，且目标状态合法', () => {
    let edges = 0
    for (const from of BEAT_STATES) {
      for (const [event, next] of Object.entries(BEAT_TRANSITIONS[from])) {
        edges += 1
        expect(BEAT_STATES).toContain(next)
        expect(beatTransition(from, event as BeatEvent)).toBe(next)
        expect(canBeatTransition(from, event as BeatEvent)).toBe(true)
      }
    }
    // 主干 17 条边（DEV-PLAN §8.1 的表）
    expect(edges).toBeGreaterThanOrEqual(17)
  })

  it('每条迁移路径都能实际走到：proposed → … → superseded', () => {
    expect(beatTransition('proposed', 'GENERATE')).toBe('generating')
    expect(beatTransition('generating', 'DELTA')).toBe('generating')
    expect(beatTransition('generating', 'COMPLETE')).toBe('draft')
    expect(beatTransition('draft', 'WAIT')).toBe('waiting_for_human')
    expect(beatTransition('waiting_for_human', 'CONFIRM')).toBe('confirmed')
    expect(beatTransition('confirmed', 'UPSTREAM_CHANGED')).toBe('stale')
    expect(beatTransition('stale', 'RERUN')).toBe('regenerating')
    expect(beatTransition('regenerating', 'COMPLETE')).toBe('superseded')
  })

  it('重生成失败回 waiting_for_human，不产生新状态', () => {
    expect(beatTransition('regenerating', 'FAIL')).toBe('waiting_for_human')
  })

  it('生成失败/取消进 interrupted，可重试或丢弃', () => {
    expect(beatTransition('generating', 'FAIL')).toBe('interrupted')
    expect(beatTransition('generating', 'CANCEL')).toBe('interrupted')
    expect(beatTransition('interrupted', 'RETRY')).toBe('generating')
    expect(beatTransition('interrupted', 'DISCARD')).toBe('rejected')
  })

  it('自动模式跳过 G3：draft → AUTO_ACCEPT → confirmed', () => {
    expect(beatTransition('draft', 'AUTO_ACCEPT')).toBe('confirmed')
  })

  it('superseded 是终态：任何事件都非法', () => {
    for (const event of ALL_EVENTS) {
      expect(() => beatTransition('superseded', event)).toThrowError(/不接受事件/)
    }
  })

  it('confirmed 不能直接确认或编辑（必须先 stale/superseded）', () => {
    expect(() => beatTransition('confirmed', 'CONFIRM')).toThrowError(/confirmed/)
    expect(() => beatTransition('confirmed', 'EDIT')).toThrowError(/confirmed/)
    expect(() => beatTransition('confirmed', 'REGENERATE')).toThrowError(/confirmed/)
  })

  it('非法迁移的报错带 from/event/allowed，便于定位', () => {
    try {
      beatTransition('proposed', 'COMPLETE')
      throw new Error('should not reach')
    } catch (error) {
      const appError = error as { code?: string; details?: { from?: string; event?: string; allowed?: string[] } }
      expect(appError.code).toBe('invalid_args')
      expect(appError.details?.from).toBe('proposed')
      expect(appError.details?.event).toBe('COMPLETE')
      expect(appError.details?.allowed).toEqual(['GENERATE'])
    }
  })
})

describe('章 / 场景 / 任务状态机', () => {
  it('章节：planned → storyboard_ready → drafting → draft_complete', () => {
    expect(chapterTransition('planned', 'STORYBOARD_READY')).toBe('storyboard_ready')
    expect(chapterTransition('storyboard_ready', 'START')).toBe('drafting')
    expect(chapterTransition('drafting', 'PAUSE')).toBe('paused')
    expect(chapterTransition('paused', 'RESUME')).toBe('drafting')
    expect(chapterTransition('drafting', 'COMPLETE')).toBe('draft_complete')
    expect(() => chapterTransition('finalized', 'START')).toThrowError(/finalized/)
  })

  it('场景：planned → open → closing → closed；open ⇄ paused', () => {
    expect(sceneTransition('planned', 'OPEN')).toBe('open')
    expect(sceneTransition('open', 'CLOSE_START')).toBe('closing')
    expect(sceneTransition('closing', 'CLOSE')).toBe('closed')
    expect(sceneTransition('open', 'PAUSE')).toBe('paused')
    expect(sceneTransition('paused', 'RESUME')).toBe('open')
    expect(() => sceneTransition('closed', 'OPEN')).toThrowError(/closed/)
  })

  it('job：running → paused → running → succeeded', () => {
    expect(jobTransition('queued', 'RUN')).toBe('running')
    expect(jobTransition('running', 'PAUSE')).toBe('paused')
    expect(jobTransition('paused', 'RESUME')).toBe('running')
    expect(jobTransition('running', 'SUCCEED')).toBe('succeeded')
    expect(() => jobTransition('succeeded', 'RUN')).toThrowError(/succeeded/)
    expect(() => jobTransition('nope', 'RUN')).toThrowError(/未知 job 状态/)
  })

  it('章/场景/任务的表覆盖全部声明状态', () => {
    expect(Object.keys(CHAPTER_TRANSITIONS)).toHaveLength(10)
    expect(Object.keys(SCENE_TRANSITIONS)).toHaveLength(5)
    expect(Object.keys(JOB_TRANSITIONS)).toHaveLength(7)
  })
})
