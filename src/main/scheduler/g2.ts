import { AppError } from '../../shared/domain/app-error'
import { firstConflictReason, hasHardConflict, type StoryboardConflict } from '../../shared/schema/storyboard'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { readStoryboardDraft, materializeStoryboard, validateChapterStoryboard } from './storyboard'
import { chapterTransition } from './transitions'

/**
 * G2（每章开演前的闸门，PRD §2.3 / PHASE-07 F1）。
 *
 * 闸门只做两件事：确认「冲突 0」与「作者看过场次/拍数/预估」，然后把草案
 * 物化成 scene/beat。闸门记录写 `gate_record`（decision=approve），entitiy 是章。
 */

export interface G2Preview {
  chapterId: string
  ready: boolean
  /** 第一条硬冲突原因；按钮 tooltip 与横幅共用。 */
  blocker: string | null
  conflicts: StoryboardConflict[]
  sceneCount: number
  beatCount: number
  storyboardRev: number | null
  /** 预算与估算在自动模式预检里给；G2 只给结构摘要。 */
  maxBeats: number
}

export interface G2Result {
  chapterId: string
  chapterStatus: string
  gateId: string
  sceneCount: number
  beatCount: number
  revisionId: string
  storyboardRev: number
}

function sumMaxBeats(scenes: readonly { max_beats?: number }[]): number {
  return scenes.reduce((sum, scene) => sum + (scene.max_beats ?? 40), 0)
}

export function previewG2(repos: Repos, chapterId: string): G2Preview {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const draft = readStoryboardDraft(repos, chapterId)
  const conflicts = validateChapterStoryboard(repos, chapterId)
  const gating: StoryboardConflict[] = [...conflicts]
  if (project.blueprintLockedAt === null) {
    gating.unshift({ code: 'blueprint_not_locked', severity: 'hard', message: '蓝图未过 G1，不能开演', scene_ord: 0 })
  }
  if (project.setupState !== 'complete') {
    gating.unshift({ code: 'setup_incomplete', severity: 'hard', message: 'setup_incomplete：角色库未建好', scene_ord: 0 })
  }

  return {
    chapterId,
    ready: !hasHardConflict(gating),
    blocker: firstConflictReason(gating),
    conflicts: gating,
    sceneCount: draft?.scenes.length ?? 0,
    beatCount: draft?.scenes.reduce((sum, scene) => sum + scene.beats.length, 0) ?? 0,
    storyboardRev: draft?.rev ?? null,
    maxBeats: sumMaxBeats(draft?.scenes ?? [])
  }
}

export function confirmG2(
  db: Db,
  repos: Repos,
  input: { chapterId: string; actor?: string }
): G2Result {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')
  if (project.blueprintLockedAt === null) {
    throw new AppError('invalid_args', '蓝图未过 G1，不能开演', { chapterId: chapter.id })
  }
  if (project.setupState !== 'complete') {
    throw new AppError('setup_incomplete', '角色库未建好，不能开演', { chapterId: chapter.id })
  }
  const draft = readStoryboardDraft(repos, chapter.id)
  if (!draft) throw new AppError('invalid_args', '本章还没有分镜草案', { chapterId: chapter.id })
  const conflicts = validateChapterStoryboard(repos, chapter.id)
  if (hasHardConflict(conflicts)) {
    throw new AppError('invalid_args', `分镜有硬冲突：${firstConflictReason(conflicts) ?? '未知'}`, {
      chapterId: chapter.id,
      conflicts: conflicts.filter((conflict) => conflict.severity === 'hard')
    })
  }

  const materialized = materializeStoryboard(db, repos, {
    chapterId: chapter.id,
    scenes: draft.scenes,
    actor: input.actor ?? 'author'
  })

  let status = chapter.status
  if (status === 'planned') {
    status = chapterTransition(status, 'STORYBOARD_READY')
    repos.chapter.setStatus(chapter.id, status)
  }

  const gate = repos.gate.insert({
    projectId: project.id,
    gateId: 'G2',
    entityType: 'chapter',
    entityId: chapter.id,
    decision: 'approve',
    actor: input.actor ?? 'author',
    payloadJson: JSON.stringify({
      scene_count: materialized.sceneCount,
      beat_count: materialized.beatCount,
      storyboard_rev: draft.rev,
      revision_id: materialized.revisionId,
      content_hash: materialized.contentHash
    })
  })

  return {
    chapterId: chapter.id,
    chapterStatus: status,
    gateId: gate.id,
    sceneCount: materialized.sceneCount,
    beatCount: materialized.beatCount,
    revisionId: materialized.revisionId,
    storyboardRev: draft.rev
  }
}
