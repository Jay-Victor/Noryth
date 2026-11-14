import { describe, expect, it } from 'vitest'
import type { AssembleInput, RetrievedItem } from '../../../src/main/context/assemble'
import { assembleContext, characterCardCore } from '../../../src/main/context/assemble'

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
      id: 'ch_1',
      ord: 1,
      title: '祠堂夜谈',
      goal: '确认黑漆匣子的下落。',
      coreEvent: '黑漆匣子在祠堂供桌下面',
      sceneSequence: ['1. 沈家祠堂（确认匣子的下落）', '2. 廊下（雨停）'],
      forbiddenReveals: ['真凶是管家']
    },
    scene: {
      id: 'scn_1',
      ord: 1,
      location: '沈家祠堂',
      participants: ['chr_lin', 'chr_shen'],
      goal: '确认黑漆匣子的下落',
      entry: '雨夜，祠堂只剩一盏灯',
      exit: '匣子底部刻着林家的记号',
      previousResult: null
    },
    speaker: {
      id: 'chr_lin',
      name: '林砚',
      card: {
        role: '账房学徒',
        want: '查清真相',
        fear: '成为共犯',
        taboo: '不提父亲的名字',
        voice: { sentence: '短句', tic: '喜欢反问' }
      }
    },
    spectators: [
      {
        id: 'chr_shen',
        name: '沈青梧',
        card: {},
        location: '沈家祠堂',
        emotion: '警惕',
        known: ['匣子在供桌下'],
        unknown: ['匣子的归属'],
        tension: 0.4
      }
    ],
    pinned: [],
    retrieved: [],
    recentBeats: []
  }
  return { ...base, ...patch }
}

function item(index: number, patch: Partial<RetrievedItem> = {}): RetrievedItem {
  return {
    refType: 'memory',
    id: `mem_${index}`,
    text: `记忆 ${index}：父亲书房有一只上锁的黑漆匣子`,
    score: 0.9 - index * 0.05,
    importance: 0.8,
    pinned: false,
    ...patch
  }
}

