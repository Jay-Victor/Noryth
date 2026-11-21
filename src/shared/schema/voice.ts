import { z } from 'zod'

/**
 * 声音指标契约（PHASE-19 §5.1 / §5.4；PRD §4.10 T25）。
 *
 * 指标是派生数据：不写正文、不建 revision、不进 L0–L3。
 * `voice_metric.metrics_json` 与 T25 输出共用同一组形状；T25 比旧契约多
 * `characters[]` / `pairs[]` / `threshold`，旧四字段语义不变。
 */

export const VOICE_HISTOGRAM_SIZE = 6

export const VoiceThresholdSchema = z.strictObject({
  version: z.string().min(1),
  distinctnessMin: z.number().min(0).max(1)
})
export type VoiceThresholdState = z.infer<typeof VoiceThresholdSchema>

export const VoiceCharacterMetricsSchema = z.strictObject({
  characterId: z.string().min(1),
  name: z.string(),
  beatCount: z.number().int().nonnegative(),
  sentenceCount: z.number().int().nonnegative(),
  avgSentenceLength: z.number().nonnegative(),
  /** 6 个桶的归一化直方图（1–10 / 11–20 / 21–30 / 31–40 / 41–60 / 60+）。 */
  histogram: z.array(z.number().min(0).max(1)).length(VOICE_HISTOGRAM_SIZE),
  catchphraseRate: z.number().min(0).max(1),
  questionRate: z.number().min(0).max(1),
  firstPersonRate: z.number().min(0).max(1),
  catchphrases: z.array(z.string()).max(32)
})
export type VoiceCharacterMetricsState = z.infer<typeof VoiceCharacterMetricsSchema>

export const VoicePairMetricsSchema = z.strictObject({
  a: z.string().min(1),
  b: z.string().min(1),
  aName: z.string(),
  bName: z.string(),
  score: z.number().min(0).max(1),
  sentenceLengthJsd: z.number().min(0).max(1),
  catchphraseDelta: z.number().min(0).max(1),
  questionDelta: z.number().min(0).max(1),
  firstPersonDelta: z.number().min(0).max(1)
})
export type VoicePairMetricsState = z.infer<typeof VoicePairMetricsSchema>

export const VoiceAggregateSchema = z.strictObject({
  /** 各对 √JSD 的平均（旧字段语义）。 */
  sentenceLengthJsd: z.number().min(0).max(1),
  /** 各对角色口头禅率的平均（旧字段语义）。 */
  catchphraseRate: z.number().min(0).max(1),
  /** 各对角色问句率的平均（旧字段语义）。 */
  questionRate: z.number().min(0).max(1),
  firstPersonRate: z.number().min(0).max(1),
  /** 最低一对（最差的一对才是告警对象）。 */
  pairwiseDistinctness: z.number().min(0).max(1)
})
export type VoiceAggregateState = z.infer<typeof VoiceAggregateSchema>

/** 持久化形状（`voice_metric.metrics_json`）：未知字段丢弃。 */
export const SceneVoiceMetricsSchema = z.strictObject({
  characters: z.array(VoiceCharacterMetricsSchema),
  pairs: z.array(VoicePairMetricsSchema),
  aggregate: VoiceAggregateSchema,
  /** true = 角色少于 2 人或某角色少于 2 拍；0 不代表「很区分」。 */
  insufficientData: z.boolean(),
  threshold: VoiceThresholdSchema
})
export type SceneVoiceMetrics = z.infer<typeof SceneVoiceMetricsSchema>

export const VoiceSceneInputSchema = z.strictObject({
  sceneId: z.string().min(1).max(80),
  /** 省略 = 定稿读 final、其余读当前稿（PHASE-19 §5.1）。 */
  revisionId: z.string().min(1).max(80).optional()
})
export type VoiceSceneInput = z.infer<typeof VoiceSceneInputSchema>

export const VoiceSceneStateSchema = z.strictObject({
  sceneId: z.string(),
  chapterId: z.string().nullable(),
  revisionId: z.string().nullable(),
  /** 有可展示的指标行（含按需重算）；空场景 / 无 revision 为 false。 */
  found: z.boolean(),
  /** 读到旧行（revision 或阈值版本不一致）并按需重算过。 */
  stale: z.boolean(),
  threshold: VoiceThresholdSchema,
  insufficientData: z.boolean(),
  aggregate: VoiceAggregateSchema,
  characters: z.array(VoiceCharacterMetricsSchema),
  pairs: z.array(VoicePairMetricsSchema),
  /** pairs 非空且最低一对低于阈值；只用于 UI 告警。 */
  belowThreshold: z.boolean(),
  computedAt: z.string().nullable()
})
export type VoiceSceneState = z.infer<typeof VoiceSceneStateSchema>
