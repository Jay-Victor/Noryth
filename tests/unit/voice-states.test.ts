import { describe, expect, it } from 'vitest'
import {
  VOICE_THRESHOLD,
  VOICE_VIEW_LABELS,
  formatDistinctness,
  isBelowVoiceThreshold,
  voiceViewStateOf
} from '../../src/shared/domain/voice'

/**
 * 声音 UI 状态矩阵（AGENTS「完成标准 3」/ PHASE-19 §6）：
 * 缺数据、人数/拍数不足、偏低、正常四态；每个状态都有可读文案且唯一。
 */

describe('声音 UI 状态矩阵', () => {
  it('四态映射：missing / insufficient / low / ok', () => {
    expect(voiceViewStateOf({ found: false, insufficientData: true, belowThreshold: false })).toBe('missing')
    expect(voiceViewStateOf({ found: true, insufficientData: true, belowThreshold: false })).toBe('insufficient')
    expect(voiceViewStateOf({ found: true, insufficientData: false, belowThreshold: true })).toBe('low')
    expect(voiceViewStateOf({ found: true, insufficientData: false, belowThreshold: false })).toBe('ok')
  })

  it('四态文案唯一且都提到「数据不足 / 偏低 / 正常」', () => {
    const labels = Object.values(VOICE_VIEW_LABELS)
    expect(labels).toHaveLength(4)
    expect(new Set(labels).size).toBe(labels.length)
    expect(VOICE_VIEW_LABELS.missing).toContain('数据不足')
    expect(VOICE_VIEW_LABELS.insufficient).toContain('数据不足')
    expect(VOICE_VIEW_LABELS.low).toContain('提示')
    expect(VOICE_VIEW_LABELS.ok).toContain('正常')
  })

  it('阈值展示与比较同源：UI 不出现 0.18 字面量', () => {
    expect(formatDistinctness(VOICE_THRESHOLD.distinctnessMin)).not.toBe('0.18')
    expect(isBelowVoiceThreshold(VOICE_THRESHOLD.distinctnessMin - 0.01)).toBe(true)
    expect(isBelowVoiceThreshold(VOICE_THRESHOLD.distinctnessMin)).toBe(false)
  })
})
