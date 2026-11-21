/**
 * 声音指标纯函数（PHASE-19 §5.1）。
 *
 * 这一层没有 import：`scripts/calibrate-voice.mjs` 直接用 Node 的类型剥离
 * 加载本文件来跑阈值校准，任何依赖都会让脚本与测试的口径分叉。
 * 不读库、不调模型、不看时间；同样的输入必须逐字段相同。
 */

/** 句长桶：1–10 / 11–20 / 21–30 / 31–40 / 41–60 / 60+（PHASE-19 §5.1）。 */
export const VOICE_HISTOGRAM_BUCKETS = 6

const BOUNDARY = new Set(['。', '！', '？', '!', '?', '…'])
const CLOSERS = new Set(['」', '』', '”', '"', '’', '）', ')', '】'])

/** NFKC 后去掉所有空白；空句丢弃。 */
export function normalizeVoiceText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '')
}

/**
 * 分句：以 `。！？!?…` 与换行为界；连续终止符（如 `……`、`？！`）算同一句，
 * 终止符后的收尾引号/括号并入前一句。保留引号本身。
 */
export function splitSentences(text: string): string[] {
  // 先按原文分句再逐句 NFKC：NFKC 会把「……」变成「......」，
  // 提前归一化会让省略号失去句末语义。
  const source = text
  const sentences: string[] = []
  let buffer = ''

  const flush = (): void => {
    const normalized = normalizeVoiceText(buffer)
    // 纯标点（如「……」「？？」）不算句子；空句丢弃（PHASE-19 §5.1）。
    if (normalized.length > 0 && /[\p{L}\p{N}]/u.test(normalized)) sentences.push(normalized)
    buffer = ''
  }

  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      flush()
      index += 1
      continue
    }
    buffer += char
    if (!BOUNDARY.has(char)) {
      index += 1
      continue
    }
    index += 1
    while (index < source.length && BOUNDARY.has(source[index]!)) {
      buffer += source[index]!
      index += 1
    }
    while (index < source.length && CLOSERS.has(source[index]!)) {
      buffer += source[index]!
      index += 1
    }
    flush()
  }
  flush()
  return sentences
}

/** 句长（去空白后的字符数，按 code point 计）→ 6 桶归一化直方图。 */
export function sentenceLengthHistogram(lengths: readonly number[]): number[] {
  const counts = new Array<number>(VOICE_HISTOGRAM_BUCKETS).fill(0)
  for (const length of lengths) {
    const bucket = bucketOf(length)
    counts[bucket] = (counts[bucket] ?? 0) + 1
  }
  const total = lengths.length
  return counts.map((count) => (total === 0 ? 0 : round4(count / total)))
}

function bucketOf(length: number): number {
  if (length <= 10) return 0
  if (length <= 20) return 1
  if (length <= 30) return 2
  if (length <= 40) return 3
  if (length <= 60) return 4
  return 5
}

/** √JSD（底 2）：两个句长直方图的 Jensen–Shannon 距离开方，范围 0–1。 */
export function sentenceLengthJsd(p: readonly number[], q: readonly number[]): number {
  const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0)
  // 空分布不参与比较：没有句子时 0 不代表「相同」。
  if (total(p) <= 0 || total(q) <= 0) return 0
  const size = Math.max(p.length, q.length)
  let jsd = 0
  for (let index = 0; index < size; index += 1) {
    const left = p[index] ?? 0
    const right = q[index] ?? 0
    if (left <= 0 && right <= 0) continue
    const mean = (left + right) / 2
    if (left > 0 && mean > 0) jsd += 0.5 * left * Math.log2(left / mean)
    if (right > 0 && mean > 0) jsd += 0.5 * right * Math.log2(right / mean)
  }
  return round4(Math.sqrt(Math.max(0, jsd)))
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return round4(value)
}

export interface VoiceBeatInput {
  /** 拍在章内的叙事序；只用于稳定排序。 */
  ord: number
  body: string
}

export interface VoiceCharacterInput {
  characterId: string
  name: string
  /** 角色卡 `voice.catchphrase` 原文（按 `、，,` 切分，2–8 字）。 */
  catchphrase: string
  beats: VoiceBeatInput[]
}

export interface VoiceCharacterMetrics {
  characterId: string
  name: string
  beatCount: number
  sentenceCount: number
  avgSentenceLength: number
  histogram: number[]
  catchphraseRate: number
  questionRate: number
  firstPersonRate: number
  /** 命中率用到的候选（角色卡口头禅 + 拍内重复 n-gram），最多 24 个。 */
  catchphrases: string[]
}

export interface VoicePairMetrics {
  a: string
  b: string
  aName: string
  bName: string
  score: number
  sentenceLengthJsd: number
  catchphraseDelta: number
  questionDelta: number
  firstPersonDelta: number
}

export interface VoiceAggregate {
  sentenceLengthJsd: number
  catchphraseRate: number
  questionRate: number
  firstPersonRate: number
  /** 最低一对；没有角色对时为 0。 */
  pairwiseDistinctness: number
}

export interface VoiceMetrics {
  characters: VoiceCharacterMetrics[]
  pairs: VoicePairMetrics[]
  aggregate: VoiceAggregate
  /** true = 角色少于 2 人或某角色少于 2 拍；此时 pairs 为空，0 不代表「很区分」。 */
  insufficientData: boolean
}

const CANDIDATE_PATTERN = /^[\p{Script=Han}A-Za-z0-9]+$/u

