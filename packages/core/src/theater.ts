/**
 * P1 · 剧场决策：一拍由谁说话、导演如何推进。
 *
 * 这一层零 I/O，输入是"某一拍开始前的场景快照"，输出是纯决策。
 * 因此 500 拍仿真、回退复演、CLI 单步共用同一份逻辑（01 §6 A1、03 §4）。
 *
 * 两个陷阱写死在实现里：
 * 1. 旁白靠硬节奏上台，不靠 W_NARRATOR 竞争（实测占比 0%）；
 * 2. 仲裁只看 score > 0 的候选，被钳制到 0 的不算平局。
 */
import { h01, sha256Hex, canonicalJson } from './hash.js';
import { PARAMS } from './params.js';
import { drawEventCard, type DeckCard } from './events.js';
import {
  applyDamping,
  needsArbitration,
  pick,
  scoreCandidates,
  type Candidate,
  type Scored,
} from './scheduler.js';
import type { BeatMode, SceneState } from './types.js';

const {
  'scene.max_level': MAX_LEVEL,
  'scene.narrator_max_gap': NARRATOR_MAX_GAP,
  'scene.flat_conflict_window': FLAT_WINDOW,
  'scene.flat_conflict_epsilon': FLAT_EPSILON,
  'scene.level_up_step': LEVEL_STEP,
  'scene.event_card_interval': CARD_INTERVAL,
  'scheduler.arbitration_topk': ARBITRATION_TOPK,
  'scheduler.stake_base': STAKE_BASE,
  'scheduler.stake_conflict': STAKE_CONFLICT,
  'scheduler.stake_secret': STAKE_SECRET,
  'scheduler.stake_ownership': STAKE_OWNERSHIP,
  'scene.exit_check_every': EXIT_CHECK_EVERY,
} = PARAMS;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 场景的最小运行时投影（store 从 scene 行读出来）。 */
export interface SceneRuntime {
  id: string;
  state: SceneState;
  present: readonly string[];
  conflictLevel: number;
  maxBeats: number;
  beats: number;
}

/** 一个可发言者：角色或旁白。stats 由 beat 历史推出，保证回退后可复演。 */
export interface ActorRuntime {
  /** 角色 = entity id；旁白 = 'narrator'。 */
  id: string;
  name: string;
  isNarrator: boolean;
  /** 场景开启时由规划结果写死：0 / 0.5 / 1。 */
  goalRel: number;
  initiative: number;
  secretThreat: boolean;
  ownership: number;
  speakCount: number;
  /** 距上次发言的拍数；0 = 上一拍刚说过。 */
  since: number;
  /** 连续发言次数（含上一拍）。 */
  streak: number;
}

export interface TheaterRuntime {
  scene: SceneRuntime;
  actors: readonly ActorRuntime[];
  /** 距上一拍旁白的拍数；从未出现时 = scene.beats（第一拍必旁白）。 */
  beatsSinceNarrator: number;
  /** 尾部连续角色发言数。 */
  consecutiveDialogue: number;
  /** 上一拍点名了谁（按名字，跨分支稳定，回退后仍能对上）。 */
  addressedTo: readonly string[];
  /** 最近 N 拍的冲突等级，最后一项是最新。 */
  conflictHistory: readonly number[];
  deck: readonly DeckCard[];
}

export interface BeatPlanOptions {
  /** 用户硬指定：同时豁免阻尼与硬上限（03 §4）。 */
  userPick?: string;
  /** 手动收束：强制旁白。 */
  forceNarrator?: boolean;
  /** 事件卡触发谓词是否满足（由 store 用 exit 求值器判定）。 */
  eligibleCards?: ReadonlySet<string>;
}

export interface BeatPlan {
  speakerId: string;
  speakerName: string;
  isNarrator: boolean;
  mode: BeatMode;
  /** 评分排名（强制旁白时为空：跳过评分）。 */
  ranked: Scored[];
  arbitration: { needed: boolean; top: string[]; pickedBy: 'hash' | 'score' | 'none' };
  /** 阻尼前的分数（写入 beat.score）。 */
  preDamp: number;
  /** 阻尼后的分数（写入 beat.damped）。 */
  damped: number;
  /** 本拍使用的冲突等级（可能已升级）。 */
  conflictLevel: number;
  escalated: boolean;
  flatConflict: boolean;
  card: DeckCard | null;
  deck: DeckCard[];
}

