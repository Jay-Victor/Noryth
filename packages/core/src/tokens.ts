import { TOK_CJK, TOK_LATIN } from './params.js';

/** Python round()：四舍六入五成双。JS Math.round 在 .5 上不同，会漂 token 计数。 */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * O(n)。CJK 与 ASCII 分开计数，避免把中文按英文 4 字符/token 算少 2.6 倍。
 * 这是启发式估算（±15%），不是真分词器；上线前用目标模型 tokenizer 校准。
 */
export function estTokens(text: string): number {
  if (!text) return 0;
  const chars = Array.from(text);
  let cjk = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f)) {
      cjk += 1;
    }
  }
  return roundHalfEven(cjk * TOK_CJK + (chars.length - cjk) * TOK_LATIN);
}
