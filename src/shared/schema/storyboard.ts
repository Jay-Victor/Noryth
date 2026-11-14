import { z } from 'zod'

/**
 * 分镜草案的共享 schema（PRD §4.10 T27/T34、UI 分镜编辑器、G2 物化）。
 *
 * 一份 schema 三个消费者：T27 校验、T34 提案、创作台分镜编辑器；
 * 任何字段变更都必须同时更新这三处，否则会出现「UI 存得进、工具校验不过」。
 */

export const DraftBeatSchema = z.strictObject({
  /** 场景内拍序；缺省按数组下标。 */
  ord: z.number().int().min(1).max(200).optional(),
  speaker_type: z.enum(['character', 'narrator']),
  speaker_id: z.string().min(1).max(80),
  intent: z.string().max(500).default(''),
  max_words: z.number().int().min(1).max(2000).optional(),
  /** 作者视角的剧透；不进任何 Agent 上下文。 */
  notes: z.string().max(1000).optional()
})
export type DraftBeat = z.infer<typeof DraftBeatSchema>

export const DraftSceneSchema = z.strictObject({
  scene_id: z.string().min(1).max(80).optional(),
  location: z.string().min(1).max(120),
  participants: z.array(z.string().min(1).max(80)).min(1).max(20),
  goal: z.string().min(1).max(500),
  entry: z.string().max(1000).optional(),
  /** 出口条件：DSL 文本或 JSON AST；校验见 shared/dsl/exit.ts。 */
  exit: z.unknown().optional(),
  /** 场景拍数上限（DEV-PLAN §8.2 max_beats）。 */
  max_beats: z.number().int().min(1).max(200).optional(),
  beats: z.array(DraftBeatSchema).min(1).max(40)
})
export type DraftScene = z.infer<typeof DraftSceneSchema>

export const StoryboardDraftSchema = z.strictObject({
  chapter_id: z.string().min(1).max(80).optional(),
  scenes: z.array(DraftSceneSchema).min(1).max(10)
})
export type StoryboardDraft = z.infer<typeof StoryboardDraftSchema>

export const StoryboardConflictSchema = z.strictObject({
  code: z.string(),
  severity: z.enum(['hard', 'soft']),
  message: z.string(),
  scene_ord: z.number().int(),
  beat_ord: z.number().int().optional()
})
export type StoryboardConflict = z.infer<typeof StoryboardConflictSchema>
export type ConflictSeverity = StoryboardConflict['severity']

export function hasHardConflict(conflicts: readonly StoryboardConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'hard')
}

/** 冲突的人话文案（G2 按钮的「第一条原因」与行内提示共用）。 */
export function firstConflictReason(conflicts: readonly StoryboardConflict[]): string | null {
  const first = conflicts.find((conflict) => conflict.severity === 'hard') ?? conflicts[0]
  return first ? first.message : null
}
