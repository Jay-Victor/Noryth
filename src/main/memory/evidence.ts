/**
 * 证据校验（PHASE-09 H1 / DEV-PLAN §10.1）。
 *
 * 唯一规则：`quote` 归一化后必须是来源拍正文的连续子串。
 * 归一化只做「等价字符」层面的处理（NFKC / 行尾空白 / 零宽字符），
 * 不做同义改写、不做分词重组——改写过的引用一律不认。
 *
 * 这一层是纯函数，既被工具 T37 调用，也被抽取服务调用：
 * 两条写入路径共用同一个校验，避免「模型走工具就松、走服务就严」。
 */

export function normalizeEvidenceText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .trim()
}

export type EvidenceReason =
  | 'missing_beat'
  | 'missing_quote'
  | 'beat_not_in_revision'
  | 'quote_not_substring'

export interface EvidenceCheck {
  ok: boolean
  reason: EvidenceReason | null
  quote: string
}

/** 引文是否出现在正文里（都先归一化）。 */
export function quoteInBody(quote: string, body: string): boolean {
  const needle = normalizeEvidenceText(quote)
  if (needle.length === 0) return false
  return normalizeEvidenceText(body).includes(needle)
}

export interface EvidenceInput {
  beatId: string | null | undefined
  quote: string | null | undefined
  /** 定稿清单里的拍：beatId → body。只查这张表，不回数据库取草稿。 */
  bodies: ReadonlyMap<string, string>
}

export function checkEvidence(input: EvidenceInput): EvidenceCheck {
  const quote = (input.quote ?? '').trim()
  const beatId = (input.beatId ?? '').trim()
  if (beatId.length === 0) return { ok: false, reason: 'missing_beat', quote }
  if (quote.length === 0) return { ok: false, reason: 'missing_quote', quote }
  const body = input.bodies.get(beatId)
  if (body === undefined) return { ok: false, reason: 'beat_not_in_revision', quote }
  if (!quoteInBody(quote, body)) return { ok: false, reason: 'quote_not_substring', quote }
  return { ok: true, reason: null, quote }
}
