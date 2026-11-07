import { describe, expect, it } from 'vitest';
import {
  FACT_CAP,
  assembleCharacterContext,
  assembleNarratorContext,
  countLeakedFacts,
  type BeatView,
  type CognitionView,
  type ClueView,
  type FactView,
} from '@noryth/core';

const CHAR_NAMES = ['林砚', '沈昼', '祁昭', '陆微', '温故', '周决'];
const CHAR_IDS = ['e_lin', 'e_shen', 'e_qi', 'e_lu', 'e_wen', 'e_zhou'];

function agent(name: string) {
  return {
    name,
    identity: `${name}的身份`,
    personality: '克制，不爱多话。',
    speechStyle: '短句。',
    values: '活下去。',
    want: '拿回账本。',
  };
}

function scene() {
  return {
    title: '雨夜·账本',
    location: '客栈',
    storyStart: '第01天',
    timeline: 'main',
    presentNames: CHAR_NAMES,
    goal: '夺回账本',
    conflictLevel: 2.1,
    situation: '灯快尽了。',
  };
}

const BEATS: BeatView[] = Array.from({ length: 12 }, (_, i) => ({
  seq: i + 1,
  speaker: CHAR_NAMES[i % 3]!,
  roleType: 'character',
  prose: `第${i + 1}拍的第一句。第${i + 1}拍的第二句。第三句不该被截断。`,
}));

const CLUES: ClueView[] = [{ id: 'c1', text: '账本第七页被撕掉了。', stale: false }];

/** 204 条事实，6 个角色各知道 34 条（与 01 §6 A2 的实测口径一致）。 */
function world(): { facts: FactView[]; cognition: CognitionView[] } {
  const facts: FactView[] = [];
  const cognition: CognitionView[] = [];
  for (let i = 0; i < 204; i += 1) {
    const owner = CHAR_IDS[i % CHAR_IDS.length]!;
    const ownerName = CHAR_NAMES[i % CHAR_NAMES.length]!;
    facts.push({
      id: `f${i}`,
      subjectId: owner,
      subjectName: ownerName,
      predicate: '知道',
      objectText: `秘密-${i}-${'x'.repeat(6)}`,
      truth: 1,
      secrecy: i % 5 === 0 ? 3 : 1,
      source: `事件 ${i + 1}`,
      marker: `MARKER-${i}-7f3a`,
    });
    cognition.push({
      characterId: owner,
      factId: `f${i}`,
      attitude: 'knows',
      certainty: 1,
      percept: 'witness',
    });
  }
  return { facts, cognition };
}

