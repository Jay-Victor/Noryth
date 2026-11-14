/**
 * Token 估算（DEV-PLAN §7.4）：只用于预算与裁剪，不用于计费。
 * 中文一字约 1.05 token，拉丁字母约 3.6 字/token，标点 0.6 token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let latin = 0
  let punct = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjk += 1
    else if (/[A-Za-z0-9]/.test(ch)) latin += 1
    else punct += 1
  }
  return Math.ceil(cjk * 1.05 + latin / 3.6 + punct * 0.6)
}
