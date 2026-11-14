/**
 * Token 估算（DEV-PLAN §7.4）：只用于预算与裁剪，不用于计费。
 *
 * 公式：ceil(cjk * 1.05 + latin / 3.6 + punct * 0.6)。
 * 同一函数也被工具层截断复用，保证「预算」与「结果截断」口径一致。
 */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
const LATIN = /[A-Za-z0-9]/

export function estimateTokens(text: string): number {
  let cjk = 0
  let latin = 0
  let punct = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1
    else if (LATIN.test(ch)) latin += 1
    else punct += 1
  }
  return Math.ceil(cjk * 1.05 + latin / 3.6 + punct * 0.6)
}

export const CALIBRATION_MIN = 0.7
export const CALIBRATION_MAX = 1.6
export const CALIBRATION_WINDOW = 20

export function clampCalibration(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, ratio))
}

/**
 * 按 provider 校准估算：最近 20 次真实 usage.prompt_tokens / 估算值的中位数，
 * clamp [0.7, 1.6]。样本不足或非有限值回落到 1。
 */
export function medianCalibration(ratios: readonly number[]): number {
  const finite = ratios.filter((value) => Number.isFinite(value) && value > 0).slice(-CALIBRATION_WINDOW)
  if (finite.length === 0) return 1
  const sorted = [...finite].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 1) + (sorted[middle] ?? 1)) / 2
      : (sorted[middle] ?? 1)
  return clampCalibration(median)
}

/** 预算用 token = 估算 × 校准系数（向上取整）。 */
export function calibratedTokens(text: string, calibration = 1): number {
  return Math.ceil(estimateTokens(text) * clampCalibration(calibration))
}

/**
 * 按 token 上限截断文本：按字符累加，超限即停；不切 surrogate pair。
 * 用于固定分配块（L0/L1/角色卡/意图/L3）的硬上限。
 */
export function truncateToTokens(text: string, maxTokens: number, suffix = '…'): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const suffixTokens = estimateTokens(suffix)
  const limit = Math.max(0, maxTokens - suffixTokens)
  let used = 0
  let output = ''
  for (const ch of text) {
    const cost = CJK.test(ch) ? 1.05 : LATIN.test(ch) ? 1 / 3.6 : 0.6
    if (used + cost > limit) break
    used += cost
    output += ch
  }
  return output.length > 0 ? `${output}${suffix}` : ''
}
