/**
 * 质量仪器 · 声音区分度。
 *
 * 多角色 AI 小说最常见的失败不是逻辑错，是所有人说话像同一个人。
 * voice_distance ∈ [0,1]；阈值 0.18 低于则提示"两人声音过于接近"。
 * 纯统计，无模型调用。
 */

const LEN_BUCKETS: readonly (readonly [number, number])[] = [
  [0, 8],
  [9, 16],
  [17, 28],
  [29, Number.MAX_SAFE_INTEGER],
];
const PARTICLES = '的了呢吧啊哦嘛呀';

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 按句末标点切句；连续标点产生的空句被丢弃。空输入返回 [t]（与探针一致）。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if ('。！？…\n'.includes(ch)) {
      const sentence = buf.trim();
      if (sentence) out.push(sentence);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [text];
}

function lengthDistribution(texts: readonly string[]): number[] {
  const dist = [0, 0, 0, 0];
  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      const len = Array.from(sentence).length;
      for (let i = 0; i < LEN_BUCKETS.length; i += 1) {
        const [lo, hi] = LEN_BUCKETS[i]!;
        if (len >= lo && len <= hi) {
          dist[i] = dist[i]! + 1;
          break;
        }
      }
    }
  }
  const total = dist.reduce((a, b) => a + b, 0) || 1;
  return dist.map((n) => n / total);
}

function rates(texts: readonly string[]): [number, number, number] {
  let charCount = 0;
  let particles = 0;
  let firstPerson = 0;
  let questions = 0;
  for (const text of texts) {
    const chars = Array.from(text);
    charCount += chars.length;
    for (const ch of chars) if (PARTICLES.includes(ch)) particles += 1;
    if ('我俺咱'.includes(chars[0] ?? '')) firstPerson += 1;
    const trimmed = chars.join('').trimEnd();
    if ('？？'.includes(trimmed.slice(-1))) questions += 1;
  }
  const n = charCount || 1;
  const len = texts.length || 1;
  return [
    clamp((particles / n) * 4, 0, 1),
    clamp(firstPerson / len, 0, 1),
    clamp(questions / len, 0, 1),
  ];
}

function jsDivergence(p: readonly number[], q: readonly number[]): number {
  const m = p.map((v, i) => (v + q[i]!) / 2);
  const kl = (x: readonly number[], y: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < x.length; i += 1) {
      const a = x[i]!;
      const b = y[i]!;
      if (a > 0 && b > 0) sum += a * Math.log2(a / b);
    }
    return sum;
  };
  return Math.max(0, 0.5 * kl(p, m) + 0.5 * kl(q, m));
}

/**
 * 0.6·√JSD(句长分布) + 0.4·mean(|Δ口头禅密度|, |Δ第一人称率|, |Δ问句率|)。
 * 合成文本上只能验证"指标本身可分"，真实区分度必须靠人工盲测。
 */
export function voiceDistance(aTexts: readonly string[], bTexts: readonly string[]): number {
  if (aTexts.length === 0 || bTexts.length === 0) return 0;
  const j = Math.sqrt(jsDivergence(lengthDistribution(aTexts), lengthDistribution(bTexts)));
  const ra = rates(aTexts);
  const rb = rates(bTexts);
  const gap = (Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2])) / 3;
  return clamp(0.6 * j + 0.4 * gap, 0, 1);
}
