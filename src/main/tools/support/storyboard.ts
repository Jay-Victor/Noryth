import { z } from 'zod'
import { validateExitExpr } from './dsl'

/** 分镜草案的共享 schema：T27 校验、T34 提案、阶段 06 的 UI 共用同一份。 */

export const DraftBeatSchema = z.strictObject({
  speaker_type: z.enum(['character', 'narrator']),
  speaker_id: z.string().min(1).max(80),
  intent: z.string().max(500).default(''),
  max_words: z.number().int().min(1).max(2000).optional()
})

export const DraftSceneSchema = z.strictObject({
  scene_id: z.string().min(1).max(80).optional(),
  location: z.string().min(1).max(120),
  participants: z.array(z.string().min(1).max(80)).min(1).max(20),
  goal: z.string().min(1).max(500),
  entry: z.string().max(1000).optional(),
  exit: z.unknown().optional(),
  beats: z.array(DraftBeatSchema).min(1).max(40)
})

export const StoryboardDraftSchema = z.strictObject({
  chapter_id: z.string().min(1).max(80).optional(),
  scenes: z.array(DraftSceneSchema).min(1).max(10)
})

export type StoryboardDraft = z.infer<typeof StoryboardDraftSchema>

export type ConflictSeverity = 'hard' | 'soft'

export interface StoryboardConflict {
  code: string
  severity: ConflictSeverity
  message: string
  scene_ord: number
  beat_ord?: number
}

const MAX_BEATS_PER_SCENE = 40
const MAX_TOTAL_BEATS = 120
const MAX_PARTICIPANTS = 8
const SOFT_MAX_BEAT_WORDS = 300

/** 硬冲突拒绝提交，软冲突只告警（PRD §4.10 T27）。 */
export function validateStoryboard(draft: StoryboardDraft): StoryboardConflict[] {
  const conflicts: StoryboardConflict[] = []
  if (draft.scenes.length === 0) {
    conflicts.push({ code: 'no_scenes', severity: 'hard', message: '分镜没有任何场景', scene_ord: 0 })
    return conflicts
  }

  const seenSceneIds = new Set<string>()
  let totalBeats = 0

  draft.scenes.forEach((scene, sceneIndex) => {
    const sceneOrd = sceneIndex + 1
    if (scene.scene_id) {
      if (seenSceneIds.has(scene.scene_id)) {
        conflicts.push({ code: 'duplicate_scene', severity: 'hard', message: `场景 ${scene.scene_id} 重复`, scene_ord: sceneOrd })
      }
      seenSceneIds.add(scene.scene_id)
    }
    if (scene.beats.length > MAX_BEATS_PER_SCENE) {
      conflicts.push({
        code: 'too_many_beats',
        severity: 'hard',
        message: `场景拍数 ${scene.beats.length} 超过 ${MAX_BEATS_PER_SCENE}`,
        scene_ord: sceneOrd
      })
    }
    if (scene.participants.length > MAX_PARTICIPANTS) {
      conflicts.push({
        code: 'too_many_participants',
        severity: 'soft',
        message: `在场者 ${scene.participants.length} 超过 ${MAX_PARTICIPANTS}，注意力会分散`,
        scene_ord: sceneOrd
      })
    }

    if (typeof scene.exit === 'string') {
      const result = validateExitExpr(scene.exit)
      if (!result.valid) {
        conflicts.push({
          code: 'exit_invalid',
          severity: 'hard',
          message: `出口表达式不可判定：${result.reasons[0] ?? '格式错误'}`,
          scene_ord: sceneOrd
        })
      }
    } else if (scene.exit !== undefined) {
      const dsl = (scene.exit as { dsl?: unknown }).dsl
      if (typeof dsl !== 'string' || !validateExitExpr(dsl).valid) {
        conflicts.push({
          code: 'exit_not_machine_decidable',
          severity: 'soft',
          message: '出口条件不是可判定的 DSL；自动模式将无法收束',
          scene_ord: sceneOrd
        })
      }
    }

    scene.beats.forEach((beat, beatIndex) => {
      totalBeats += 1
      const beatOrd = beatIndex + 1
      if (beat.speaker_type === 'character' && !scene.participants.includes(beat.speaker_id)) {
        conflicts.push({
          code: 'speaker_not_in_participants',
          severity: 'hard',
          message: `角色 ${beat.speaker_id} 不在场景在场者中`,
          scene_ord: sceneOrd,
          beat_ord: beatOrd
        })
      }
      if (beat.speaker_type === 'narrator' && beat.speaker_id !== 'narrator') {
        conflicts.push({
          code: 'narrator_id',
          severity: 'hard',
          message: '旁白拍的 speaker_id 必须是 narrator',
          scene_ord: sceneOrd,
          beat_ord: beatOrd
        })
      }
      if (beat.intent.trim().length === 0) {
        conflicts.push({
          code: 'empty_intent',
          severity: 'soft',
          message: '拍意图为空，执行时容易跑偏',
          scene_ord: sceneOrd,
          beat_ord: beatOrd
        })
      }
      if (beat.max_words !== undefined && beat.max_words > SOFT_MAX_BEAT_WORDS) {
        conflicts.push({
          code: 'beat_too_long',
          severity: 'soft',
          message: `单拍字数上限 ${beat.max_words} 超过 ${SOFT_MAX_BEAT_WORDS}`,
          scene_ord: sceneOrd,
          beat_ord: beatOrd
        })
      }
    })
  })

  if (totalBeats > MAX_TOTAL_BEATS) {
    conflicts.push({
      code: 'too_many_total_beats',
      severity: 'hard',
      message: `总拍数 ${totalBeats} 超过 ${MAX_TOTAL_BEATS}`,
      scene_ord: draft.scenes.length
    })
  }

  return conflicts
}

export function hasHardConflict(conflicts: readonly StoryboardConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'hard')
}