describe('P1 门禁 5 · 装配上下文 ≤ 预算', () => {
  it('默认预算下不超预算', () => {
    const { facts, cognition } = world();
    const result = assembleCharacterContext({
      characterId: 'e_lin',
      agent: agent('林砚'),
      scene: scene(),
      recent: BEATS,
      facts,
      cognition,
      relations: [{ toName: '沈昼', axis: 'trust', value: -0.4 }],
      clues: CLUES,
    });
    expect(result.tokens).toBeLessThanOrEqual(result.budget);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('小预算下仍不超，且降级而不是截半句', () => {
    const { facts, cognition } = world();
    const result = assembleCharacterContext({
      characterId: 'e_lin',
      agent: agent('林砚'),
      scene: scene(),
      recent: BEATS,
      facts,
      cognition,
      relations: [],
      clues: CLUES,
      budget: 700,
    });
    expect(result.tokens).toBeLessThanOrEqual(700);
    expect(result.level).not.toBe('full');
    for (const entry of result.packed.kept) {
      const text = entry.item.full;
      // 每条进入上下文的文本必须是完整句或结构化短句，不能以半个词结束。
      expect(text.length).toBeGreaterThan(0);
      if (entry.section === 'recent') {
        expect(text.endsWith('。') || text === entry.item.full).toBe(true);
      }
    }
  });

  it('已知事实封顶 34 条', () => {
    const { facts, cognition } = world();
    const result = assembleCharacterContext({
      characterId: 'e_lin',
      agent: agent('林砚'),
      scene: scene(),
      recent: BEATS,
      facts,
      cognition,
      relations: [],
      clues: [],
    });
    expect(result.factIds.length).toBeLessThanOrEqual(FACT_CAP);
    expect(result.factIds.length).toBe(34);
  });

  it('没有记忆时注入显式标记，而不是静默省略', () => {
    const result = assembleCharacterContext({
      characterId: 'e_lin',
      agent: agent('林砚'),
      scene: scene(),
      recent: [],
      facts: [],
      cognition: [],
      relations: [],
      clues: [],
    });
    expect(result.prompt.user).toContain('（无相关记忆）');
  });
});

describe('P1 门禁 6 · 越权事实进入提示词 = 0（72 次装配）', () => {
  it('12 场景 × 6 角色，累计越权 0 条', () => {
    const { facts, cognition } = world();
    let totalFacts = 0;
    const leaked: string[] = [];
    for (let sceneIndex = 0; sceneIndex < 12; sceneIndex += 1) {
      const recent = BEATS.map((beat) => ({
        ...beat,
        seq: beat.seq + sceneIndex * 12,
        prose: `第${sceneIndex}场第${beat.seq}拍。雨还在下。`,
      }));
      for (let i = 0; i < CHAR_IDS.length; i += 1) {
        const characterId = CHAR_IDS[i]!;
        const result = assembleCharacterContext({
          characterId,
          agent: agent(CHAR_NAMES[i]!),
          scene: scene(),
          recent,
          facts,
          cognition,
          relations: [],
          clues: [],
        });
        totalFacts += result.factIds.length;
        const audit = countLeakedFacts(result.prompt, facts, cognition, characterId);
        expect(audit.count).toBe(0);
        leaked.push(...audit.ids);
        const known = new Set(
          cognition.filter((c) => c.characterId === characterId).map((c) => c.factId),
        );
        for (const id of result.factIds) expect(known.has(id)).toBe(true);
      }
    }
    expect(leaked).toEqual([]);
    expect(totalFacts).toBe(72 * FACT_CAP);
  });

  it('全量注入会越权（对照组，证明过滤真的在做事）', () => {
    const { facts, cognition } = world();
    const known = new Set(
      cognition.filter((c) => c.characterId === 'e_lin').map((c) => c.factId),
    );
    const unauthorized = facts.filter((f) => !known.has(f.id));
    expect(unauthorized.length).toBe(170);
    const injected = `全部事实：${facts.map((f) => f.marker).join(' ')}`;
    const audit = countLeakedFacts(
      { system: '', user: injected },
      facts,
      cognition,
      'e_lin',
    );
    expect(audit.count).toBe(170);
  });
});

describe('P1 · 旁白事实白名单', () => {
  const facts: FactView[] = [
    {
      id: 'public',
      subjectId: 'e_lin',
      subjectName: '林砚',
      predicate: '身份',
      objectText: '客栈掌柜',
      truth: 1,
      secrecy: 0,
      source: '设定',
      marker: '公开身份',
      observable: true,
    },
    {
      id: 'known-secret',
      subjectId: 'e_shen',
      subjectName: '沈昼',
      predicate: '隐瞒',
      objectText: '他烧了卷宗',
      truth: 1,
      secrecy: 2,
      source: '事件 9',
      marker: '烧卷宗',
    },
    {
      id: 'unknown-secret',
      subjectId: 'e_qi',
      subjectName: '祁昭',
      predicate: '隐瞒',
      objectText: '他收了钱',
      truth: 1,
      secrecy: 3,
      source: '事件 11',
      marker: '收钱',
    },
    {
      id: 'observable',
      subjectId: 'e_lin',
      subjectName: '林砚',
      predicate: '状态',
      objectText: '手在抖',
      truth: 1,
      secrecy: 2,
      source: '事件 3',
      marker: '手在抖',
      observable: true,
    },
  ];

  it('公开 + 在场者知道的秘密进入白名单；无人知道的秘密不进', () => {
    const result = assembleNarratorContext({
      agent: agent('旁白'),
      scene: {
        ...scene(),
        presentNames: ['林砚', '沈昼'],
      },
      recent: BEATS.slice(0, 2),
      facts,
      cognition: [
        { characterId: 'e_shen', factId: 'known-secret', attitude: 'knows', certainty: 1 },
      ],
      present: ['e_lin', 'e_shen'],
      clues: [],
    });
    expect(result.factIds).toContain('public');
    expect(result.factIds).toContain('known-secret');
    expect(result.factIds).toContain('observable');
    expect(result.factIds).not.toContain('unknown-secret');
    expect(result.prompt.system).not.toContain('收钱');
  });
});
