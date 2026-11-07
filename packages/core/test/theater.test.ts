import { describe, expect, it } from 'vitest';
import {
  PARAMS,
  arbitrate,
  conflictIsFlat,
  planBeat,
  planDirector,
  reachedMaxBeats,
  replayDigest,
  type ActorRuntime,
  type TheaterRuntime,
} from '@noryth/core';

function actor(overrides: Partial<ActorRuntime> & Pick<ActorRuntime, 'id' | 'name'>): ActorRuntime {
  return {
    isNarrator: false,
    goalRel: 0.5,
    initiative: 0.5,
    secretThreat: false,
    ownership: 0,
    speakCount: 0,
    since: 9,
    streak: 0,
    ...overrides,
  };
}

function runtime(overrides: Partial<TheaterRuntime> = {}): TheaterRuntime {
  return {
    scene: {
      id: 's1',
      state: 'open',
      present: ['e_lin', 'e_shen'],
      conflictLevel: 1,
      maxBeats: 40,
      beats: 3,
      ...overrides.scene,
    },
    actors: [
      actor({ id: 'e_lin', name: '林砚', goalRel: 1, initiative: 0.9, since: 3 }),
      actor({ id: 'e_shen', name: '沈昼', goalRel: 0.5, initiative: 0.5, since: 2 }),
      actor({ id: 'narrator', name: '旁白', isNarrator: true, goalRel: 0, since: 3 }),
    ],
    beatsSinceNarrator: 2,
    consecutiveDialogue: 2,
    addressedTo: [],
    conflictHistory: [1, 1, 1],
    deck: [],
    ...overrides,
  };
}

