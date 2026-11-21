import { describe, expect, it } from 'vitest'
import { forecastBudget, median } from '../../../src/main/scheduler/forecast'

/**
 * 费用预测（PHASE-20 §5.2 / M2-3）：
 * - 最近 5 拍中位数；不足 5 拍回落 900；
 * - 区间 0.7–1.3；
 * - 无计价返回 null；
 * - 纯函数：同一输入两次相等。
 */
describe('forecastBudget', () => {
  const sample = (tokens: number, cost: number | null = 0.001) => ({
    tokensIn: Math.round(tokens * 0.7),
    tokensOut: Math.round(tokens * 0.3),
    costCny: cost
  })

  it('最近 5 拍中位数 + 0.7/1.3 区间', () => {
    const recent = [1000, 1200, 1400, 1600, 1800].map((tokens) => sample(tokens, 0.001))
    const forecast = forecastBudget({ remainingBeats: 4, recent })
    expect(forecast.basis).toBe('recent')
    expect(forecast.sampleSize).toBe(5)
    expect(median([1000, 1200, 1400, 1600, 1800])).toBe(1400)
    expect(forecast.tokens).toEqual({ low: 3920, mid: 5600, high: 7280 })
    // 5 个 0.001 的中位数仍是 0.001；4 拍 = 0.004。
    expect(forecast.cost).toEqual({ low: 0.0028, mid: 0.004, high: 0.0052 })
  })

  it('不足 5 拍：tokens 回落每拍 900，basis=default', () => {
    const forecast = forecastBudget({
      remainingBeats: 3,
      recent: [sample(2000, 0.002), sample(4000, 0.004)]
    })
    expect(forecast.basis).toBe('default')
    expect(forecast.sampleSize).toBe(2)
    expect(forecast.tokens).toEqual({ low: 1890, mid: 2700, high: 3510 })
    // 有计价样本时仍给区间；没有样本才是 null。
    expect(forecast.cost).not.toBeNull()
  })

  it('全无计价：cost=null，不把未知当 0', () => {
    const forecast = forecastBudget({
      remainingBeats: 2,
      recent: [sample(1000, null), sample(1000, null)]
    })
    expect(forecast.cost).toBeNull()
    expect(forecast.tokens.mid).toBe(1800)
  })

  it('剩余 0 拍 / 空历史：全 0 + 默认基线', () => {
    expect(forecastBudget({ remainingBeats: 0, recent: [] })).toMatchObject({
      beats: 0,
      tokens: { low: 0, mid: 0, high: 0 },
      cost: null,
      basis: 'default',
      sampleSize: 0
    })
  })

  it('只取最近 5 条；同一输入两次 deep-equal', () => {
    const recent = [100, 200, 300, 400, 500, 9000, 8000].map((tokens) => sample(tokens, 0.001))
    const first = forecastBudget({ remainingBeats: 2, recent })
    const second = forecastBudget({ remainingBeats: 2, recent })
    expect(first).toEqual(second)
    // 最后 5 条 = 300/400/500/9000/8000 → 中位数 500。
    expect(first.sampleSize).toBe(5)
    expect(first.tokens.mid).toBe(1000)
  })
})
