/**
 * 文本归一化（DEV-PLAN §9.3）：patch 的 `before` 与当前正文比较、
 * grounding 的 quote 子串校验、依据 chips 的原文核对，三处必须使用同一口径。
 *
 * 规则刻意保守：只抹平不影响语义的差异（全半角、行尾空白、CRLF、零宽字符），
 * 不做大小写折叠、不去标点——那会让「他没来」和「他来了」被判成同一句。
 */

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g

/** 统一换行与零宽字符，NFKC 处理全半角（全角引号、括号、数字都会归一）。 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/u, ''))
    .join('\n')
    .trim()
}

/** 比较用：归一化后逐字相等。 */
export function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right)
}

/** 子串校验用：两端都归一化；`needle` 为空视为不通过（空 quote 不算证据）。 */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const target = normalizeText(needle)
  if (target.length === 0) return false
  return normalizeText(haystack).includes(target)
}

/** 纯空白归一（grounding 的 quote 只要求「连续子串」；不要求标点一致）。 */
export function collapseWhitespace(input: string): string {
  return normalizeText(input).replace(/\s+/g, ' ')
}
