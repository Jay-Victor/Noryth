import { describe, expect, it } from 'vitest'
import { AGENT_TURN_LIMITS, TurnBudget, baseAgentOf } from '../../../src/main/tools/budget'

describe('TurnBudget', () => {
  it('Agent 总上限与 PRD 一致', () => {
    expect(AGENT_TURN_LIMITS).toEqual({
      planner: 8,
      orchestrator: 8,
      character: 6,
      narrator: 4,
      reviewer: 12,
      memory: 8
    })
    expect(baseAgentOf('character:chr_lin')).toBe('character')
  })

  it('单工具上限与总上限同时生效，超限不消耗', () => {
    const budget = new TurnBudget('narrator')
    expect(budget.take('storyboard.get_beat', 2)).toBe(true)
    expect(budget.take('storyboard.get_beat', 2)).toBe(true)
    expect(budget.take('storyboard.get_beat', 2)).toBe(false)
    expect(budget.usedFor('storyboard.get_beat')).toBe(2)
    expect(budget.used).toBe(2)

    expect(budget.take('canon.search_public', 5)).toBe(true)
    expect(budget.take('canon.search_public', 5)).toBe(true)
    expect(budget.take('canon.search_public', 5)).toBe(false)
    expect(budget.used).toBe(4)
  })

  it('项目策略只能调低，不能调高', () => {
    expect(new TurnBudget('reviewer', { totalLimit: 3 }).limit).toBe(3)
    expect(new TurnBudget('reviewer', { totalLimit: 100 }).limit).toBe(12)
    expect(new TurnBudget('reviewer', { totalLimit: -1 }).limit).toBe(0)
  })

  it('角色实例按 character 基线计数', () => {
    const budget = new TurnBudget('character:chr_lin')
    expect(budget.limit).toBe(6)
  })
})
