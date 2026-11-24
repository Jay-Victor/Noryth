import { describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../../src/main/context/assemble'
import { assembleContext, assembleContextBaseline } from '../../../src/main/context/assemble'
import { estimateTokens } from '../../../src/main/context/tokens'
import { renderPrompt } from '../../../src/main/agents/prompts'

/**
 * 上下文成本（PHASE-22 §5.5 / M2-9，COST-M2-02）。
 *
 * 同一 30 章夹具、同一绑定、同一估算器，跑两遍：
 *   - baseline：优化前装配（不去重、旁观者按顺序取 8、最近拍可降到 2）；
 *   - optimized：块去重、旁观者相关裁、最近拍先降到 4。
 *
 * 统计的是**送进模型前的提示词估算 token**（system + user，含 L0–L3），
 * 即 `tokens_in` 的可复现代理；不调用模型、不写数据库。
 *
 * 夹具刻意还原 M2 目标场景：30 章累积的低重要度重复记忆 + 8 名旁观者的群戏。
 * 结论只适用于同一夹具；真实项目见 `docs/M2-CONTEXT-COST.md` 的局限说明。
 */

const CHAPTERS = 30
const BEATS_PER_CHAPTER = 6
const SPEAKER = 'chr_shen'
const NAMES = ['阿岚', '老周', '小满', '程砚', '刘婆', '阿七', '二顺', '春桃']

const LONG_BEAT =
  '她把茶盏推过去，声音压得很低。窗外的雨敲在瓦上，像有人在数拍子；他低头拨了拨灯芯，' +
  '没有立刻回答。她盯着他的手指，指节因为用力而发白，桌上的影子被灯拉得很长。'.repeat(2)

const REF_TEXT =
  '黑漆匣子藏在祠堂供桌下面，匣盖上有一道细长的裂纹；父亲生前从不让人碰它，钥匙挂在账房梁上。'

function spectator(name: string, tension: number): AssembleInput['spectators'][number] {
  return {
    id: `chr_${name}`,
    name,
    card: {},
    location: '祠堂正厅',
    emotion: '警惕',
    known: ['账本在祠堂', '父亲书房里有一只匣子', '雨夜有人来过'],
    unknown: ['匣子里装着什么', '谁拿走了账房的钥匙'],
    tension
  }
}

function fixture(chapterOrd: number, beatIndex: number): AssembleInput {
  const goal = beatIndex % 2 === 0 ? '阿岚逼问账本下落，老周装傻' : '众人僵持，雨声渐大'
  return {
    agent: `character:${SPEAKER}`,
    beat: {
      id: `bt_${chapterOrd}_${beatIndex}`,
      ord: beatIndex + 1,
      speakerType: 'character',
      speakerId: SPEAKER,
      intent: `${goal}；本拍由沈昼回应`,
      maxWords: 200
    },
    chapter: {
      id: `ch_${chapterOrd}`,
      ord: chapterOrd,
      title: `第 ${chapterOrd} 章 · 祠堂夜谈`,
      goal,
      coreEvent: '黑漆匣子的下落被再次提起',
      sceneSequence: ['祠堂正厅：众人对峙', '后院：雨夜追索'],
      forbiddenReveals: ['匣子里的东西是账本']
    },
    scene: {
      id: `scn_${chapterOrd}_1`,
      ord: 1,
      location: '祠堂正厅',
      participants: [SPEAKER, ...NAMES.map((name) => `chr_${name}`)],
      goal,
      entry: '众人围着供桌坐下',
      exit: '阿岚起身离开',
      previousResult: '上一场：账本被提到'
    },
    speaker: {
      id: SPEAKER,
      name: '沈昼',
      card: {
        identity: '账房先生的养子',
        want: '查清父亲的死因',
        fear: '被逐出族谱',
        taboo: '父亲的书房',
        voice: '短句、少用形容词'
      }
    },
    spectators: [
      spectator('阿岚', 0.82),
      spectator('老周', 0.7),
      spectator('小满', 0.5),
      spectator('程砚', 0.5),
      spectator('刘婆', 0.5),
      spectator('阿七', 0.5),
      spectator('二顺', 0.5),
      spectator('春桃', 0.5)
    ],
    pinned: [
      { refType: 'memory', id: `mem_pin_${chapterOrd}`, text: REF_TEXT, score: 1, importance: 0.9, pinned: true },
      { refType: 'belief', id: `bel_pin_${chapterOrd}`, text: '相信账本在祠堂', score: 1, importance: 0.85, pinned: true }
    ],
    // 3 条文本相同的低重要度重复记忆（真实抽取噪声），2 条独特检索。
    retrieved: [
      { refType: 'memory', id: `mem_dup_${chapterOrd}_a`, text: REF_TEXT, score: 0.9, importance: 0.2, pinned: false },
      { refType: 'memory', id: `mem_dup_${chapterOrd}_b`, text: REF_TEXT, score: 0.88, importance: 0.2, pinned: false },
      { refType: 'memory', id: `mem_dup_${chapterOrd}_c`, text: REF_TEXT, score: 0.86, importance: 0.2, pinned: false },
      {
        refType: 'memory',
        id: `mem_uniq_${chapterOrd}`,
        text: '他记得父亲在雨夜提过一只上锁的匣子，钥匙从不离身，后来钥匙不见了。',
        score: 0.8,
        importance: 0.5,
        pinned: false
      },
      {
        refType: 'fact',
        id: `fact_${chapterOrd}`,
        text: '账本 持有人 父亲',
        score: 0.7,
        importance: 0.8,
        pinned: false
      }
    ],
    recentBeats: Array.from({ length: BEATS_PER_CHAPTER }, (_, index) => ({
      id: `bt_${chapterOrd}_${index}`,
      seq: chapterOrd * 100 + index,
      ord: index + 1,
      speakerType: index % 2 === 0 ? 'character' : 'narrator',
      speakerId: index % 2 === 0 ? SPEAKER : 'narrator',
      body: LONG_BEAT,
      status: 'confirmed'
    })),
    previousSummary: {
      chapterId: `ch_${chapterOrd - 1}`,
      chapterOrd: Math.max(1, chapterOrd - 1),
      chapterTitle: '上一章',
      text:
        '上一章里，沈昼和阿岚在祠堂夜谈，账本的下落被反复提起；老周始终装傻，小满在门外听见了半句。' +
        '雨下了一整夜，父亲书房里的灯亮到天明，钥匙却不见了。'.repeat(2)
    }
  }
}

function promptTokens(input: AssembleInput, bundle: ReturnType<typeof assembleContext>['bundle']): number {
  const rendered = renderPrompt({ agentKey: input.agent, bundle })
  return rendered.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, position)]!
}

