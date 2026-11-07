/**
 * 词面通道的分词器：中文按二元组，ASCII 按单词。
 *
 * 为什么是二元组：中文没有空格，单字切分把"上海"和"海上"当成同一个词袋；
 * 二元组能把"账本"与"账房"分开。代价是同义词召回不了——这是已知缺口
 * （05-roadmap.md §P2："跨措辞召回依赖嵌入模型能力，hash 占位嵌入下必然失败"），
 * 不拿它冒充语义检索。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

/** 归一化：NFKC + 小写；去掉标点与空白。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * 中文二元组 + ASCII 单词（长度 ≥ 2）。
 * 单个汉字成词（如"信"）时保留单字，否则这一条永远召不回来。
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token.length === 0 || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i]!;
    if (isCjk(char)) {
      let end = i + 1;
      while (end < normalized.length && isCjk(normalized[end]!)) end += 1;
      const run = normalized.slice(i, end);
      if (run.length === 1) {
        push(run);
      } else {
        for (let j = 0; j + 1 < run.length; j += 1) push(run.slice(j, j + 2));
      }
      i = end;
      continue;
    }
    if (/[a-z0-9]/.test(char)) {
      let end = i + 1;
      while (end < normalized.length && /[a-z0-9]/.test(normalized[end]!)) end += 1;
      const word = normalized.slice(i, end);
      if (word.length >= 2) push(word);
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 词面相似度（Jaccard）；没有嵌入时的 MMR 去冗余退路。 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}
