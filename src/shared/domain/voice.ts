/**
 * 声音阈值常量（PHASE-19 §5.2 / ADR-0007）。
 *
 * 唯一真源：UI 与 T25 / `voice.scene` 都读这里，界面里不再出现 0.18 之类的字面量。
 * 值来自 `scripts/calibrate-voice.mjs` 对 `tests/fixtures/voice/zh-corpus.json`
 * 的校准结果；`tests/unit/voice/threshold.test.ts` 守住两边一致。
 *
 * 语料是合成中文夹具，不是出版小说：阈值只是起点。换语料必须升 `version`
 * 并重算历史 `voice_metric`（旧行按 `threshold_version` 识别）。
 */

export interface VoiceThreshold {
  version: string
  distinctnessMin: number
  /** 校准语料文件的 sha256；换语料必然变化。 */
  corpusHash: string
  calibratedAt: string
}

export const VOICE_THRESHOLD: VoiceThreshold = {
  version: 'zh-v1',
  distinctnessMin: 0.252,
  corpusHash: 'c469b5931eb3ff46c54db71ef6ec5c0cadfc39cebf6d0c804d51db0228774712',
  calibratedAt: '2026-11-21'
}

/** 低于阈值 = 告警；等于阈值不告警（避免浮点边界抖动）。 */
export function isBelowVoiceThreshold(
  score: number,
  threshold: Pick<VoiceThreshold, 'distinctnessMin'> = VOICE_THRESHOLD
): boolean {
  return score < threshold.distinctnessMin
}

/** UI 文案：0.252 →「0.25」；两位小数足够，阈值本身不长这样。 */
export function formatDistinctness(score: number): string {
  return (Math.round(score * 100) / 100).toFixed(2)
}

export const VOICE_THRESHOLD_NOTE = '提示，不阻断：声音偏低不进入 G6 阻断条件'

/** UI 状态（PHASE-19 §5.3）：缺数据 / 人数或拍数不足 / 偏低 / 正常。 */
export type VoiceViewState = 'missing' | 'insufficient' | 'low' | 'ok'

export const VOICE_VIEW_LABELS: Record<VoiceViewState, string> = {
  missing: '数据不足（还没有可读的 revision）',
  insufficient: '数据不足（在场角色少于 2 人或拍数不足）',
  low: '声音偏低（仅提示，不阻断）',
  ok: '声音区分度正常'
}

export function voiceViewStateOf(input: {
  found: boolean
  insufficientData: boolean
  belowThreshold: boolean
}): VoiceViewState {
  if (!input.found) return 'missing'
  if (input.insufficientData) return 'insufficient'
  return input.belowThreshold ? 'low' : 'ok'
}