describe('P1 · 发言计划', () => {
  it('场景第一拍强制旁白，跳过评分', () => {
    const plan = planBeat(runtime({ scene: { ...runtime().scene, beats: 0 } }), 1);
    expect(plan.mode).toBe('forced_narrator');
    expect(plan.speakerName).toBe('旁白');
    expect(plan.ranked).toEqual([]);
  });

  it('距上拍旁白达到 max_gap 时强制旁白', () => {
    const plan = planBeat(
      runtime({ beatsSinceNarrator: PARAMS['scene.narrator_max_gap'] }),
      1,
    );
    expect(plan.mode).toBe('forced_narrator');
  });

  it('收束状态强制旁白', () => {
    const plan = planBeat(runtime({ scene: { ...runtime().scene, state: 'closing' } }), 1);
    expect(plan.mode).toBe('forced_narrator');
  });

  it('同 seed 同上下文产生同一排序', () => {
    const a = planBeat(runtime(), 7);
    const b = planBeat(runtime(), 7);
    expect(a.ranked.map((r) => r.id)).toEqual(b.ranked.map((r) => r.id));
    expect(a.speakerName).toBe(b.speakerName);
  });

  it('不同 seed 会让抖动改变排序（至少某些 seed 不同）', () => {
    const rt = runtime({
      actors: [
        actor({ id: 'e_lin', name: '林砚', goalRel: 0.5, initiative: 0.5, since: 9 }),
        actor({ id: 'e_shen', name: '沈昼', goalRel: 0.5, initiative: 0.5, since: 9 }),
        actor({ id: 'narrator', name: '旁白', isNarrator: true }),
      ],
      beatsSinceNarrator: 0,
    });
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) seen.add(planBeat(rt, seed).speakerName);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('用户硬指定豁免阻尼与硬上限', () => {
    const rt = runtime({
      actors: [
        actor({
          id: 'e_lin',
          name: '林砚',
          goalRel: 1,
          since: 0,
          streak: PARAMS['scheduler.max_consecutive'],
        }),
        actor({ id: 'e_shen', name: '沈昼', goalRel: 1, since: 1 }),
        actor({ id: 'narrator', name: '旁白', isNarrator: true }),
      ],
    });
    const plan = planBeat(rt, 3, { userPick: 'e_lin' });
    expect(plan.mode).toBe('user_pick');
    expect(plan.speakerName).toBe('林砚');
    expect(plan.damped).toBe(plan.preDamp);
    expect(plan.preDamp).toBeGreaterThan(0);
  });

  it('指定不在场者报错', () => {
    expect(() => planBeat(runtime(), 1, { userPick: '祁昭' })).toThrow(/不在场/);
  });

  it('平局只统计 score>0 的候选并确定性仲裁', () => {
    const rt = runtime({
      actors: [
        actor({ id: 'e_lin', name: '林砚', goalRel: 0.5, initiative: 0.5, since: 9 }),
        actor({ id: 'e_shen', name: '沈昼', goalRel: 0.5, initiative: 0.5, since: 9 }),
        actor({ id: 'narrator', name: '旁白', isNarrator: true }),
      ],
      beatsSinceNarrator: 0,
    });
    const first = planBeat(rt, 11);
    expect(first.arbitration.needed).toBe(true);
    expect(first.mode).toBe('arbitrated');
    // 旁白即使 need=0 也有抖动分，只要 score>0 就是活候选（不能把它算成假平局的反面）。
    expect(first.arbitration.top).toContain('林砚');
    expect(first.arbitration.top).toContain('沈昼');
    const second = planBeat(rt, 11);
    expect(second.speakerName).toBe(first.speakerName);
  });

  it('仲裁在 top-3 内选择，不越过活候选', () => {
    const ranked = [
      { id: 'a', base: 1, score: 1, jitter: 0, parts: { goal: 0, addr: 0, stake: 0, narr: 0, init: 0 }, addressed: 0, speakCount: 0, capped: false },
      { id: 'b', base: 0.9, score: 0.9, jitter: 0, parts: { goal: 0, addr: 0, stake: 0, narr: 0, init: 0 }, addressed: 0, speakCount: 0, capped: false },
      { id: 'c', base: 0, score: 0, jitter: 0, parts: { goal: 0, addr: 0, stake: 0, narr: 0, init: 0 }, addressed: 0, speakCount: 0, capped: false },
    ];
    for (let seed = 0; seed < 10; seed += 1) {
      const result = arbitrate(ranked, seed, 3);
      expect(['a', 'b']).toContain(result.id);
      expect(result.top).toEqual(['a', 'b']);
    }
  });
});

describe('P1 · 导演', () => {
  it('冲突平坦需要 4 拍窗口且已过 8 拍', () => {
    expect(conflictIsFlat([1, 1, 1, 1], 7, 1)).toBe(false);
    expect(conflictIsFlat([1, 1, 1], 8, 1)).toBe(false);
    expect(conflictIsFlat([1, 1, 1, 1], 8, 1)).toBe(true);
  });

  it('刚升过级不算平坦，避免每拍连升', () => {
    expect(conflictIsFlat([1, 1, 1, 1], 8, 2)).toBe(false);
  });

  it('到 max_level 不再升级', () => {
    expect(conflictIsFlat([4, 4, 4, 4], 12, 4)).toBe(false);
  });

  it('每 interval 拍抽一张 min_level 允许的牌', () => {
    const result = planDirector(
      runtime({
        scene: { ...runtime().scene, beats: PARAMS['scene.event_card_interval'] },
        conflictHistory: [1, 1, 1, 1],
        deck: [
          { id: 'heavy', minLevel: 4, consumed: false, oneShot: true },
          { id: 'light', minLevel: 0, consumed: false, oneShot: false },
        ],
      }),
      PARAMS['scene.event_card_interval'],
    );
    expect(result.card?.id).toBe('light');
    expect(result.deck.map((c) => c.id)).toEqual(['heavy']);
  });

  it('触发谓词不满足的牌留在牌堆', () => {
    const result = planDirector(
      runtime({
        scene: { ...runtime().scene, beats: 6 },
        deck: [
          { id: 'a', minLevel: 0, consumed: false, oneShot: false },
          { id: 'b', minLevel: 0, consumed: false, oneShot: false },
        ],
      }),
      6,
      new Set(['b']),
    );
    expect(result.card?.id).toBe('b');
    expect(result.deck.map((c) => c.id)).toEqual(['a']);
  });

  it('平坦时升级一级', () => {
    const result = planDirector(
      runtime({
        scene: { ...runtime().scene, beats: 9 },
        conflictHistory: [1, 1, 1, 1],
      }),
      9,
    );
    expect(result.flat).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.conflictLevel).toBe(2);
  });

  it('到 max_beats 被识别', () => {
    expect(reachedMaxBeats({ ...runtime().scene, beats: 40 })).toBe(true);
    expect(reachedMaxBeats({ ...runtime().scene, beats: 39 })).toBe(false);
  });
});

describe('P1 · 重放摘要', () => {
  it('同拍序列 → 同 hash', () => {
    const entries = [
      { seq: 1, agent: '旁白', mode: 'forced_narrator' as const },
      { seq: 2, agent: '林砚', mode: 'auto' as const },
    ];
    expect(replayDigest(entries)).toBe(replayDigest([...entries]));
  });

  it('不同序列 → 不同 hash', () => {
    const a = replayDigest([{ seq: 1, agent: '旁白', mode: 'forced_narrator' }]);
    const b = replayDigest([{ seq: 1, agent: '林砚', mode: 'auto' }]);
    expect(a).not.toBe(b);
  });
});
