import type { ExitRegistry } from './exit'
import { parseExitInput } from './exit'
import type { DraftScene, StoryboardConflict, StoryboardDraft } from '../schema/storyboard'

/**
 * 分镜校验（T27 / G2 / 分镜编辑器共用）。
 *
 * 硬冲突 = 开演前必须修掉；软冲突 = 只告警。所有判定都是确定性的：
 * 在场者、字数上限、出口 DSL 可判定性、角色卡禁忌词。
 */

export interface StoryboardCardView {
  taboo?: string
  bannedWords?: string
}

export interface StoryboardValidationOptions {
  registry?: ExitRegistry
  characters?: ReadonlyMap<string, StoryboardCardView>
}

const MAX_BEATS_PER_SCENE = 40
const MAX_TOTAL_BEATS = 120
const MAX_PARTICIPANTS = 8
const SOFT_MAX_BEAT_WORDS = 300

function splitTerms(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split(/[,，、;；/\n|]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
}

export function validateStoryboard(
  draft: StoryboardDraft | { chapter_id?: string; scenes: DraftScene[] },
  options: StoryboardValidationOptions = {}
): StoryboardConflict[] {
  const conflicts: StoryboardConflict[] = []
  if (draft.scenes.length === 0) {
    conflicts.push({ code: 'no_scenes', severity: 'hard', message: '分镜没有任何场景', scene_ord: 0 })
    return conflicts
  }
  if (draft.scenes.length > 10) {
    conflicts.push({ code: 'too_many_scenes', severity: 'hard', message: `场景数 ${draft.scenes.length} 超过 10`, scene_ord: 10 })
  }

  const seenSceneIds = new Set<string>()
  let totalBeats = 0

  draft.scenes.forEach((scene, sceneIndex) => {
    const sceneOrd = sceneIndex + 1
    if (scene.scene_id) {
      if (seenSceneIds.has(scene.scene_id)) {
        conflicts.push({
          code: 'duplicate_scene',
          severity: 'hard',
          message: `场景 ${scene.scene_id} 重复`,
          scene_ord: sceneOrd
        })
      }
      seenSceneIds.add(scene.scene_id)
    }

    const sceneMax = scene.max_beats ?? MAX_BEATS_PER_SCENE
    if (sceneMax > MAX_BEATS_PER_SCENE) {
      conflicts.push({
        code: 'max_beats_too_high',
        severity: 'hard',
        message: `场景拍数上限 ${sceneMax} 超过 ${MAX_BEATS_PER_SCENE}`,
        scene_ord: sceneOrd
      })
    }
    if (scene.beats.length > sceneMax) {
      conflicts.push({
        code: 'too_many_beats',
        severity: 'hard',
        message: `场景拍数 ${scene.beats.length} 超过上限 ${sceneMax}`,
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

    const exitValidation = parseExitInput(
      scene.exit,
      options.registry === undefined
        ? { participants: new Set(scene.participants), maxBeats: sceneMax }
        : { ...options.registry, participants: new Set(scene.participants), maxBeats: sceneMax }
    )
    if (!exitValidation.valid) {
      conflicts.push({
        code: 'exit_invalid',
        severity: 'hard',
        message: `出口条件不可判定：${exitValidation.reasons[0] ?? '格式错误'}`,
        scene_ord: sceneOrd
      })
    } else if (!exitValidation.machine_decidable) {
      conflicts.push({
        code: 'exit_not_machine_decidable',
        severity: 'hard',
        message: `出口条件引用了未登记的实体/谓词：${exitValidation.reasons[0] ?? '无法求值'}`,
        scene_ord: sceneOrd
      })
    } else if (exitValidation.beats_only) {
      conflicts.push({
        code: 'exit_beats_only',
        severity: 'soft',
        message: '出口只有拍数条件，无法表达剧情收束',
        scene_ord: sceneOrd
      })
    }

    scene.beats.forEach((beat, beatIndex) => {
      totalBeats += 1
      const beatOrd = beat.ord ?? beatIndex + 1
      if (beat.speaker_type === 'character' && !scene.participants.includes(beat.speaker_id)) {
        conflicts.push({
          code: 'speaker_not_in_participants',
          severity: 'hard',
          message: `角色 ${beat.speaker_id} 不在本场在场者中`,
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

      const card = beat.speaker_type === 'character' ? options.characters?.get(beat.speaker_id) : undefined
      if (card) {
        const intent = beat.intent
        const tabooHit = splitTerms(card.taboo).find((term) => intent.includes(term))
        if (tabooHit) {
          conflicts.push({
            code: 'intent_violates_taboo',
            severity: 'soft',
            message: `意图触及角色禁忌「${tabooHit}」`,
            scene_ord: sceneOrd,
            beat_ord: beatOrd
          })
        }
        const bannedHit = splitTerms(card.bannedWords).find((term) => intent.includes(term))
        if (bannedHit) {
          conflicts.push({
            code: 'intent_uses_banned_words',
            severity: 'soft',
            message: `意图使用了角色禁用词「${bannedHit}」`,
            scene_ord: sceneOrd,
            beat_ord: beatOrd
          })
        }
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
