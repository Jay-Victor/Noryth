/**
 * 参数表（与 docs/params.yaml 逐键一致）
 *
 * docs/params.yaml 是权威。这里保留扁平的原始键名，是为了让
 * packages/core/test/params.test.ts 能逐键比对，避免"改了一处忘了另一处"。
 * 业务代码通过解构别名使用，不直接依赖字符串键。
 *
 * 可调参数恰好 7 个（params.yaml 里带 tunable 标记）：
 *   scheduler.w_narrator · scheduler.max_consecutive · scene.event_card_interval
 *   scene.narrator_max_gap · context.budget_total · memory.floor
 *   consistency.relation_jump_threshold
 */
export const PARAMS = {
  // ── 发言调度 ─────────────────────────────────────────────
  'scheduler.w_goal': 0.34,
  'scheduler.w_addressed': 0.3,
  'scheduler.w_stake': 0.16,
  'scheduler.w_narrator': 0.12,
  'scheduler.w_initiative': 0.08,
  'scheduler.jitter_max': 0.05,
  'scheduler.damp_first': 0.35,
  'scheduler.damp_second': 0.55,
  'scheduler.max_consecutive': 3,
  'scheduler.arbitration_delta': 0.05,
  'scheduler.arbitration_topk': 3,
  'scheduler.max_candidates': 8,
  'scheduler.stake_base': 0.15,
  'scheduler.stake_conflict': 0.22,
  'scheduler.stake_secret': 0.3,
  'scheduler.stake_ownership': 0.2,

  // ── 场景 / 导演 ──────────────────────────────────────────
  'scene.max_beats': 40,
  'scene.flat_conflict_window': 4,
  'scene.flat_conflict_epsilon': 0.05,
  'scene.level_up_step': 1,
  'scene.max_level': 4,
  'scene.event_card_interval': 6,
  'scene.narrator_min_gap': 2,
  'scene.narrator_max_gap': 5,
  'scene.exit_check_every': 1,

  // ── 上下文装配 ───────────────────────────────────────────
  'context.budget_total': 6000,
  'context.ratio_card': 0.15,
  'context.ratio_scene': 0.1,
  'context.ratio_recent': 0.3,
  'context.ratio_memory': 0.2,
  'context.ratio_relation': 0.1,
  'context.ratio_clue': 0.05,
  'context.ratio_contract': 0.1,
  'context.recent_min_beats': 4,
  'context.recent_max_beats': 16,
  'context.memory_topk': 8,
  'context.degrade_summary': 0.85,
  'context.degrade_triple': 0.7,

  // ── 记忆检索 ─────────────────────────────────────────────
  'memory.vector_dim': 512,
  'memory.ann_threshold': 500_000,
  'memory.rrf_k': 60,
  'memory.w_slot': 2.0,
  'memory.w_fts': 1.3,
  'memory.w_vector': 1.0,
  'memory.w_graph': 0.6,
  'memory.rrf_ref': 0.054098,
  'memory.floor': 0.45,
  'memory.mmr_lambda': 0.7,
  'memory.mmr_immune': 3,
  'memory.recency_rho': 0.25,

  // ── 一致性 ───────────────────────────────────────────────
  'consistency.relation_jump_threshold': 0.35,
  'consistency.voice_jsd_threshold': 0.18,
  'consistency.clue_max_age_chapters': 15,
  'consistency.max_reviser_rounds': 3,
  'consistency.knowledge_retry': 1,

  // ── 回退 / 版本 ──────────────────────────────────────────
  'rollback.snapshot_interval': 50,
  'rollback.max_replay_events': 200,
  'git.commit_on_scene_close': true,
} as const;

export type Params = typeof PARAMS;
export type ParamKey = keyof Params;

/** 可调参数预算：多于 7 个说明有人把算法超参当成了用户设置。 */
export const TUNABLE_KEYS = [
  'scheduler.w_narrator',
  'scheduler.max_consecutive',
  'scene.event_card_interval',
  'scene.narrator_max_gap',
  'context.budget_total',
  'memory.floor',
  'consistency.relation_jump_threshold',
] as const satisfies readonly ParamKey[];

/** 七段上下文配额，和为 1（params.test.ts 断言）。 */
export const RATIOS = {
  card: PARAMS['context.ratio_card'],
  scene: PARAMS['context.ratio_scene'],
  recent: PARAMS['context.ratio_recent'],
  memory: PARAMS['context.ratio_memory'],
  relation: PARAMS['context.ratio_relation'],
  clue: PARAMS['context.ratio_clue'],
  contract: PARAMS['context.ratio_contract'],
} as const;

/**
 * rrf_ref 是导出量，不是独立参数：两个精确通道都排第一时的 RRF 原始分。
 * 检索用它做绝对刻度；按本次查询的 max 归一会让任何查询头名都是 1.0。
 */
export const RRF_REF = (PARAMS['memory.w_slot'] + PARAMS['memory.w_fts']) /
  (PARAMS['memory.rrf_k'] + 1);

/** 装配降级阶梯。drop 不是级别，是"整条丢弃"。 */
export const LEVELS = ['full', 'summary', 'triple', 'id'] as const;
export type PackLevel = (typeof LEVELS)[number];

/** 中文 token 估算：CJK 约 0.68 token/字，拉丁/ASCII 约 0.26 token/字符。 */
export const TOK_CJK = 0.68;
export const TOK_LATIN = 0.26;