/** 旁白的 stake 恒为 0：它不为任何目标下注。 */
function candidateOf(
  actor: ActorRuntime,
  conflictLevel: number,
  addressed: readonly string[],
): Candidate {
  return {
    // 评分用**名字**而不是随机 entity id：回退会重建实体与主键，
    // 用 id 做抖动会让同一 seed 在新分支上选出不同的人（门禁 9）。
    id: actor.name,
    // 旁白没有"目标相关度"：探针里 narrator 的 goal_rel 恒为 0。
    goalRel: actor.isNarrator ? 0 : actor.goalRel,
    initiative: actor.initiative,
    stake: actor.isNarrator
      ? 0
      : clamp(
          STAKE_BASE +
            STAKE_CONFLICT * clamp(conflictLevel / MAX_LEVEL, 0, 1) +
            (actor.secretThreat ? STAKE_SECRET : 0) +
            STAKE_OWNERSHIP * clamp(actor.ownership, 0, 1),
          0,
          1,
        ),
    addressed: addressed.includes(actor.name) || addressed.includes(actor.id) ? 1 : 0,
    isNarrator: actor.isNarrator,
    since: actor.since,
    streak: actor.streak,
    speakCount: actor.speakCount,
  };
}

/**
 * 冲突是否平坦：最近 N 拍极差 < ε 且已过 8 拍（03 §5.2）。
 * 两个补充条件防止"每拍都升级"：
 * - 当前等级已经高于窗口末值 → 上一次升级还没被 4 拍消化，不再算平坦；
 * - 已到 max_level → 不再升级（否则会在 4 级上无限重复"4→4"）。
 */
export function conflictIsFlat(
  history: readonly number[],
  turn: number,
  currentLevel = Number.NaN,
): boolean {
  if (turn < 8 || history.length < FLAT_WINDOW) return false;
  if (currentLevel >= MAX_LEVEL) return false;
  const window = history.slice(-FLAT_WINDOW);
  if (
    Number.isFinite(currentLevel) &&
    Math.abs(currentLevel - window[window.length - 1]!) > FLAT_EPSILON
  ) {
    return false;
  }
  return Math.max(...window) - Math.min(...window) < FLAT_EPSILON;
}

/**
 * 仲裁在 top-3 里选一个。离线/确定性模式下用 hash(seed, seq, 'arbiter') 选择，
 * 与真实 LLM 仲裁同契约（都只能从 top-3 里挑），但保证回退后可复演。
 */
export function arbitrate(
  ranked: readonly Scored[],
  seed: number | bigint,
  seq: number,
): { id: string; top: string[] } {
  const alive = ranked.filter((r) => r.score > 0).slice(0, ARBITRATION_TOPK);
  const top = alive.map((r) => r.id);
  if (alive.length === 0) return { id: ranked[0]?.id ?? '', top };
  const index = Math.min(alive.length - 1, Math.floor(h01(seed, seq, 'arbiter') * alive.length));
  return { id: alive[index]!.id, top };
}

/**
 * 一拍开始前的完整计划：谁说话 + 导演要不要抽牌/升级冲突。
 * 同 seed 同 runtime 必须得到同一结果（P1 门禁 9）。
 */
