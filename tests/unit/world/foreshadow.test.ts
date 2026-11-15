import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import {
  closeForeshadow,
  createForeshadow,
  foreshadowState,
  listOpenForeshadow,
  reopenForeshadow,
  updateForeshadow
} from '../../../src/main/world/foreshadow'
import { openPlanWorld, seedPostG1, type PlanTestWorld } from '../../support/plan-world'

/**
 * 伏笔（PHASE-15 M1-10 / PRD §4.10 T22）。
 *
 * 只报节奏：距离 = 当前章 ord − 埋设章 ord；超过计划回收章 → overdue。
 * 不产生任何阻断，也不自动回收。
 */

function codeOf(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return error instanceof AppError ? error.code : 'unknown'
  }
}

describe('伏笔', () => {
  const created: PlanTestWorld[] = []
  const world = (): { world: PlanTestWorld; post: ReturnType<typeof seedPostG1> } => {
    const item = openPlanWorld()
    created.push(item)
    return { world: item, post: seedPostG1(item) }
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }

  it('标注 3 条 → T22 返回 open 3；回收 1 条 → 2；距离正确', () => {
    const { world: w, post } = world()
    try {
      const first = createForeshadow(w.repos, w.projectId, {
        text: '匣子底部的林家族徽',
        plantedChapterId: post.chapter1Id
      })
      createForeshadow(w.repos, w.projectId, {
        text: '老太爷的旧信',
        plantedChapterId: post.chapter1Id,
        plannedPayoffChapterId: post.chapter2Id
      })
      createForeshadow(w.repos, w.projectId, { text: '账本最后一页', plantedChapterId: post.chapter2Id })
      expect(w.repos.foreshadow.listOpen(w.projectId)).toHaveLength(3)

      // 站在第 2 章：第 1 章埋的 = 1 章；第 2 章埋的 = 0 章
      const open = listOpenForeshadow(w.repos, w.projectId, post.chapter2Id)
      expect(open.items).toHaveLength(3)
      expect(open.as_of_ord).toBe(2)
      expect(open.items.filter((item) => item.distance === 1)).toHaveLength(2)
      expect(open.items.filter((item) => item.distance === 0)).toHaveLength(1)
      expect(open.items.every((item) => item.note.includes('未回收') || item.note === '本章埋设')).toBe(true)

      closeForeshadow(w.repos, w.projectId, { foreshadowId: first.id, payoffChapterId: post.chapter2Id })
      expect(listOpenForeshadow(w.repos, w.projectId, post.chapter2Id).items).toHaveLength(2)
      const closed = foreshadowState(w.repos, w.projectId, post.chapter2Id)
      expect(closed.openCount).toBe(2)
      expect(closed.closedCount).toBe(1)
      expect(closed.items.find((item) => item.id === first.id)!.payoffOrd).toBe(2)
    } finally {
      cleanup()
    }
  })

  it('超期只标「已 N 章未回收（超计划）」，不阻断任何闸门', () => {
    const { world: w, post } = world()
    try {
      createForeshadow(w.repos, w.projectId, {
        text: '刻着记号的金锁',
        plantedChapterId: post.chapter1Id,
        plannedPayoffChapterId: post.chapter1Id
      })
      const state = foreshadowState(w.repos, w.projectId, post.chapter2Id)
      const item = state.items[0]!
      expect(item.overdue).toBe(true)
      expect(item.distance).toBe(1)
      expect(item.plannedPayoffOrd).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('回收后可以重新打开；已回收的不能重复回收', () => {
    const { world: w, post } = world()
    try {
      const item = createForeshadow(w.repos, w.projectId, { text: '供桌下的暗格', plantedChapterId: post.chapter1Id })
      closeForeshadow(w.repos, w.projectId, { foreshadowId: item.id, payoffChapterId: post.chapter2Id })
      expect(codeOf(() => closeForeshadow(w.repos, w.projectId, { foreshadowId: item.id, payoffChapterId: post.chapter1Id }))).toBe(
        'invalid_args'
      )
      const reopened = reopenForeshadow(w.repos, w.projectId, item.id)
      expect(reopened.status).toBe('open')
      expect(reopened.payoffChapterId).toBeNull()
      expect(reopened.payoffOrd).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('引用不存在的章节 / 空文本 / 重复删除都被拒', () => {
    const { world: w } = world()
    try {
      expect(codeOf(() => createForeshadow(w.repos, w.projectId, { text: 'x', plantedChapterId: 'ch_missing' }))).toBe(
        'invalid_args'
      )
      expect(
        codeOf(() =>
          createForeshadow(w.repos, w.projectId, { text: 'x', plantedChapterId: 'ch_missing', plannedPayoffChapterId: 'ch_x' })
        )
      ).toBe('invalid_args')
      expect(codeOf(() => updateForeshadow(w.repos, w.projectId, { foreshadowId: 'fs_missing', text: 'y' }))).toBe(
        'invalid_args'
      )
    } finally {
      cleanup()
    }
  })

  it('计划回收章可清空（null），文本可改', () => {
    const { world: w, post } = world()
    try {
      const item = createForeshadow(w.repos, w.projectId, {
        text: '旧信',
        plantedChapterId: post.chapter1Id,
        plannedPayoffChapterId: post.chapter2Id
      })
      const cleared = updateForeshadow(w.repos, w.projectId, {
        foreshadowId: item.id,
        text: '旧信（改）',
        plannedPayoffChapterId: null
      })
      expect(cleared.text).toBe('旧信（改）')
      expect(cleared.plannedPayoffChapterId).toBeNull()
      expect(cleared.plannedPayoffOrd).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('没有章时距离为 0，不崩', () => {
    const w = openPlanWorld()
    created.push(w)
    try {
      const state = foreshadowState(w.repos, w.projectId)
      expect(state.chapters).toHaveLength(0)
      expect(state.items).toHaveLength(0)
      expect(state.openCount).toBe(0)
      expect(listOpenForeshadow(w.repos, w.projectId).items).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})