describe('上下文成本（COST-M2-02）', () => {
  it('同一 30 章夹具：优化后单拍提示词 token 中位数下降 ≥15%，P95 不升，裁剪不升', () => {
    const baselineTokens: number[] = []
    const optimizedTokens: number[] = []
    let baselineTrimmed = 0
    let optimizedTrimmed = 0
    let overflow = 0
    let samples = 0

    for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
      for (let beat = 0; beat < BEATS_PER_CHAPTER; beat += 1) {
        const input = fixture(chapter, beat)
        const baseline = assembleContextBaseline(input)
        const optimized = assembleContext(input)
        baselineTokens.push(promptTokens(input, baseline.bundle))
        optimizedTokens.push(promptTokens(input, optimized.bundle))
        if (baseline.bundle.degraded.includes('context_trimmed')) baselineTrimmed += 1
        if (optimized.bundle.degraded.includes('context_trimmed')) optimizedTrimmed += 1
        if (optimized.bundle.totalTokens > 12000 || baseline.bundle.totalTokens > 12000) overflow += 1
        samples += 1
      }
    }

    const baselineMedian = median(baselineTokens)
    const optimizedMedian = median(optimizedTokens)
    const drop = 1 - optimizedMedian / baselineMedian
    const baselineP95 = p95(baselineTokens)
    const optimizedP95 = p95(optimizedTokens)
    const trimmedDelta = optimizedTrimmed / samples - baselineTrimmed / samples

    expect(samples).toBe(CHAPTERS * BEATS_PER_CHAPTER)
    expect(drop).toBeGreaterThanOrEqual(0.15)
    expect(optimizedP95).toBeLessThanOrEqual(baselineP95)
    expect(trimmedDelta).toBeLessThanOrEqual(0.05)
    expect(overflow).toBe(0)
  })

  it('块去重：pinned 优先；同 (type,id) 与同文本只保留一份', () => {
    const input = fixture(20, 0)
    const result = assembleContext(input)
    const ids = result.bundle.blocks.map((block) => block.id)
    expect(ids).toContain(`L2:pinned:memory:mem_pin_20`)
    expect(ids).not.toContain('L2:ref:memory:mem_pin_20')
    // pinned 已有同文本；三条同文本重复全部被去掉（不再占检索名额）。
    expect(ids).not.toContain('L2:ref:memory:mem_dup_20_a')
    expect(ids).not.toContain('L2:ref:memory:mem_dup_20_b')
    expect(ids).not.toContain('L2:ref:memory:mem_dup_20_c')
    // 引用集合不因去重而消失：独特条目仍在。
    expect(ids).toContain('L2:ref:memory:mem_uniq_20')
    expect(result.refs.length).toBeGreaterThan(0)
  })

  it('L3 旁观者：相关者优先，零相关者最多补到 4；上限仍是 8', () => {
    const input = fixture(20, 0)
    const optimized = assembleContext(input)
    const baseline = assembleContextBaseline(input)
    const count = (bundle: { blocks: Array<{ role: string }> }): number =>
      bundle.blocks.filter((block) => block.role === 'spectator').length

    // 阿岚/老周：场景目标点名 + 有张力；其余 6 人零相关。
    expect(count(baseline.bundle)).toBe(8)
    expect(count(optimized.bundle)).toBe(4)
    const names = optimized.bundle.blocks
      .filter((block) => block.role === 'spectator')
      .map((block) => block.text)
      .join('\n')
    expect(names).toContain('阿岚')
    expect(names).toContain('老周')
    expect(names).not.toContain('春桃')
    expect(count(optimized.bundle)).toBeLessThanOrEqual(8)
  })

  it('确定性：同一输入两次装配块顺序与 token 完全一致', () => {
    const input = fixture(7, 3)
    const first = assembleContext(input)
    const second = assembleContext(input)
    expect(second.bundle).toEqual(first.bundle)
    expect(second.refs).toEqual(first.refs)
    expect(second.bundle.totalTokens).toBe(first.bundle.totalTokens)
  })
})