export function planBeat(
  runtime: TheaterRuntime,
  seed: number | bigint,
  options: BeatPlanOptions = {},
): BeatPlan {
  const { scene, actors } = runtime;
  const seq = scene.beats + 1;

  if (scene.state !== 'open' && scene.state !== 'closing') {
    throw new Error(`场景状态 ${scene.state} 不可继续推进（只允许 open / closing）`);
  }

  const narrator = actors.find((a) => a.isNarrator);
  if (!narrator) throw new Error('缺少旁白 actor：场景必须有 1 个旁白');

  const forceNarrator =
    options.forceNarrator === true ||
    scene.state === 'closing' ||
    scene.beats === 0 ||
    runtime.beatsSinceNarrator >= NARRATOR_MAX_GAP;

  // ── 用户硬指定：跳过评分与阻尼，但仍记录分数供审计 ────────────────────
  if (options.userPick !== undefined) {
    const chosen = actors.find((a) => a.id === options.userPick || a.name === options.userPick);
    if (!chosen) throw new Error(`指定发言者不在场：${options.userPick}`);
    const rated = scoreCandidates(
      actors.map((a) => candidateOf(a, scene.conflictLevel, runtime.addressedTo)),
      {
        conflictLevel: scene.conflictLevel,
        consecutiveDialogue: runtime.consecutiveDialogue,
        beatsSinceNarrator: runtime.beatsSinceNarrator,
      },
      seed,
      seq,
    );
    const row = rated.find((r) => r.id === chosen.name);
    const director = planDirector(runtime, seq, options.eligibleCards);
    return {
      speakerId: chosen.id,
      speakerName: chosen.name,
      isNarrator: chosen.isNarrator,
      mode: 'user_pick',
      ranked: rated,
      arbitration: { needed: false, top: [], pickedBy: 'none' },
      preDamp: row?.score ?? 0,
      damped: row?.score ?? 0,
      conflictLevel: director.conflictLevel,
      escalated: director.escalated,
      flatConflict: director.flat,
      card: director.card,
      deck: director.deck,
    };
  }

  // ── 硬节奏：场景第一拍 / 距上拍旁白 ≥ max_gap / 收束 ───────────────────
  if (forceNarrator) {
    const director = planDirector(runtime, seq, options.eligibleCards);
    return {
      speakerId: narrator.id,
      speakerName: narrator.name,
      isNarrator: true,
      mode: 'forced_narrator',
      ranked: [],
      arbitration: { needed: false, top: [], pickedBy: 'none' },
      preDamp: 1,
      damped: 1,
      conflictLevel: director.conflictLevel,
      escalated: director.escalated,
      flatConflict: director.flat,
      card: director.card,
      deck: director.deck,
    };
  }

  const pool = actors.map((a) => candidateOf(a, scene.conflictLevel, runtime.addressedTo));
  const scored = scoreCandidates(
    pool,
    {
      conflictLevel: scene.conflictLevel,
      consecutiveDialogue: runtime.consecutiveDialogue,
      beatsSinceNarrator: runtime.beatsSinceNarrator,
    },
    seed,
    seq,
  );
  const preDamp = new Map(scored.map((r) => [r.id, r.score]));
  const ranked = applyDamping(scored, pool, true);

  const arbitrated = needsArbitration(ranked);
  let chosen: Scored | null;
  let pickedBy: 'hash' | 'score' | 'none' = 'none';
  if (arbitrated) {
    const result = arbitrate(ranked, seed, seq);
    chosen = ranked.find((r) => r.id === result.id) ?? null;
    pickedBy = 'hash';
  } else {
    chosen = pick(ranked);
    pickedBy = 'score';
  }
  if (!chosen) throw new Error('没有可发言的候选：场景 present 为空');

  const actor = actors.find((a) => a.name === chosen.id)!;
  const director = planDirector(runtime, seq, options.eligibleCards);
  return {
    speakerId: actor.id,
    speakerName: actor.name,
    isNarrator: actor.isNarrator,
    mode: arbitrated ? 'arbitrated' : 'auto',
    ranked,
    arbitration: {
      needed: arbitrated,
      top: ranked.filter((r) => r.score > 0).slice(0, ARBITRATION_TOPK).map((r) => r.id),
      pickedBy,
    },
    preDamp: preDamp.get(chosen.id) ?? chosen.score,
    damped: chosen.score,
    conflictLevel: director.conflictLevel,
    escalated: director.escalated,
    flatConflict: director.flat,
    card: director.card,
    deck: director.deck,
  };
}

export interface DirectorPlan {
  conflictLevel: number;
  escalated: boolean;
  flat: boolean;
  card: DeckCard | null;
  deck: DeckCard[];
}

/**
 * 导演的机械动作：抽牌 → 冲突升级。
 * 抽牌时机：每 interval 拍，或冲突连续 window 拍极差 < ε。
 * min_level 用升级前的等级判定（03 §5 的顺序）。
 */
export function planDirector(
  runtime: TheaterRuntime,
  turn: number = runtime.scene.beats,
  eligibleCards?: ReadonlySet<string>,
): DirectorPlan {
  const flat = conflictIsFlat(
    runtime.conflictHistory,
    turn,
    runtime.scene.conflictLevel,
  );
  const eligible = eligibleCards
    ? (card: DeckCard) => eligibleCards.has(card.id)
    : undefined;
  const drawn = drawEventCard(
    runtime.deck,
    runtime.scene.conflictLevel,
    turn,
    flat,
    CARD_INTERVAL,
    eligible,
  );
  const escalated = flat;
  const conflictLevel = escalated
    ? clamp(runtime.scene.conflictLevel + LEVEL_STEP, 0, MAX_LEVEL)
    : runtime.scene.conflictLevel;
  return { conflictLevel, escalated, flat, card: drawn.card, deck: drawn.deck };
}

/**
 * 场景是否已到硬上限：到 max_beats 仍未收束，必须 WARN + 关闭，不静默截断
 * （P1 门禁 10）。
 */
export function reachedMaxBeats(scene: SceneRuntime): boolean {
  return scene.beats >= scene.maxBeats;
}

/** 是否该做收束求值。每拍一次（scene.exit_check_every = 1）。 */
export function shouldCheckExit(beats: number): boolean {
  return EXIT_CHECK_EVERY <= 0 || beats % EXIT_CHECK_EVERY === 0;
}

export interface BeatDigestEntry {
  seq: number;
  agent: string;
  mode: BeatMode;
}

/** 回退后重放一致性（门禁 9）：同一拍序列 → 同一 hash。 */
export function replayDigest(entries: readonly BeatDigestEntry[]): string {
  return sha256Hex(canonicalJson(entries.map((e) => [e.seq, e.agent, e.mode])));
}
