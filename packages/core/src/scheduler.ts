/**
 * A1 · 发言调度：评分 → 阻尼 → 仲裁。
 *
 * 打分的五个加项之和恒为 1；阻尼是乘法不是减分。减 0.3 会让"目标相关"
 * 永远压不过"刚说过话"；乘法把连任压到 1/3，同时保留被点名时的绝对优先。
 */
import { h01 } from './hash.js';
import { PARAMS } from './params.js';

const {
  'scheduler.w_goal': W_GOAL,
  'scheduler.w_addressed': W_ADDRESSED,
  'scheduler.w_stake': W_STAKE,
  'scheduler.w_narrator': W_NARRATOR,
  'scheduler.w_initiative': W_INITIATIVE,
  'scheduler.jitter_max': JITTER_MAX,
  'scheduler.damp_first': DAMP_FIRST,
  'scheduler.damp_second': DAMP_SECOND,
  'scheduler.max_consecutive': MAX_CONSECUTIVE,
  'scheduler.arbitration_delta': ARBITRATION_DELTA,
  'scene.narrator_min_gap': NARRATOR_MIN_GAP,
  'scene.narrator_max_gap': NARRATOR_MAX_GAP,
} = PARAMS;

export interface Candidate {
  id: string;
  /** 场景开启时由规划结果写死：0 / 0.5 / 1，拍内不变。 */
  goalRel: number;
  initiative: number;
  /** 由 stakeOf() 预先算好，四项构成见 events.ts。 */
  stake: number;
  /** 上一拍是否被点名：1 / 0。 */
  addressed: number;
  isNarrator: boolean;
  /** 距上次发言的拍数；0 = 上一拍刚说过。 */
  since: number;
  /** 连续发言次数（含上一拍）。 */
  streak: number;
  speakCount: number;
}

export interface SchedCtx {
  conflictLevel: number;
  consecutiveDialogue: number;
  beatsSinceNarrator: number;
}

export interface ScoreParts {
  goal: number;
  addr: number;
  stake: number;
  narr: number;
  init: number;
}

export interface Scored {
  id: string;
  base: number;
  score: number;
  jitter: number;
  parts: ScoreParts;
  addressed: number;
  speakCount: number;
  capped: boolean;
}

function compareScored(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.addressed !== b.addressed) return b.addressed - a.addressed;
  if (a.speakCount !== b.speakCount) return a.speakCount - b.speakCount;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 旁白的节奏需求：只在两种情况下非零。
 * 但旁白主要靠硬节奏上台（beats_since_narrator >= max_gap 强制），
 * 因为 W_NARRATOR=0.12 在 5 个角色在场时永远拿不到最高分（实测占比 0%）。
 */
export function narratorNeed(ctx: SchedCtx): number {
  if (ctx.consecutiveDialogue >= NARRATOR_MIN_GAP && ctx.beatsSinceNarrator >= NARRATOR_MIN_GAP) {
    return 1.0;
  }
  if (ctx.beatsSinceNarrator >= NARRATOR_MAX_GAP - 1) {
    return 0.3;
  }
  return 0.0;
}

/** 复杂度 O(n log n)，n = 在场候选数（≤ max_candidates）。空候选集返回 []。 */
export function scoreCandidates(
  cands: readonly Candidate[],
  ctx: SchedCtx,
  seed: number | bigint,
  seq: number,
): Scored[] {
  if (cands.length === 0) return [];
  const need = narratorNeed(ctx);
  const out: Scored[] = cands.map((c) => {
    const parts: ScoreParts = {
      goal: W_GOAL * c.goalRel,
      addr: W_ADDRESSED * c.addressed,
      stake: W_STAKE * c.stake,
      narr: W_NARRATOR * (c.isNarrator ? need : 0),
      init: W_INITIATIVE * c.initiative,
    };
    const base = parts.goal + parts.addr + parts.stake + parts.narr + parts.init;
    const jitter = h01(seed, seq, c.id) * JITTER_MAX;
    return {
      id: c.id,
      base,
      score: base + jitter,
      jitter,
      parts,
      addressed: c.addressed,
      speakCount: c.speakCount,
      capped: false,
    };
  });
  out.sort(compareScored);
  return out;
}

/**
 * 乘法阻尼 + 硬上限。
 * - 被点名（addressed >= 0.5）豁免阻尼——否则读者会觉得这个人物聋了。
 * - 硬上限对**被点名者也生效**（只有用户硬指定才豁免），否则审问戏里
 *   被连续追问的人会连任 5 拍以上。
 * - 旁白不参与阻尼：它的上台由节奏政策决定。
 */
export function applyDamping(
  ranked: Scored[],
  cands: readonly Candidate[],
  capOn = true,
): Scored[] {
  const byId = new Map(cands.map((c) => [c.id, c]));
  for (const r of ranked) {
    const c = byId.get(r.id);
    if (!c || c.isNarrator) continue;
    if (capOn && c.since === 0 && c.streak >= MAX_CONSECUTIVE) {
      r.score = 0;
      r.capped = true;
      continue;
    }
    if (c.addressed >= 0.5) continue;
    if (c.since === 0) {
      r.score *= DAMP_FIRST;
    } else if (c.since === 1) {
      r.score *= DAMP_SECOND;
    }
  }
  ranked.sort(compareScored);
  return ranked;
}

/**
 * 只有两个以上"活着"的候选（score>0）且 top1-top2 < δ 才调小模型。
 * 把被钳制到 0 的候选算进来会制造假平局——每一拍都会触发仲裁。
 */
export function needsArbitration(ranked: readonly Scored[], delta = ARBITRATION_DELTA): boolean {
  const alive = ranked.filter((r) => r.score > 0);
  if (alive.length < 2) return false;
  return alive[0]!.score - alive[1]!.score < delta;
}

/** 取第一个 score>0；全员被钳到 0 时退回排名第一（不返回 null，除非候选为空）。 */
export function pick(ranked: readonly Scored[]): Scored | null {
  for (const r of ranked) {
    if (r.score > 0) return r;
  }
  return ranked[0] ?? null;
}
