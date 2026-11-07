/**
 * 跨语言一致性：同一组输入，Python 探针与 TS 实现必须给出同一个数。
 * 夹具由 scripts/gen-parity.py 从 design/probe/noryth_proto.py 生成。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDamping,
  buildAudience,
  drawEventCard,
  estTokens,
  evalExit,
  factKey,
  h01,
  needsArbitration,
  packContext,
  pick,
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
} from '@noryth/core';

interface Fixture {
  hash: { parts: string[]; value: number }[];
  tokens: { text: string; value: number }[];
  scheduler: {
    candidates: Array<{
      id: string;
      goal_rel: number;
      initiative: number;
      stake: number;
      addressed: number;
      is_narrator: boolean;
      since: number;
      _streak: number;
      speak_count: number;
    }>;
    ctx: { conflict_level: number; consecutive_dialogue: number; beats_since_narrator: number };
    seed: number;
    seq: number;
    ranked: Array<{
      id: string;
      base: number;
      score: number;
      jitter: number;
      parts: { goal: number; addr: number; stake: number; narr: number; init: number };
      addressed: number;
      speak_count: number;
    }>;
    damped: Array<{ id: string; score: number; capped: boolean }>;
    capped_input: Fixture['scheduler']['candidates'];
    capped: Array<{ id: string; score: number; capped: boolean }>;
    arbitration: boolean;
    pick: string;
  };
  stake: { conflict: number; secret: boolean; ownership: number; value: number }[];
  context: Record<'big' | 'tiny' | 'fits', { kept: string[]; level: string; tokens: number; dropped: number }>;
  knowledge: Record<'lin' | 'shen', { id: string; object: string; redacted?: boolean }[]> & {
    nobody: unknown[];
  };
  audience: { mode: string; audience: string[] }[];
  exit: {
    state: {
      facts: { subject: string; predicate: string; object: unknown }[];
      rels: { from: string; to: string; axis: string; value: number }[];
      beats: number;
    };
    cases: { expr: ExitExpr; expected: boolean }[];
  };
  voice: { a: string[]; b: string[]; distance: number }[];
  relation: { old: number; new: number; delta: number; verdict: string }[];
  card: {
    deck: { id: string; min_level: number; consumed: boolean; one_shot: boolean }[];
    level: number;
    turn: number;
    flat: boolean;
    card: string | null;
    rest: string[];
  };
}

const fixture = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), 'packages/core/test/fixtures/parity.json'),
    'utf8',
  ),
) as Fixture;

function cands(source: Fixture['scheduler']['candidates']): Candidate[] {
  return source.map((c) => ({
    id: c.id,
    goalRel: c.goal_rel,
    initiative: c.initiative,
    stake: c.stake,
    addressed: c.addressed,
    isNarrator: c.is_narrator,
    since: c.since,
    streak: c._streak,
    speakCount: c.speak_count,
  }));
}

describe('跨语言一致性 · 哈希与 token', () => {
  it('h01 与 Python 逐值相等', () => {
    for (const item of fixture.hash) {
      expect(h01(...item.parts), item.parts.join('|')).toBeCloseTo(item.value, 15);
    }
  });

  it('estTokens 与 Python 逐值相等', () => {
    for (const item of fixture.tokens) {
      expect(estTokens(item.text), item.text).toBe(item.value);
    }
  });
});

describe('跨语言一致性 · 调度', () => {
  it('scoreCandidates 的分项、抖动与排序一致', () => {
    const c = cands(fixture.scheduler.candidates);
    const ctx = {
      conflictLevel: fixture.scheduler.ctx.conflict_level,
      consecutiveDialogue: fixture.scheduler.ctx.consecutive_dialogue,
      beatsSinceNarrator: fixture.scheduler.ctx.beats_since_narrator,
    };
    const ranked = scoreCandidates(c, ctx, fixture.scheduler.seed, fixture.scheduler.seq);
    expect(ranked.map((r) => r.id)).toEqual(fixture.scheduler.ranked.map((r) => r.id));
    for (const [i, expected] of fixture.scheduler.ranked.entries()) {
      const got = ranked[i]!;
      expect(got.base).toBeCloseTo(expected.base, 12);
      expect(got.score).toBeCloseTo(expected.score, 12);
      expect(got.jitter).toBeCloseTo(expected.jitter, 15);
      expect(got.parts.goal).toBeCloseTo(expected.parts.goal, 12);
      expect(got.parts.addr).toBeCloseTo(expected.parts.addr, 12);
      expect(got.parts.stake).toBeCloseTo(expected.parts.stake, 12);
      expect(got.parts.narr).toBeCloseTo(expected.parts.narr, 12);
      expect(got.parts.init).toBeCloseTo(expected.parts.init, 12);
      expect(got.addressed).toBe(expected.addressed);
      expect(got.speakCount).toBe(expected.speak_count);
    }
  });

  it('applyDamping 后的分数与 capped 标记一致', () => {
    const c = cands(fixture.scheduler.candidates);
    const ctx = {
      conflictLevel: fixture.scheduler.ctx.conflict_level,
      consecutiveDialogue: fixture.scheduler.ctx.consecutive_dialogue,
      beatsSinceNarrator: fixture.scheduler.ctx.beats_since_narrator,
    };
    const ranked = applyDamping(
      scoreCandidates(c, ctx, fixture.scheduler.seed, fixture.scheduler.seq),
      c,
    );
    expect(ranked.map((r) => r.id)).toEqual(fixture.scheduler.damped.map((r) => r.id));
    for (const [i, expected] of fixture.scheduler.damped.entries()) {
      expect(ranked[i]!.score).toBeCloseTo(expected.score, 12);
      expect(ranked[i]!.capped).toBe(expected.capped);
    }
  });

  it('硬上限用例与仲裁/选择一致', () => {
    const capped = cands(fixture.scheduler.capped_input);
    const ctx = {
      conflictLevel: fixture.scheduler.ctx.conflict_level,
      consecutiveDialogue: 9,
      beatsSinceNarrator: fixture.scheduler.ctx.beats_since_narrator,
    };
    const ranked = applyDamping(
      scoreCandidates(capped, ctx, fixture.scheduler.seed, fixture.scheduler.seq),
      capped,
    );
    for (const [i, expected] of fixture.scheduler.capped.entries()) {
      expect(ranked[i]!.score).toBeCloseTo(expected.score, 12);
      expect(ranked[i]!.capped).toBe(expected.capped);
    }
    expect(needsArbitration(ranked)).toBe(fixture.scheduler.arbitration);
    expect(pick(ranked)?.id).toBe(fixture.scheduler.pick);
  });
});

describe('跨语言一致性 · 上下文装配', () => {
  const beatProse = ('雨水顺着屋檐砸在青石板上，林砚把账本往袖口里又塞了塞，'.repeat(2)).slice(0, 118);
  const beatStruct = '{"line":"你迟到了。","act":"把伞收拢","mind":"他在试探我","intent":"试探"}';
  const factText = '林砚持有沈昼的秘密7（保密2）';

  function bigSections(): PackSection[] {
    return [
      {
        name: 'card',
        items: [{ full: '卡'.repeat(400), summary: '卡'.repeat(340), triple: '卡'.repeat(280), id: 'c1', keepRank: 1 }],
      },
      {
        name: 'recent',
        items: Array.from({ length: 40 }, (_, i) => ({
          full: beatProse + beatStruct,
          summary: beatProse.slice(0, 60),
          triple: '林砚·迟到',
          id: `b${i}`,
          keepRank: 2,
        })),
      },
      {
        name: 'memory',
        items: Array.from({ length: 200 }, (_, i) => ({
          full: factText,
          summary: '林砚知道秘密7',
          triple: '林砚|知道|秘密7',
          id: `m${i}`,
          keepRank: 3,
        })),
      },
    ];
  }

  function assertPack(actual: ReturnType<typeof packContext>, expected: Fixture['context']['big']): void {
    expect(actual.kept.map((k) => `${k.section}:${k.item.id}`)).toEqual(expected.kept);
    expect(actual.level).toBe(expected.level);
    expect(actual.tokens).toBe(expected.tokens);
    expect(actual.dropped).toBe(expected.dropped);
  }

  it('40 拍 / 200 事实的大装配一致（文档 4352 tok / full）', () => {
    assertPack(packContext(bigSections(), 6000), fixture.context.big);
  });

  it('极端超预算降到 id+drop 并整条丢弃', () => {
    const tiny: PackSection[] = [
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
    assertPack(packContext(tiny, 1000), fixture.context.tiny);
  });

  it('预算内的装配保持 full', () => {
    const fits: PackSection[] = [
      {
        name: 's',
        items: [{ full: '短句', summary: '短', triple: '短', id: 's1', keepRank: 1 }],
      },
    ];
    assertPack(packContext(fits, 100), fixture.context.fits);
  });
});

describe('跨语言一致性 · 限知与感知', () => {
  const facts = [
    { id: 'f1', secrecy: 0, object: '甲' },
    { id: 'f2', secrecy: 0, object: '乙' },
    { id: 'f3', secrecy: 3, object: '真凶', redactFor: new Set(['lin']) },
    { id: 'f4', secrecy: 3, object: '账本', redactFor: new Set() },
  ];
  const cognition = [
    { characterId: 'lin', factId: 'f1', learnedSeq: 1, attitude: 'knows' as const, certainty: 1 },
    { characterId: 'lin', factId: 'f3', learnedSeq: 1, attitude: 'knows' as const, certainty: 1 },
    { characterId: 'lin', factId: 'f4', learnedSeq: 1, attitude: 'knows' as const, certainty: 1 },
    { characterId: 'shen', factId: 'f2', learnedSeq: 1, attitude: 'knows' as const, certainty: 1 },
  ];

  it('visibleFacts 的集合与脱敏结果一致', () => {
    const lin = visibleFacts(facts, 'lin', cognition).map((f) => ({
      id: f.id,
      object: f.object,
      redacted: f.redacted === true,
    }));
    expect(lin).toEqual(fixture.knowledge.lin);
    expect(visibleFacts(facts, 'shen', cognition).map((f) => ({ id: f.id, object: f.object })))
      .toEqual(fixture.knowledge.shen);
    expect(visibleFacts(facts, 'nobody', cognition)).toEqual(fixture.knowledge.nobody);
  });

  it('buildAudience 四种模式一致', () => {
    const present = ['lin', 'shen', 'qi'];
    const cases: Record<string, string[]> = {
      public: buildAudience(present, 'lin', 'public'),
      whisper: buildAudience(present, 'lin', 'whisper', ['shen', 'qi']),
      soliloquy: buildAudience(present, 'lin', 'soliloquy'),
      narrator_reader: buildAudience(present, 'narrator', 'narrator_reader'),
    };
    for (const item of fixture.audience) {
      expect(cases[item.mode], item.mode).toEqual(item.audience);
    }
  });
});

describe('跨语言一致性 · 收束求值', () => {
  it('九个表达式的结果一致', () => {
    const state: SceneEvalState = {
      facts: new Map(
        fixture.exit.state.facts.map((f) => [factKey(f.subject, f.predicate), f.object]),
      ),
      rels: new Map(
        fixture.exit.state.rels.map((r) => [relKey(r.from, r.to, r.axis), r.value]),
      ),
      beats: fixture.exit.state.beats,
    };
    for (const item of fixture.exit.cases) {
      expect(evalExit(item.expr, state), JSON.stringify(item.expr)).toBe(item.expected);
    }
  });
});

describe('跨语言一致性 · 其他仪器', () => {
  it('stakeOf 一致', () => {
    for (const item of fixture.stake) {
      expect(stakeOf(item.conflict, item.secret, item.ownership)).toBeCloseTo(item.value, 12);
    }
  });

  it('voiceDistance 一致', () => {
    for (const item of fixture.voice) {
      expect(voiceDistance(item.a, item.b)).toBeCloseTo(item.distance, 12);
    }
  });

  it('relationJump 一致', () => {
    for (const item of fixture.relation) {
      expect(relationJump(item.old, item.new)).toEqual({
        delta: item.delta,
        verdict: item.verdict,
      });
    }
  });

  it('drawEventCard 一致', () => {
    const deck = fixture.card.deck.map((c) => ({
      id: c.id,
      minLevel: c.min_level,
      consumed: c.consumed,
      oneShot: c.one_shot,
    }));
    const result = drawEventCard(deck, fixture.card.level, fixture.card.turn, fixture.card.flat);
    expect(result.card?.id ?? null).toBe(fixture.card.card);
    expect(result.deck.map((c) => c.id)).toEqual(fixture.card.rest);
  });
});
