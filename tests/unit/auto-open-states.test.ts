import { describe, expect, it } from 'vitest'
import { AUTO_OPEN_REASONS, type AutoOpenReason } from '../../src/shared/schema/project'
import { AUTO_OPEN_NOTICES } from '../../src/shared/domain/auto-open'

/**
 * 状态矩阵 fixture（AGENTS「完成标准 3」/ PHASE-11 §5.4）：
 * 启动自动打开的每个 reason 都必须有确定的界面归属——提示或静默，
 * 不允许「新加一个 reason 但 UI 什么都不说」。
 */
describe('启动自动打开状态矩阵', () => {
  it('每个 reason 都在矩阵里，且没有多余条目', () => {
    expect(Object.keys(AUTO_OPEN_NOTICES).sort()).toEqual([...AUTO_OPEN_REASONS].sort())
  })

  it('失败类 reason 都有可读提示；成功/关闭/无记录保持静默', () => {
    const silent: AutoOpenReason[] = ['ok', 'disabled', 'no_last_project']
    for (const reason of AUTO_OPEN_REASONS) {
      const notice = AUTO_OPEN_NOTICES[reason]
      if (silent.includes(reason)) {
        expect(notice, reason).toBeNull()
        continue
      }
      expect(notice, reason).toBeTruthy()
      expect(notice!.title.length).toBeGreaterThan(0)
      expect(notice!.detail.length).toBeGreaterThan(0)
      // toast 去重键必须唯一：两条状态不能挤掉彼此。
      expect(notice!.key.startsWith('auto-open-')).toBe(true)
    }
    const keys = AUTO_OPEN_REASONS.map((reason) => AUTO_OPEN_NOTICES[reason]?.key).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('被占用与路径失效给不同文案：作者要知道该重定位还是该关另一个窗口', () => {
    expect(AUTO_OPEN_NOTICES.locked!.title).toContain('另一窗口')
    expect(AUTO_OPEN_NOTICES.missing!.detail).toContain('重新定位')
  })
})
