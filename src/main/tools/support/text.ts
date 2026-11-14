/**
 * 中文检索的确定性基线（阶段 09 会替换为 sqlite-vec + FTS）。
 * 这里用 bigram 交集做打分：无分词器、无网络、跨平台一致，便于契约测试固定结果。
 */

export function normalizeText(input: string): string {
  return input.normalize('NFKC').toLowerCase()
}

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/

/** 中文按相邻二字切片，拉丁按词切片；单字查询保留单字。 */
export function bigrams(input: string): Set<string> {
  const text = normalizeText(input)
  const tokens = new Set<string>()
  let cjkRun = ''

  const flushCjk = (): void => {
    if (cjkRun.length === 1) tokens.add(cjkRun)
    for (let index = 0; index + 1 < cjkRun.length; index += 1) {
      tokens.add(cjkRun.slice(index, index + 2))
    }
    cjkRun = ''
  }

  let latin = ''
  const flushLatin = (): void => {
    if (latin.length >= 2) tokens.add(latin)
    latin = ''
  }

  for (const ch of text) {
    if (CJK.test(ch)) {
      flushLatin()
      cjkRun += ch
    } else if (/[a-z0-9]/.test(ch)) {
      flushCjk()
      latin += ch
    } else {
      flushCjk()
      flushLatin()
    }
  }
  flushCjk()
  flushLatin()
  return tokens
}

export interface Scored {
  score: number
  hits: number
}

/** 查询 token 在文本中的命中比例；命中数用于同分排序。 */
export function scoreText(text: string, query: string): Scored {
  const queryTokens = bigrams(query)
  if (queryTokens.size === 0) return { score: 0, hits: 0 }
  const textTokens = bigrams(text)
  let hits = 0
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1
  return { score: hits / queryTokens.size, hits }
}

/** 章节目标脱敏：只取第一行/第一句，超长截断（不做语义摘要）。 */
export function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0) ?? ''
  const sentence = line.split(/[。！？!?]/)[0]?.trim() ?? ''
  const value = sentence.length > 0 ? sentence : line.trim()
  return [...value].slice(0, max).join('')
}

/** as_of 只能向前读：模型传未来值会被夹到运行时水位（PRD §4.10 T13）。 */
export function clampAsOf(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isFinite(requested)) return ceiling
  return Math.max(0, Math.min(Math.trunc(requested), ceiling))
}
