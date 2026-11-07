/**
 * 边界用例：覆盖探针 44 条之外的失败路径与钳位。
 * 目标是把 core 的分支覆盖率顶到 80% 以上（05-roadmap.md §3.1）。
 */
import { describe, expect, it } from 'vitest';
import {
  PARAMS,
  addCognition,
  applyDamping,
  blake2b,
  buildAudience,
  canonicalJson,
  drawEventCard,
  evalExit,
  factKey,
  h01,
  needsArbitration,
  packContext,
  pick,
  relKey,
  relationJump,
  roundHalfEven,
  scoreCandidates,
  stakeOf,
  visibleFacts,
  voiceDistance,
  type Candidate,
  type CognitionRecord,
  type ExitExpr,
  type SceneEvalState,
  type Scored,
} from '@noryth/core';

function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'id'>): Candidate {
  return {
    goalRel: 0,
    initiative: 0,
    stake: 0,
    addressed: 0,
    isNarrator: false,
    since: 9,
    streak: 0,
    speakCount: 0,
    ...overrides,
  };
}

function stub(score: number, id: string): Scored {
  return {
    id,
    base: score,
    score,
    jitter: 0,
    parts: { goal: 0, addr: 0, stake: 0, narr: 0, init: 0 },
    addressed: 0,
    speakCount: 0,
    capped: false,
  };
}

describe('哈希与规范化 JSON', () => {
  it('canonicalJson 递归排序键并保留数组顺序', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('canonicalJson 丢弃 undefined，拒绝非有限数与函数', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/非有限数/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/非有限数/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/不支持的类型/);
  });

  it('blake2b 拒绝非法 digestLength', () => {
    expect(() => blake2b(Buffer.from('x'), 0)).toThrow(RangeError);
    expect(() => blake2b(Buffer.from('x'), 65)).toThrow(RangeError);
    expect(() => blake2b(Buffer.from('x'), 2.5)).toThrow(RangeError);
  });

  it('h01 拒绝非整数 number 参数（Python str(1.0) 与 JS String(1) 不同）', () => {
    expect(() => h01(1.5, 'x')).toThrow(TypeError);
    expect(h01(1, 'x')).toBe(h01('1', 'x'));
  });

  it('h01 对同一组输入是确定的', () => {
    expect(h01(3, 4, 'char:a')).toBe(h01(3, 4, 'char:a'));
    expect(h01(3, 4, 'char:a')).not.toBe(h01(3, 4, 'char:b'));
  });
});

describe('token 估算', () => {
  it('roundHalfEven 与 Python round 一致', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });
});

describe('上下文装配的丢弃路径', () => {
  it('放不下的条目跳过，后面的小条目仍可入选', () => {
    const sections = [
      {
        name: 'x',
        items: [
          {
            full: '字'.repeat(50),
            summary: '字'.repeat(50),
            triple: '字'.repeat(50),
            id: '字'.repeat(20),
            keepRank: 1,
          },
          {
            full: '字'.repeat(50),
            summary: '字'.repeat(50),
            triple: '字'.repeat(50),
            id: '短',
            keepRank: 2,
          },
        ],
      },
    ];
    const result = packContext(sections, 10);
    expect(result.level).toBe('id+drop');
    expect(result.kept.map((k) => k.item.id)).toEqual(['短']);
    expect(result.dropped).toBe(1);
  });

  it('keepRank 缺省为 9，相同 rank 按原顺序稳定', () => {
    const sections = [
      {
        name: 'x',
        items: [
          { full: '字'.repeat(80), summary: '字'.repeat(80), triple: '字'.repeat(80), id: '字'.repeat(20) },
          { full: '字'.repeat(80), summary: '字'.repeat(80), triple: '字'.repeat(80), id: '字'.repeat(20) },
        ],
      },
    ];
    const result = packContext(sections, 10);
    expect(result.dropped).toBe(2);
    expect(result.kept).toEqual([]);
  });
});

describe('调度边界', () => {
  const narrator = candidate({ id: 'narrator', isNarrator: true, since: 99 });

  it('旁白节奏需求三档', () => {
    const hot = scoreCandidates(
      [candidate({ id: 'a' }), narrator],
      { conflictLevel: 1, consecutiveDialogue: 2, beatsSinceNarrator: 2 },
      1,
      1,
    );
    expect(hot.find((r) => r.id === 'narrator')!.parts.narr).toBeCloseTo(
      PARAMS['scheduler.w_narrator'] * 1.0,
      12,
    );

    const warm = scoreCandidates(
      [candidate({ id: 'a' }), narrator],
      { conflictLevel: 1, consecutiveDialogue: 0, beatsSinceNarrator: 4 },
      1,
      1,
    );
    expect(warm.find((r) => r.id === 'narrator')!.parts.narr).toBeCloseTo(
      PARAMS['scheduler.w_narrator'] * 0.3,
      12,
    );

    const cold = scoreCandidates(
      [candidate({ id: 'a' }), narrator],
      { conflictLevel: 1, consecutiveDialogue: 0, beatsSinceNarrator: 0 },
      1,
      1,
    );
    expect(cold.find((r) => r.id === 'narrator')!.parts.narr).toBe(0);
  });

  it('隔一拍发言乘 0.55，旁白不参与阻尼', () => {
    const cands = [
      candidate({ id: 'a', goalRel: 1, since: 1 }),
      candidate({ id: 'narrator', isNarrator: true, since: 99 }),
    ];
    const ranked = applyDamping(scoreCandidates(cands, { conflictLevel: 0, consecutiveDialogue: 0, beatsSinceNarrator: 0 }, 1, 1), cands);
    const a = ranked.find((r) => r.id === 'a')!;
    expect(a.score).toBeCloseTo(
      (a.base + a.jitter) * PARAMS['scheduler.damp_second'],
      12,
    );
    const narratorRow = ranked.find((r) => r.id === 'narrator')!;
    expect(narratorRow.score).toBeCloseTo(narratorRow.base + narratorRow.jitter, 12);
  });

  it('全员被钳到 0 时 pick 退回第一名；空输入返回 null', () => {
    expect(pick([stub(0, 'a'), stub(0, 'b')])?.id).toBe('a');
    expect(pick([])).toBeNull();
  });

  it('两个活候选的差距小于 δ 时触发仲裁', () => {
    expect(needsArbitration([stub(0.5, 'a'), stub(0.49, 'b')])).toBe(true);
    expect(needsArbitration([stub(0.5, 'a')])).toBe(false);
    expect(needsArbitration([stub(0.5, 'a'), stub(0.4, 'b')], 0.05)).toBe(false);
  });
});

