/**
 * 探针 44 条行为断言的 TypeScript 版本。
 * 与 design/probe/noryth_proto.py --selftest 一一对应；
 * 数值级一致性另见 parity.test.ts（同一函数的跨语言夹具）。
 */
import { describe, expect, it } from 'vitest';
import {
  PARAMS,
  RATIOS,
  RRF_REF,
  applyDamping,
  buildAudience,
  drawEventCard,
  estTokens,
  evalExit,
  factKey,
  needsArbitration,
  packContext,
  relKey,
  relationJump,
  scoreCandidates,
  stakeOf,
  visibleFacts,
  voiceDistance,
  type Candidate,
  type ExitExpr,
  type PackSection,
  type SceneEvalState,
  type Scored,
} from '@noryth/core';

const ctx = { conflictLevel: 0, consecutiveDialogue: 0, beatsSinceNarrator: 9 };

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

describe('探针断言 · 参数不变式', () => {
  it('调度权重和为 1', () => {
    const sum =
      PARAMS['scheduler.w_goal'] +
      PARAMS['scheduler.w_addressed'] +
      PARAMS['scheduler.w_stake'] +
      PARAMS['scheduler.w_narrator'] +
      PARAMS['scheduler.w_initiative'];
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('上下文配额和为 1', () => {
    const sum = Object.values(RATIOS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('rrf_ref 是导出量而非独立参数', () => {
    const expected =
      (PARAMS['memory.w_slot'] + PARAMS['memory.w_fts']) / (PARAMS['memory.rrf_k'] + 1);
    expect(Math.abs(RRF_REF - expected)).toBeLessThan(1e-9);
  });

  it('阻尼系数递减且 <1', () => {
    expect(PARAMS['scheduler.damp_first']).toBeLessThan(PARAMS['scheduler.damp_second']);
    expect(PARAMS['scheduler.damp_second']).toBeLessThan(1);
  });
});

describe('探针断言 · token 估算边界', () => {
  it('空串 token=0', () => {
    expect(estTokens('')).toBe(0);
  });

  it('单字 token>0', () => {
    expect(estTokens('雨')).toBeGreaterThan(0);
  });

  it('token 单调不减', () => {
    expect(estTokens('雨雨雨')).toBeGreaterThanOrEqual(estTokens('雨雨'));
  });
});

describe('探针断言 · 调度', () => {
  it('空候选集返回 []', () => {
    expect(scoreCandidates([], ctx, 1, 1)).toEqual([]);
  });

  it('同 seed 同上下文可复演', () => {
    const same: Candidate[] = [0, 1, 2].map((i) =>
      candidate({ id: `c${i}`, goalRel: 0.5, initiative: 0.5, stake: 0.5, speakCount: i }),
    );
    const r1 = scoreCandidates(same, ctx, 7, 3).map((r) => r.id);
    const r2 = scoreCandidates(same, ctx, 7, 3).map((r) => r.id);
    expect(r1).toEqual(r2);
  });

  it('被点名者不被阻尼', () => {
    const addr: Candidate[] = [
      candidate({ id: 'a', addressed: 1, since: 0, streak: 1, speakCount: 2 }),
      candidate({ id: 'b', goalRel: 1, initiative: 1, stake: 1, since: 9, speakCount: 1 }),
    ];
    const ranked = applyDamping(scoreCandidates(addr, ctx, 1, 1), addr);
    const a = ranked.find((r) => r.id === 'a')!;
    expect(Math.abs(a.score - (a.base + a.jitter))).toBeLessThan(1e-9);
  });

  it('被点名者得分保持基础值不被乘性衰减', () => {
    const addr: Candidate[] = [
      candidate({ id: 'a', addressed: 1, since: 0, streak: 1, speakCount: 2 }),
      candidate({ id: 'b', goalRel: 1, initiative: 1, stake: 1, since: 9, speakCount: 1 }),
    ];
    const ranked = applyDamping(scoreCandidates(addr, ctx, 1, 1), addr);
    const a = ranked.find((r) => r.id === 'a')!;
    expect(Math.abs(a.score - 0.3)).toBeLessThan(0.06);
  });

  it('硬上限把连任者压到 0', () => {
    const capped: Candidate[] = [
      candidate({
        id: 'a',
        goalRel: 1,
        initiative: 1,
        stake: 1,
        since: 0,
        streak: PARAMS['scheduler.max_consecutive'],
        speakCount: 5,
      }),
    ];
    const ranked = applyDamping(
      scoreCandidates(capped, { ...ctx, consecutiveDialogue: 9 }, 1, 1),
      capped,
    );
    expect(ranked[0]!.score).toBe(0);
  });

  it('被钳制者的 0 分不制造假平局', () => {
    expect(needsArbitration([stub(0.5, 'a'), stub(0, 'b'), stub(0, 'c')])).toBe(false);
  });
});

describe('探针断言 · 上下文装配', () => {
  const huge: PackSection[] = [
    {
      name: 'x',
      items: Array.from({ length: 10 }, (_, i) => ({
        full: '字'.repeat(5000),
        summary: '字'.repeat(4000),
        triple: '字'.repeat(3000),
        id: '字'.repeat(2000),
        keepRank: i,
      })),
    },
  ];

  it('装配结果不超预算', () => {
    const { tokens } = packContext(huge, 1000);
    expect(tokens).toBeLessThanOrEqual(1000);
  });

  it('超预算时整条丢弃', () => {
    const { dropped } = packContext(huge, 1000);
    expect(dropped).toBeGreaterThan(0);
  });

  it('极端压缩降到 id+drop 级', () => {
    expect(packContext(huge, 1000).level).toBe('id+drop');
  });
});

describe('探针断言 · 知识边界', () => {
  const facts = [
    { id: 'f1', secrecy: 0, object: '甲' },
    { id: 'f2', secrecy: 0, object: '乙' },
  ];
  const cog = [{ characterId: 'lin', factId: 'f1', learnedSeq: 1, attitude: 'knows' as const, certainty: 1 }];

  it('无认知记录的事实被过滤', () => {
    const visible = visibleFacts(facts, 'lin', cog);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe('f1');
  });

  it('未知角色拿到空集', () => {
    expect(visibleFacts(facts, 'nobody', cog)).toEqual([]);
  });

  it('高敏事实对无权者脱敏', () => {
    const red = [{ id: 'f3', secrecy: 3, object: '真凶', redactFor: new Set(['lin']) }];
    const visible = visibleFacts(red, 'lin', [
      { characterId: 'lin', factId: 'f3', learnedSeq: 1, attitude: 'knows', certainty: 1 },
    ]);
    expect(visible[0]!.object).toBe('（未知）');
  });
});

describe('探针断言 · 感知', () => {
  const present = ['lin', 'shen'];

  it('心理独白不进任何人受众', () => {
    expect(buildAudience(present, 'lin', 'soliloquy')).toEqual([]);
  });

  it('耳语只给指定人', () => {
    expect(buildAudience(present, 'lin', 'whisper', ['shen'])).toEqual(['shen']);
  });

  it('公开发言排除自己', () => {
    expect(buildAudience(present, 'lin', 'public')).toEqual(['shen']);
  });

  it('旁白默认零感知', () => {
    expect(buildAudience(['lin'], 'narrator', 'narrator_reader')).toEqual([]);
  });
});

describe('探针断言 · 收束条件', () => {
  const state: SceneEvalState = {
    facts: new Map([[factKey('信', '送达'), true]]),
    rels: new Map([[relKey('a', 'b', 'trust'), -0.5]]),
    beats: 19,
  };

  it('fact 算子', () => {
    expect(evalExit({ op: 'fact', subject: '信', predicate: '送达', object: true }, state)).toBe(true);
  });

  it('rel 算子', () => {
    expect(
      evalExit({ op: 'rel', from: 'a', to: 'b', axis: 'trust', cmp: '<', value: -0.3 }, state),
    ).toBe(true);
  });

  it('not 算子', () => {
    expect(evalExit({ op: 'not', of: { op: 'beats', cmp: '>=', value: 100 } }, state)).toBe(true);
  });

  it('any 算子', () => {
    expect(
      evalExit(
        {
          op: 'any',
          of: [
            { op: 'beats', cmp: '>=', value: 99 },
            { op: 'beats', cmp: '>=', value: 18 },
          ],
        },
        state,
      ),
    ).toBe(true);
  });

  it('all 算子', () => {
    expect(
      evalExit(
        {
          op: 'all',
          of: [
            { op: 'beats', cmp: '>=', value: 18 },
            { op: 'beats', cmp: '>=', value: 99 },
          ],
        },
        state,
      ),
    ).toBe(false);
  });

  it('未知算子必须报错', () => {
    expect(() => evalExit({ op: 'vibes' } as unknown as ExitExpr, state)).toThrow(/unknown op/);
  });
});

describe('探针断言 · 事件卡与关系', () => {
  const deck = [
    { id: 'heavy', minLevel: 4, consumed: false, oneShot: true },
    { id: 'light', minLevel: 0, consumed: false, oneShot: false },
  ];

  it('min_level 不足的牌被跳过', () => {
    const { card } = drawEventCard(deck, 1, PARAMS['scene.event_card_interval'], false);
    expect(card?.id).toBe('light');
  });

  it('跳过的牌留在牌堆', () => {
    const { deck: rest } = drawEventCard(deck, 1, PARAMS['scene.event_card_interval'], false);
    expect(rest.map((c) => c.id)).toEqual(['heavy']);
  });

  it('小幅关系变化通过', () => {
    expect(relationJump(0, 0.2).verdict).toBe('ok');
  });

  it('突变要求理由', () => {
    expect(relationJump(0, 0.8).verdict).toBe('needs_justification');
  });
});

describe('探针断言 · stake 构成', () => {
  it('stake 下界 = base', () => {
    expect(Math.abs(stakeOf(0, false) - PARAMS['scheduler.stake_base'])).toBeLessThan(1e-9);
  });

  it('stake 与文档例值一致（0.5655）', () => {
    expect(Math.abs(stakeOf(2.1, true) - 0.5655)).toBeLessThan(1e-3);
  });

  it('stake 上界被钳到 1', () => {
    expect(stakeOf(4, true, 1)).toBeLessThanOrEqual(1);
  });

  it('stake 随冲突单调增', () => {
    expect(stakeOf(3, true)).toBeGreaterThan(stakeOf(1, true));
  });

  it('秘密受威胁抬高 stake', () => {
    expect(stakeOf(2, true)).toBeGreaterThan(stakeOf(2, false));
  });

  it('目标所有权独立可加', () => {
    const expected =
      PARAMS['scheduler.stake_base'] +
      PARAMS['scheduler.stake_conflict'] * 0.5 +
      PARAMS['scheduler.stake_ownership'];
    expect(Math.abs(stakeOf(2, false, 1) - expected)).toBeLessThan(1e-9);
  });
});

describe('探针断言 · 声音区分度', () => {
  const a = ['我没说过这话。', '账本不在我这儿。', '你走吧。'];
  const b = ['我没说过这话。', '账本不在我这儿。', '你走吧。'];
  const c = ['呵，这雨下得可真是时候呢……', '你说呢？', '我倒是想听听，你打算怎么解释呀？'];

  it('同样本声音距离 = 0', () => {
    expect(voiceDistance(a, b)).toBeLessThan(1e-9);
  });

  it('不同笔调的距离超过阈值', () => {
    expect(voiceDistance(a, c)).toBeGreaterThan(PARAMS['consistency.voice_jsd_threshold']);
  });

  it('空样本返回 0 而不抛错', () => {
    expect(voiceDistance([], a)).toBe(0);
  });

  it('声音距离有界', () => {
    const d = voiceDistance(a, c);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });
});

describe('探针断言 · 规模阈值', () => {
  it('ANN 阈值高于小说项目现实规模', () => {
    expect(PARAMS['memory.ann_threshold']).toBeGreaterThan(50_000);
  });
});