describe('上下文装配 L0–L3（DEV-PLAN §7.3）', () => {
  it('同一输入两次 bundle 完全一致（blocks 顺序 + totalTokens）', () => {
    const fixture = input({
      pinned: [item(90, { pinned: true, importance: 0.95 })],
      retrieved: [item(1), item(2), item(3)],
      recentBeats: [
        {
          id: 'bt_06',
          seq: 6,
          ord: 6,
          speakerType: 'narrator',
          speakerId: 'narrator',
          body: '窗外的雨还没有停。',
          status: 'confirmed'
        },
        {
          id: 'bt_05',
          seq: 5,
          ord: 5,
          speakerType: 'character',
          speakerId: 'chr_shen',
          body: '「你来做什么？」',
          status: 'confirmed'
        }
      ]
    })
    const first = assembleContext(fixture)
    const second = assembleContext(fixture)
    expect(second.bundle.blocks).toEqual(first.bundle.blocks)
    expect(second.bundle.totalTokens).toBe(first.bundle.totalTokens)
    expect(second.refs).toEqual(first.refs)
  })

  it('块顺序固定 (layer, priority, id)，角色卡与意图在 L2 内按显示顺序', () => {
    const result = assembleContext(
      input({ pinned: [item(90, { pinned: true })], retrieved: [item(1), item(2)], recentBeats: [
        {
          id: 'bt_06',
          seq: 6,
          ord: 6,
          speakerType: 'narrator',
          speakerId: 'narrator',
          body: '雨停了。',
          status: 'confirmed'
        }
      ] })
    )
    const ids = result.bundle.blocks.map((block) => block.id)
    expect(ids).toEqual([
      'L0:chapter',
      'L1:scene',
      'L2:card',
      'L2:pinned:memory:mem_90',
      'L2:ref:memory:mem_1',
      'L2:ref:memory:mem_2',
      'L2:recent:bt_06',
      'L2:intent',
      'L3:spectator:chr_shen'
    ])
  })

  it('角色/旁白拿脱敏一句话目标，禁揭清单只给编排与审批', () => {
    const character = assembleContext(input())
    const l0 = character.bundle.blocks.find((block) => block.id === 'L0:chapter')!
    expect(l0.text).not.toContain('真凶是管家')
    expect(l0.text).toContain('本章目标：确认黑漆匣子的下落')
    expect(l0.text).not.toContain('核心事件')

    const narrator = assembleContext(input({ agent: 'narrator', speaker: null, spectators: [] }))
    const narratorL0 = narrator.bundle.blocks.find((block) => block.id === 'L0:chapter')!
    expect(narratorL0.text).toContain('场景序列：1. 沈家祠堂')
    expect(narratorL0.text).not.toContain('真凶是管家')

    const orchestrator = assembleContext(input({ agent: 'orchestrator', speaker: null }))
    const fullL0 = orchestrator.bundle.blocks.find((block) => block.id === 'L0:chapter')!
    expect(fullL0.text).toContain('禁揭：真凶是管家')
    expect(fullL0.text).toContain('核心事件')
  })

  it('pinned 独立成段且最多 5 条，refs 按 top_k 截断', () => {
    const pinned = Array.from({ length: 8 }, (_, index) =>
      item(100 + index, { pinned: true, importance: index / 10, score: 0 })
    )
    const retrieved = Array.from({ length: 8 }, (_, index) => item(index))
    const result = assembleContext(input({ pinned, retrieved }))
    expect(result.bundle.blocks.filter((block) => block.role === 'pinned')).toHaveLength(5)
    expect(result.bundle.blocks.filter((block) => block.role === 'ref')).toHaveLength(5)
    expect(result.usedPinned).toBe(5)
    expect(result.usedRefs).toBe(5)
  })

  it('最近拍按输入顺序（新→旧）进入上下文，L3 只放非发言者', () => {
    const recentBeats = Array.from({ length: 8 }, (_, index) => ({
      id: `bt_${10 - index}`,
      seq: 10 - index,
      ord: 10 - index,
      speakerType: (index % 2 === 0 ? 'narrator' : 'character') as 'narrator' | 'character',
      speakerId: index % 2 === 0 ? 'narrator' : 'chr_shen',
      body: `第 ${10 - index} 拍。`,
      status: 'confirmed' as const
    }))
    const result = assembleContext(input({ recentBeats }))
    const recent = result.bundle.blocks.filter((block) => block.role === 'recent')
    expect(recent).toHaveLength(6)
    expect(recent[0]!.id).toBe('L2:recent:bt_10')
    const spectators = result.bundle.blocks.filter((block) => block.role === 'spectator')
    expect(spectators.map((block) => block.id)).toEqual(['L3:spectator:chr_shen'])
  })

  it('空检索时标记 memory_empty，但不阻断装配', () => {
    const result = assembleContext(input({ pinned: [], retrieved: [] }))
    expect(result.bundle.degraded).toContain('memory_empty')
    expect(result.refs).toEqual([])
    expect(result.bundle.blocks.some((block) => block.id === 'L2:intent')).toBe(true)
  })

  it('角色卡核心固定字段顺序并包含 voice 子字段', () => {
    const core = characterCardCore({
      id: 'chr_lin',
      name: '林砚',
      card: {
        role: '账房学徒',
        want: '查清真相',
        fear: '成为共犯',
        taboo: '不提父亲的名字',
        voice: { sentence: '短句', tic: '喜欢反问' }
      }
    })
    expect(core).toBe(
      [
        '角色：林砚',
        '身份/定位：账房学徒',
        '声音：sentence=短句；tic=喜欢反问',
        '欲望：查清真相',
        '恐惧：成为共犯',
        '禁忌：不提父亲的名字'
      ].join('\n')
    )
  })
})
