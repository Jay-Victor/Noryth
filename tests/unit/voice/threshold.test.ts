import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import calibration from '../../fixtures/voice/calibration-result.json'
import {
  VOICE_THRESHOLD,
  formatDistinctness,
  isBelowVoiceThreshold
} from '../../../src/shared/domain/voice'

/**
 * 阈值一致性（PHASE-19 §5.2 / ADR-0007）：
 * 常量、校准结果与语料 hash 三处必须同源；改语料/阈值必须一起改并升版本。
 */

describe('声音阈值', () => {
  it('常量与 calibration-result.json 一致', () => {
    expect(VOICE_THRESHOLD.version).toBe(calibration.version)
    expect(VOICE_THRESHOLD.distinctnessMin).toBe(calibration.threshold)
    expect(VOICE_THRESHOLD.corpusHash).toBe(calibration.corpusHash)
    expect(VOICE_THRESHOLD.calibratedAt).toBe(calibration.calibratedAt)
  })

  it('语料文件 sha256 与 corpusHash 一致（换语料必然漂移）', () => {
    const raw = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'voice', 'zh-corpus.json'))
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VOICE_THRESHOLD.corpusHash)
  })

  it('校准达标：同人误报 ≤5%、异人检出 ≥80%，阈值在 [0.12, 0.30]', () => {
    expect(calibration.passed).toBe(true)
    expect(calibration.sameCharacterFalseAlarm).toBeLessThanOrEqual(0.05)
    expect(calibration.differentCharacterDetection).toBeGreaterThanOrEqual(0.8)
    expect(VOICE_THRESHOLD.distinctnessMin).toBeGreaterThanOrEqual(0.12)
    expect(VOICE_THRESHOLD.distinctnessMin).toBeLessThanOrEqual(0.3)
    expect(calibration.scenes).toBeGreaterThanOrEqual(20)
    expect(calibration.samePairs).toBeGreaterThan(0)
    expect(calibration.differentPairs).toBeGreaterThan(0)
  })

  it('等于阈值不告警，低于才告警；展示保留两位小数', () => {
    expect(isBelowVoiceThreshold(VOICE_THRESHOLD.distinctnessMin)).toBe(false)
    expect(isBelowVoiceThreshold(VOICE_THRESHOLD.distinctnessMin - 0.001)).toBe(true)
    expect(formatDistinctness(0.252)).toBe('0.25')
    expect(formatDistinctness(0.1)).toBe('0.10')
  })
})