/** 口头禅候选：角色卡给的（2–8 字） ∪ 该角色拍内重复 ≥3 次的 2–6 字 n-gram。 */
export function catchphraseCandidates(character: VoiceCharacterInput): string[] {
  const fromCard = character.catchphrase
    .split(/[、，,]/u)
    .map((item) => normalizeVoiceText(item))
    .filter((item) => item.length >= 2 && item.length <= 8)

  const counts = new Map<string, number>()
  for (const beat of character.beats) {
    const text = normalizeVoiceText(beat.body)
    for (let size = 2; size <= 6; size += 1) {
      for (let start = 0; start + size <= text.length; start += 1) {
        const gram = text.slice(start, start + size)
        if (!CANDIDATE_PATTERN.test(gram)) continue
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  const repeated = [...counts.entries()]
    .filter(([gram, count]) => count >= 3 && gram.length >= 2)
    .sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, 24)
    .map(([gram]) => gram)

  return [...new Set([...fromCard, ...repeated])].sort()
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round4(numerator / denominator)
}

/** 单个角色的句长、口头禅、问句与第一人称指标（确定性）。 */
export function computeCharacterMetrics(character: VoiceCharacterInput): VoiceCharacterMetrics {
  const beats = [...character.beats].sort((left, right) => left.ord - right.ord)
  const sentences = beats.flatMap((beat) => splitSentences(beat.body))
  const lengths = sentences.map((sentence) => [...sentence].length)
  const candidates = catchphraseCandidates({ ...character, beats })
  const questionCount = sentences.filter((sentence) => /[？?]$/u.test(sentence)).length
  const firstPersonCount = sentences.filter((sentence) => /[我咱俺]/u.test(sentence)).length
  const withCatchphrase = beats.filter((beat) => {
    const text = normalizeVoiceText(beat.body)
    return candidates.some((candidate) => text.includes(candidate))
  }).length

  return {
    characterId: character.characterId,
    name: character.name,
    beatCount: beats.length,
    sentenceCount: sentences.length,
    avgSentenceLength:
      lengths.length === 0 ? 0 : round4(lengths.reduce((sum, length) => sum + length, 0) / lengths.length),
    histogram: sentenceLengthHistogram(lengths),
    catchphraseRate: rate(withCatchphrase, beats.length),
    questionRate: rate(questionCount, sentences.length),
    firstPersonRate: rate(firstPersonCount, sentences.length),
    catchphrases: candidates
  }
}

/** 两人区分度：0.55×√JSD + 0.15×口头禅差 + 0.15×问句差 + 0.15×第一人称差。 */
export function pairDistinctness(left: VoiceCharacterMetrics, right: VoiceCharacterMetrics): VoicePairMetrics {
  const jsd = sentenceLengthJsd(left.histogram, right.histogram)
  const catchphraseDelta = round4(Math.abs(left.catchphraseRate - right.catchphraseRate))
  const questionDelta = round4(Math.abs(left.questionRate - right.questionRate))
  const firstPersonDelta = round4(Math.abs(left.firstPersonRate - right.firstPersonRate))
  const score = clamp01(0.55 * jsd + 0.15 * catchphraseDelta + 0.15 * questionDelta + 0.15 * firstPersonDelta)
  return {
    a: left.characterId,
    b: right.characterId,
    aName: left.name,
    bName: right.name,
    score,
    sentenceLengthJsd: jsd,
    catchphraseDelta,
    questionDelta,
    firstPersonDelta
  }
}

function emptyAggregate(): VoiceAggregate {
  return {
    sentenceLengthJsd: 0,
    catchphraseRate: 0,
    questionRate: 0,
    firstPersonRate: 0,
    pairwiseDistinctness: 0
  }
}

/** 场景汇总：两两区分度取最低一对；句长 JSD 与三个比率取各对的平均。 */
export function computeVoiceMetrics(input: { characters: readonly VoiceCharacterInput[] }): VoiceMetrics {
  const characters = [...input.characters]
    .sort((left, right) => (left.characterId < right.characterId ? -1 : left.characterId > right.characterId ? 1 : 0))
    .map((character) => computeCharacterMetrics(character))

  if (characters.length < 2 || characters.some((character) => character.beatCount < 2)) {
    return { characters, pairs: [], aggregate: emptyAggregate(), insufficientData: true }
  }

  const pairs: VoicePairMetrics[] = []
  for (let left = 0; left < characters.length; left += 1) {
    for (let right = left + 1; right < characters.length; right += 1) {
      pairs.push(pairDistinctness(characters[left]!, characters[right]!))
    }
  }
  pairs.sort((first, second) => {
    if (first.a !== second.a) return first.a < second.a ? -1 : 1
    if (first.b !== second.b) return first.b < second.b ? -1 : 1
    return 0
  })

  const mean = (pick: (pair: VoicePairMetrics) => number): number =>
    round4(pairs.reduce((sum, pair) => sum + pick(pair), 0) / pairs.length)
  const meanOfPairRate = (pick: (character: VoiceCharacterMetrics) => number): number => {
    const byId = new Map(characters.map((character) => [character.characterId, character]))
    const values = pairs.map((pair) => {
      const left = byId.get(pair.a)!
      const right = byId.get(pair.b)!
      return (pick(left) + pick(right)) / 2
    })
    return round4(values.reduce((sum, value) => sum + value, 0) / values.length)
  }

  return {
    characters,
    pairs,
    aggregate: {
      sentenceLengthJsd: mean((pair) => pair.sentenceLengthJsd),
      catchphraseRate: meanOfPairRate((character) => character.catchphraseRate),
      questionRate: meanOfPairRate((character) => character.questionRate),
      firstPersonRate: meanOfPairRate((character) => character.firstPersonRate),
      pairwiseDistinctness: pairs.reduce((min, pair) => Math.min(min, pair.score), 1)
    },
    insufficientData: false
  }
}
