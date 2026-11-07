import { describe, expect, it } from 'vitest';
import { PARAMS, packContext, type PackSection } from '@noryth/core';

/**
 * A2 分段配额：只在 id 级仍超预算时生效（超预算时的公平上限）。
 * 常态（某一级总量 ≤ budget）不裁剪，保留文档实测数字。
 */
const BUDGET = 100;

function item(prefix: string, idLen: number, rank: number) {
  return {
    full: '字'.repeat(200), // 136 tok，远大于 budget
    summary: '字'.repeat(200),
    triple: '字'.repeat(200),
    id: prefix.repeat(idLen), // recent: 26 tok；memory: 13 tok
    keepRank: rank,
  };
}

function sections(): PackSection[] {
  return [
    {
      name: 'recent',
      items: [0, 1, 2].map((i) => item('r', 100, 1)),
    },
    {
      name: 'memory',
      items: [0, 1, 2].map((i) => item('m', 50, 2)),
    },
  ];
}

describe('A2 分段配额', () => {
  it('id 级超预算时，每段各自保留到 budget × ratio', () => {
    const result = packContext(sections(), BUDGET);
    expect(result.level).toBe('id+drop');

    const recent = result.kept.filter((k) => k.section === 'recent');
    const memory = result.kept.filter((k) => k.section === 'memory');

    // recent 配额 30，单项 26 → 只能留 1；否则 recent 会吃掉 3×26=78
    expect(recent).toHaveLength(1);
    // memory 配额 20，单项 13 → 只能留 1（2 项 = 26 > 20）
    expect(memory).toHaveLength(1);
    expect(result.dropped).toBe(4);
  });

  it('每段实际占用不超过自己的配额', () => {
    const result = packContext(sections(), BUDGET);
    const quota = {
      recent: Math.floor(BUDGET * PARAMS['context.ratio_recent']),
      memory: Math.floor(BUDGET * PARAMS['context.ratio_memory']),
    };
    const used = { recent: 0, memory: 0 };
    for (const entry of result.kept) {
      const len = entry.item.id.length;
      used[entry.section as 'recent' | 'memory'] += Math.round(len * 0.26);
    }
    expect(used.recent).toBeLessThanOrEqual(quota.recent);
    expect(used.memory).toBeLessThanOrEqual(quota.memory);
  });

  it('配额不足时宁可整段丢弃，也不截断条目', () => {
    const result = packContext(sections(), BUDGET);
    for (const entry of result.kept) {
      // 留下的都是完整 id，不是子串
      expect(entry.item.id === 'r'.repeat(100) || entry.item.id === 'm'.repeat(50)).toBe(true);
    }
    expect(result.tokens).toBe(26 + 13);
  });

  it('未超预算时不触发配额（保留文档的 4352 tok / full 路径）', () => {
    const fits: PackSection[] = [
      {
        name: 'memory',
        items: [
          { full: '短', summary: '短', triple: '短', id: 'm1', keepRank: 1 },
          { full: '短', summary: '短', triple: '短', id: 'm2', keepRank: 1 },
        ],
      },
    ];
    const result = packContext(fits, 6000);
    expect(result.level).toBe('full');
    expect(result.dropped).toBe(0);
    expect(result.kept).toHaveLength(2);
  });

  it('未知段不参与配额，但仍受全局预算约束', () => {
    const unknown: PackSection[] = [
      {
        name: 'custom',
        items: [
          { full: '字'.repeat(200), summary: '字'.repeat(200), triple: '字'.repeat(200), id: 'x'.repeat(100) },
          { full: '字'.repeat(200), summary: '字'.repeat(200), triple: '字'.repeat(200), id: 'x'.repeat(100) },
        ],
      },
    ];
    const result = packContext(unknown, 40);
    expect(result.level).toBe('id+drop');
    expect(result.tokens).toBeLessThanOrEqual(40);
    expect(result.kept).toHaveLength(1);
  });
});
