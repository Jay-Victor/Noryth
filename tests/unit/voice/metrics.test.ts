import { describe, expect, it } from 'vitest'
import {
  catchphraseCandidates,
  clamp01,
  computeCharacterMetrics,
  computeVoiceMetrics,
  normalizeVoiceText,
  sentenceLengthHistogram,
  sentenceLengthJsd,
  splitSentences,
  type VoiceCharacterInput
} from '../../../src/main/voice/metrics'

/** PHASE-19 §5.1：分句、句长、√JSD、口头禅、问句、第一人称、两两区分度。 */

const short: VoiceCharacterInput = {
  characterId: 'chr_a',
  name: '沈昼',
  catchphrase: '罢了',
  beats: [
    { ord: 1, body: '灯灭了。雨停了。' },
    { ord: 2, body: '门没锁。罢了，先回去。' }
  ]
}

const long: VoiceCharacterInput = {
  characterId: 'chr_b',
  name: '林晚',
  catchphrase: '你知道的',
  beats: [
    { ord: 1, body: '我一直在想，父亲把那只黑漆匣子藏在祠堂，究竟是在躲谁？' },
    { ord: 2, body: '你有没有想过，那天夜里他为什么宁肯守着冷灶，也不肯点灯？' }
  ]
}

describe('分句', () => {
  it('以句末标点与换行为界，连续终止符算同一句，收尾引号并入前句', () => {
    // NFKC 会把省略号展开成三个点，句长按归一化后的字符数计。
    expect(splitSentences('他走了……她没有回头。')).toEqual(['他走了......', '她没有回头。'])
    expect(splitSentences('第一句\n第二句')).toEqual(['第一句', '第二句'])
    expect(splitSentences('「见过。匣子不在书房。」他说。')).toEqual([
      '「见过。',
      '匣子不在书房。」',
      '他说。'
    ])
    expect(splitSentences('？？')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })

  it('NFKC 后去空白，保留引号', () => {
    expect(normalizeVoiceText(' 「你 好」 ')).toBe('「你好」')
  })
})

describe('句长与 √JSD', () => {
  it('直方图按 1–10 / 11–20 / 21–30 / 31–40 / 41–60 / 60+ 归一化', () => {
    expect(sentenceLengthHistogram([4, 7, 15, 25, 35, 50, 80])).toEqual([0.2857, 0.1429, 0.1429, 0.1429, 0.1429, 0.1429])
    expect(sentenceLengthHistogram([])).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('相同分布为 0，完全不相交为 1', () => {
    const left = [1, 0, 0, 0, 0, 0]
    expect(sentenceLengthJsd(left, left)).toBe(0)
    expect(sentenceLengthJsd([1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1])).toBe(1)
    expect(sentenceLengthJsd([], [0, 0, 0, 0, 0, 1])).toBe(0)
  })

  it('clamp01 只收 0–1，非有限值归零', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(0.123456)).toBe(0.1235)
    expect(clamp01(Number.NaN)).toBe(0)
  })
})

describe('逐角色指标', () => {
  it('句长、问句率、第一人称率与口头禅率', () => {
    const metrics = computeCharacterMetrics(short)
    expect(metrics.beatCount).toBe(2)
    expect(metrics.sentenceCount).toBe(4)
    expect(metrics.avgSentenceLength).toBe(4.75)
    expect(metrics.histogram).toEqual([1, 0, 0, 0, 0, 0])
    expect(metrics.questionRate).toBe(0)
    expect(metrics.firstPersonRate).toBe(0)
    // 角色卡口头禅「罢了」命中第 2 拍
    expect(metrics.catchphraseRate).toBe(0.5)
    expect(metrics.catchphrases).toContain('罢了')

    const lin = computeCharacterMetrics(long)
    expect(lin.questionRate).toBe(1)
    // 第二句是「你有没有想过」，没有第一人称
    expect(lin.firstPersonRate).toBe(0.5)
    expect(lin.sentenceCount).toBe(2)
  })

  it('拍内重复 ≥3 次的 2–6 字 n-gram 进入候选；不跨标点', () => {
    const repeated: VoiceCharacterInput = {
      characterId: 'chr_c',
      name: 'C',
      catchphrase: '',
      beats: [
        { ord: 1, body: '匣子在供桌下面。匣子不能动。' },
        { ord: 2, body: '匣子的事，别提。' },
        { ord: 3, body: '走吧。' }
      ]
    }
    const candidates = catchphraseCandidates(repeated)
    expect(candidates).toContain('匣子')
    expect(candidates.some((item) => item.includes('。'))).toBe(false)
    // 两句含「匣子」，第三句不含
    expect(computeCharacterMetrics(repeated).catchphraseRate).toBe(0.6667)
  })
})

describe('场景指标', () => {
  it('两两区分度按公式合成，最低一对是聚合值', () => {
    const metrics = computeVoiceMetrics({ characters: [short, long] })
    expect(metrics.insufficientData).toBe(false)
    expect(metrics.pairs).toHaveLength(1)
    const pair = metrics.pairs[0]!
    expect(pair.a).toBe('chr_a')
    expect(pair.b).toBe('chr_b')
    expect(pair.aName).toBe('沈昼')
    expect(pair.sentenceLengthJsd).toBeGreaterThan(0.5)
    expect(pair.questionDelta).toBe(1)
    expect(pair.firstPersonDelta).toBe(0.5)
    const expected = clamp01(
      0.55 * pair.sentenceLengthJsd + 0.15 * pair.catchphraseDelta + 0.15 * 1 + 0.15 * 0.5
    )
    expect(pair.score).toBe(expected)
    expect(metrics.aggregate.pairwiseDistinctness).toBe(pair.score)
    expect(metrics.aggregate.questionRate).toBe(0.5)
    // 聚合的比率是「各对角色值的平均」：(0 + 0.5) / 2
    expect(metrics.aggregate.firstPersonRate).toBe(0.25)
  })

  it('少于 2 个角色或某角色少于 2 拍：pairs 为空、insufficientData=true、聚合值为 0', () => {
    const only = computeVoiceMetrics({ characters: [short] })
    expect(only.pairs).toEqual([])
    expect(only.insufficientData).toBe(true)
    expect(only.aggregate).toEqual({
      sentenceLengthJsd: 0,
      catchphraseRate: 0,
      questionRate: 0,
      firstPersonRate: 0,
      pairwiseDistinctness: 0
    })

    const oneBeat: VoiceCharacterInput = { ...long, beats: [long.beats[0]!] }
    const insufficient = computeVoiceMetrics({ characters: [short, oneBeat] })
    expect(insufficient.pairs).toEqual([])
    expect(insufficient.insufficientData).toBe(true)
    expect(insufficient.characters).toHaveLength(2)
  })

  it('同一输入两次逐字段相等；角色顺序颠倒结果不变', () => {
    const first = computeVoiceMetrics({ characters: [short, long] })
    const second = computeVoiceMetrics({ characters: [short, long] })
    const reversed = computeVoiceMetrics({ characters: [long, short] })
    expect(second).toEqual(first)
    expect(reversed).toEqual(first)
    expect(reversed.characters.map((item) => item.characterId)).toEqual(['chr_a', 'chr_b'])
  })

  it('三个角色两两都算，角色对按 (a,b) 排序', () => {
    const third: VoiceCharacterInput = {
      characterId: 'chr_0',
      name: '阿箬',
      catchphrase: '成吧',
      beats: [
        { ord: 1, body: '咱不懂这些弯弯绕。成吧。' },
        { ord: 2, body: '咱跟你走。' }
      ]
    }
    const metrics = computeVoiceMetrics({ characters: [short, long, third] })
    expect(metrics.pairs.map((pair) => `${pair.a}/${pair.b}`)).toEqual([
      'chr_0/chr_a',
      'chr_0/chr_b',
      'chr_a/chr_b'
    ])
    expect(metrics.aggregate.pairwiseDistinctness).toBe(
      metrics.pairs.reduce((min, pair) => Math.min(min, pair.score), 1)
    )
  })
})