describe('知识边界边界', () => {
  it('addCognition 去重且只补新受众', () => {
    const cognition: CognitionRecord[] = [];
    addCognition(cognition, ['a', 'b'], 'f1', 1);
    addCognition(cognition, ['a', 'c'], 'f1', 2);
    expect(cognition.map((c) => `${c.characterId}@${c.learnedSeq}`)).toEqual(['a@1', 'b@1', 'c@2']);
  });

  it('耳语把自己从受众里剔除', () => {
    expect(buildAudience(['lin', 'shen'], 'lin', 'whisper', ['lin', 'shen'])).toEqual(['shen']);
  });

  it('高敏但不在 redactFor 里的事实不脱敏', () => {
    const facts = [{ id: 'f1', secrecy: 3, object: '真凶', redactFor: new Set(['other']) }];
    const visible = visibleFacts(facts, 'lin', [
      { characterId: 'lin', factId: 'f1', learnedSeq: 1, attitude: 'knows', certainty: 1 },
    ]);
    expect(visible[0]!.object).toBe('真凶');
    expect(visible[0]!.redacted).toBeUndefined();
  });
});

describe('收束求值边界', () => {
  const state: SceneEvalState = {
    facts: new Map([
      [factKey('账本', '持有'), { id: 'shen' }],
      [factKey('信', '送达'), null],
    ]),
    rels: new Map([[relKey('a', 'b', 'trust'), 0]]),
    beats: 3,
  };

  it('对象/数组/空值按结构相等比较', () => {
    expect(evalExit({ op: 'fact', subject: '账本', predicate: '持有', object: { id: 'shen' } }, state)).toBe(true);
    expect(evalExit({ op: 'fact', subject: '账本', predicate: '持有', object: { id: 'lin' } }, state)).toBe(false);
    expect(evalExit({ op: 'fact', subject: '信', predicate: '送达', object: null }, state)).toBe(true);
  });

  it('关系轴缺失按 0 处理', () => {
    expect(evalExit({ op: 'rel', from: 'a', to: 'b', axis: 'fear', cmp: '==', value: 0 }, state)).toBe(true);
  });

  it('未知比较符抛错', () => {
    expect(() =>
      evalExit(
        { op: 'beats', cmp: '~' as unknown as '<', value: 1 },
        state,
      ),
    ).toThrow(/unknown cmp/);
  });
});

describe('事件卡与关系边界', () => {
  const deck = [
    { id: 'a', minLevel: 0, consumed: false, oneShot: true, used: true },
    { id: 'b', minLevel: 0, consumed: false, oneShot: false, used: true },
    { id: 'c', minLevel: 9, consumed: false, oneShot: false },
  ];

  it('非抽牌回合返回 null；flat 打破间隔限制', () => {
    expect(drawEventCard(deck, 1, 5, false, 6).card).toBeNull();
    expect(drawEventCard(deck, 1, 5, true, 6).card?.id).toBe('b');
  });

  it('没有可抽的牌时返回 null 且牌堆不变', () => {
    const none = [
      { id: 'x', minLevel: 0, consumed: true, oneShot: false },
      { id: 'y', minLevel: 9, consumed: false, oneShot: false },
    ];
    const result = drawEventCard(none, 1, 6, false);
    expect(result.card).toBeNull();
    expect(result.deck.map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('关系阈值是闭区间，恰好等于阈值算 ok', () => {
    expect(relationJump(0, PARAMS['consistency.relation_jump_threshold']).verdict).toBe('ok');
    expect(
      relationJump(0, PARAMS['consistency.relation_jump_threshold'] + 0.001).verdict,
    ).toBe('needs_justification');
  });

  it('stakeOf 对 ownership 做 0–1 钳位', () => {
    expect(stakeOf(0, false, 5)).toBe(stakeOf(0, false, 1));
    expect(stakeOf(0, false, -5)).toBe(stakeOf(0, false, 0));
  });
});

describe('声音距离的构成项', () => {
  it('第一人称、问句、语气词各自贡献距离', () => {
    const base = ['我去。'];
    expect(voiceDistance(base, ['他去。'])).toBeGreaterThan(0);
    expect(voiceDistance(['你去吗？'], ['你去。'])).toBeGreaterThan(0);
    expect(voiceDistance(['好的我知道这件事'], ['我们走'])).toBeGreaterThan(0);
    expect(voiceDistance([''], [''])).toBe(0);
  });

  it('单侧空样本返回 0', () => {
    expect(voiceDistance([], [])).toBe(0);
    expect(voiceDistance(['a'], [])).toBe(0);
  });
});
