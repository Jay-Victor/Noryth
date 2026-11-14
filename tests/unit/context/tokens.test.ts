import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_MAX,
  CALIBRATION_MIN,
  clampCalibration,
  estimateTokens,
  medianCalibration,
  truncateToTokens
} from '../../../src/main/context/tokens'

describe('token 估算（DEV-PLAN §7.4）', () => {
  it('中文按 1.05、拉丁按 3.6 字/token、标点 0.6', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('雨')).toBe(2)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('，')).toBe(1)
    // 4 个汉字 + 1 个逗号 = 4.8 → 5
    expect(estimateTokens('雨夜，祠堂')).toBe(5)
  })

  it('校准 clamp 到 [0.7, 1.6]，非有限值回落到 1', () => {
    expect(clampCalibration(0.2)).toBe(CALIBRATION_MIN)
    expect(clampCalibration(3)).toBe(CALIBRATION_MAX)
    expect(clampCalibration(Number.NaN)).toBe(1)
    expect(clampCalibration(1.25)).toBe(1.25)
  })

  it('中位数只取最近 20 个样本，偶数取中间两数均值', () => {
    expect(medianCalibration([])).toBe(1)
    expect(medianCalibration([1, 1.2, 1.4])).toBe(1.2)
    expect(medianCalibration([1, 1.2, 1.4, 1.6])).toBeCloseTo(1.3, 10)
    const noisy = [...Array.from({ length: 20 }, () => 0.8), 9, 9, 9]
    expect(medianCalibration(noisy)).toBe(0.8)
  })

  it('按 token 截断不超上限，且加省略号后仍在上限内', () => {
    const text = '雨'.repeat(200)
    const truncated = truncateToTokens(text, 20)
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(20)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated.length).toBeLessThan(text.length)
    expect(truncateToTokens('短句', 20)).toBe('短句')
    expect(truncateToTokens(text, 0)).toBe('')
  })
})
