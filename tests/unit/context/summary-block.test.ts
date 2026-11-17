import { describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../../src/main/context/assemble'
import { assembleContext } from '../../../src/main/context/assemble'
import { fitToBudget } from '../../../src/main/context/budget'
import { estimateTokens } from '../../../src/main/context/tokens'

/**
 * 上一章摘要进 L0（PHASE-16 §5.4 / M1-13）：
 *   - 块 id `L0:summary:prev`，L0 总量 ≤900；
 *   - 摘要自身 ≤300；超预算先压到 150，再整块丢（在最近拍之后、pinned 之前）；
 *   - 30 章链不 context_overflow。
 */

const LONG =
  '她把茶盏往他那边推了推，声音压得很低，问起那只黑漆匣子。他没有立刻回答，只低头拨了拨灯芯，' +
  '雨声在瓦上像有人数拍子。她想起父亲临走前说过的话，又想起祠堂供桌下面的灰，心里忽然发冷。'

function summaryText(repeat = 4): string {
  return Array.from({ length: repeat }, () => LONG).join('')
}

function input(patch: Partial<AssembleInput> = {}): AssembleInput {
  const base: AssembleInput = {
    agent: 'character:chr_lin',
    beat: {
      id: 'bt_07',
      ord: 7,
      speakerType: 'character',
      speakerId: 'chr_lin',
      intent: '试探匣子的下落',
      maxWords: 120
    },
    chapter: {
      id: 'ch_2',
      ord: 2,
      title: '旧账最后一页',
      goal: '从穆掌柜手里拿到旧账。',
      coreEvent: '旧账只剩最后一页',
      sceneSequence: ['1. 穆家铺子（拿旧账）'],
      forbiddenReveals: []
    },
    scene: {
      id: 'scn_1',
      ord: 1,
      location: '穆家铺子',
      participants: ['chr_lin', 'chr_shen'],
      goal: '拿到旧账',
      entry: '',
      exit: '',
      previousResult: null
    },
    speaker: { id: 'chr_lin', name: '林砚', card: { role: '账房学徒', want: '查清真相' } },
    spectators: [],
    pinned: [],
    retrieved: [],
    recentBeats: [],
    previousSummary: {
      chapterId: 'ch_1',
      chapterOrd: 1,
      chapterTitle: '祠堂夜谈',
      text: `她把茶盏推了回去。……她没有退，手指扣住桌沿。\n关键事实：黑漆匣子 位置 供桌下面`
    }
  }
  return { ...base, ...patch }
}

describe('L0 摘要块', () => {
  it('上一章摘要进 L0；L0 总量 ≤900；块在章纲之后', () => {
    const result = assembleContext(input())
    const summary = result.bundle.blocks.find((block) => block.id === 'L0:summary:prev')
    expect(summary).toBeDefined()
    expect(summary?.role).toBe('summary')
    expect(summary?.text).toContain('上一章（第 1 章 祠堂夜谈）摘要')
    expect(summary?.text).toContain('黑漆匣子')
    const l0Tokens = result.bundle.blocks
      .filter((block) => block.layer === 'L0')
      .reduce((sum, block) => sum + block.tokens, 0)
    expect(l0Tokens).toBeLessThanOrEqual(900)
    const ids = result.bundle.blocks.filter((block) => block.layer === 'L0').map((block) => block.id)
    expect(ids.indexOf('L0:summary:prev')).toBeGreaterThan(ids.indexOf('L0:chapter'))
  })

  it('超长摘要被压到 ≤300 tokens，不挤爆 L0', () => {
    const result = assembleContext(
      input({
        previousSummary: {
          chapterId: 'ch_1',
          chapterOrd: 1,
          chapterTitle: '祠堂夜谈',
          text: summaryText(6)
        }
      })
    )
    const summary = result.bundle.blocks.find((block) => block.id === 'L0:summary:prev')!
    expect(summary.tokens).toBeLessThanOrEqual(300)
    expect(estimateTokens(summary.text)).toBeLessThanOrEqual(300)
  })

  it('预算不足：摘要先压到 150，仍超则整块丢弃，degraded 有记录', () => {
    const summaryBlock = {
      id: 'L0:summary:prev',
      layer: 'L0' as const,
      stable: true,
      priority: 20,
      tokens: 300,
      text: summaryText(3),
      role: 'summary' as const
    }
    const filler = Array.from({ length: 6 }, (_, index) => ({
      id: `L2:ref:memory:mem_${index}`,
      layer: 'L2' as const,
      stable: false,
      priority: 30,
      tokens: 100,
      text: '记忆正文',
      role: 'ref' as const,
      order: index,
      refType: 'memory' as const
    }))
    const trimmed = fitToBudget([summaryBlock, filler[0]!], 380)
    expect(trimmed.degraded).toContain('summary_trimmed')
    expect(trimmed.degraded).not.toContain('summary_dropped')
    const kept = trimmed.blocks.find((block) => block.id === 'L0:summary:prev')!
    expect(kept.tokens).toBeLessThanOrEqual(150)

    const dropped = fitToBudget([summaryBlock, ...filler], 300)
    expect(dropped.blocks.some((block) => block.id === 'L0:summary:prev')).toBe(false)
    expect(dropped.trimmed).toContain('L0:summary:prev')
  })

  it('30 章链：每章都带上一章摘要，不抛 context_overflow', () => {
    for (let ord = 2; ord <= 31; ord += 1) {
      const result = assembleContext(
        input({
          chapter: { ...input().chapter, id: `ch_${ord}`, ord, title: `第 ${ord} 章` },
          beat: { ...input().beat, id: `bt_${ord}` },
          previousSummary: {
            chapterId: `ch_${ord - 1}`,
            chapterOrd: ord - 1,
            chapterTitle: `第 ${ord - 1} 章`,
            text: summaryText(2)
          }
        })
      )
      expect(result.bundle.totalTokens).toBeGreaterThan(0)
      const l0 = result.bundle.blocks.filter((block) => block.layer === 'L0')
      expect(l0.reduce((sum, block) => sum + block.tokens, 0)).toBeLessThanOrEqual(900)
    }
  })
})
