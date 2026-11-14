import { AppError } from '../../shared/domain/app-error'
import type { GroundingItem } from '../../shared/schema/envelope'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord, BeatStatus, DecidedBy } from '../db/repos/beat'
import { recomputeCoveredUntilSeq } from '../db/seq'
import { withTransaction } from '../db/tx'
import { commitBeat, type CommitBeatResult } from './commit-beat'

/**
 * 拍的显式状态迁移（PRD §6.5 / PHASE-05 V2）。
 *
 * 规则：正文只能由 commitBeat 写；本文件的 confirm / stale 只改状态，
 * regenerate 只是「标记 + 失败回滚」，真正的新版本仍走 commitBeat。
 * 阶段 07 的调度器复用这些原语，不另写一套状态表。
 */

const REGENERATABLE: readonly BeatStatus[] = [
  'waiting_for_human',
  'draft',
  'rejected',
  'interrupted',
  'author_edited'
]

export interface GenerateMark {
  beatId: string
  previousStatus: BeatStatus
  /** true = 已有正文，按重生成处理（regenerating）；false = 首生成（generating）。 */
  replacing: boolean
}

/** 生成开始：占住槽位状态，失败时用 rollbackGenerate 恢复。 */
export function markGenerating(repos: Repos, beatId: string): GenerateMark {
  const beat = repos.beat.get(beatId)
  if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
  if (beat.status === 'generating' || beat.status === 'regenerating') {
    throw new AppError('invalid_args', '本拍正在生成', { beatId, status: beat.status })
  }
  if (beat.status === 'confirmed' || beat.status === 'superseded' || beat.status === 'stale') {
    throw new AppError('invalid_args', '当前状态的拍不能重新生成', { beatId, status: beat.status })
  }
  if (beat.body.trim().length > 0 && !REGENERATABLE.includes(beat.status) && beat.status !== 'proposed') {
    throw new AppError('invalid_args', '当前状态的拍不能重新生成', { beatId, status: beat.status })
  }
  const replacing = beat.body.trim().length > 0
  repos.beat.setStatus(beatId, replacing ? 'regenerating' : 'generating')
  return { beatId, previousStatus: beat.status, replacing }
}

export function rollbackGenerate(repos: Repos, mark: GenerateMark): void {
  const current = repos.beat.get(mark.beatId)
  if (!current || current.status === 'superseded') return
  if (current.status !== 'generating' && current.status !== 'regenerating') return
  repos.beat.setStatus(mark.beatId, mark.previousStatus)
}

export function rejectBeat(repos: Repos, beatId: string, mark: GenerateMark | null): void {
  const current = repos.beat.get(beatId)
  if (!current || current.status === 'superseded') return
  if (current.body.trim().length > 0) {
    // 重生成失败：旧正文仍然有效，回到原状态并保留拒绝原因在 job.error_code。
    if (mark) rollbackGenerate(repos, mark)
    return
  }
  repos.beat.setStatus(beatId, 'rejected')
}

export interface ConfirmBeatResult {
  beatId: string
  status: BeatStatus
  coveredUntilSeq: number
  /** 被标 stale 的后续拍（DEV-PLAN §9.4）。 */
  staled: string[]
}

/**
 * 作者确认：waiting_for_human → confirmed（或 auto → confirmed，decided_by=auto）。
 * 确认不产生新 revision——正文没有变化，只推进状态与知识边界。
 */
export function confirmBeat(db: Db, repos: Repos, beatId: string, decidedBy: DecidedBy = 'author'): ConfirmBeatResult {
  return withTransaction(db, () => {
    const beat = repos.beat.get(beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
    if (beat.status === 'confirmed' || beat.status === 'author_edited') {
      return {
        beatId,
        status: beat.status,
        coveredUntilSeq: repos.chapter.get(beat.chapterId)?.coveredUntilSeq ?? 0,
        staled: []
      }
    }
    if (beat.status !== 'waiting_for_human' && beat.status !== 'draft') {
      throw new AppError('invalid_args', '当前状态的拍不能确认', { beatId, status: beat.status })
    }
    if (beat.body.trim().length === 0) {
      throw new AppError('invalid_args', '空拍不能确认', { beatId })
    }
    repos.beat.setStatus(beatId, 'confirmed', decidedBy)
    const covered = recomputeCoveredUntilSeq(db, beat.chapterId)
    return { beatId, status: 'confirmed', coveredUntilSeq: covered, staled: [] }
  })
}

/**
 * 作者直接编辑（PRD §4.5 第 9 步 / DEV-PLAN §9.4）：
 * 新版本走 commitBeat，旧拍 superseded，author_edited=1；后续 confirmed 拍标 stale。
 */
export function editBeat(
  db: Db,
  repos: Repos,
  input: {
    beatId: string
    body: string
    expectedRevision: string | null
    epoch?: number
    now?: string
  }
): { commit: CommitBeatResult; staled: string[] } {
  return withTransaction(db, () => {
    const beat = repos.beat.get(input.beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${input.beatId} not found`)
    if (beat.status === 'superseded') {
      throw new AppError('invalid_args', '已替换的拍不能编辑', { beatId: input.beatId })
    }
    if (beat.body.trim().length === 0) {
      throw new AppError('invalid_args', '空拍没有可编辑的正文', { beatId: input.beatId })
    }
    const project = repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const body = input.body.trim()
    if (body.length === 0) throw new AppError('schema_invalid', '编辑后的正文为空', { beatId: input.beatId })

    const commit = commitBeat(db, repos, {
      chapterId: beat.chapterId,
      expectedRevision: input.expectedRevision,
      epoch: input.epoch ?? project.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body,
      intent: beat.intent,
      grounding: parseGrounding(beat.groundingJson),
      traceRef: beat.traceRef,
      supersedesId: beat.id,
      status: 'author_edited',
      maxWords: beat.maxWords,
      authorEdited: true,
      createdBy: 'author',
      ...(input.now === undefined ? {} : { now: input.now })
    })

    const staled = markLaterBeatsStale(db, repos, beat)
    return { commit, staled }
  })
}

/** 同章内 (sceneOrd, beatOrd) 大于当前拍的 confirmed 拍 → stale（M0 不跨章）。 */
export function markLaterBeatsStale(db: Db, repos: Repos, anchor: BeatRecord): string[] {
  const scenes = repos.scene.listByChapter(anchor.chapterId)
  const ordOf = new Map(scenes.map((entry) => [entry.scene.id, entry.chapterOrd]))
  const anchorOrd = ordOf.get(anchor.sceneId) ?? 0
  const staled: string[] = []
  for (const beat of repos.beat.listLiveByChapter(anchor.chapterId)) {
    if (beat.id === anchor.id) continue
    // PRD §6.5：author_edited 视同 confirmed，同样可被上游改动标 stale。
    if (beat.status !== 'confirmed' && beat.status !== 'author_edited') continue
    const sceneOrd = ordOf.get(beat.sceneId) ?? 0
    const later = sceneOrd > anchorOrd || (sceneOrd === anchorOrd && beat.ord > anchor.ord)
    if (!later) continue
    repos.beat.setStatus(beat.id, 'stale')
    staled.push(beat.id)
  }
  if (staled.length > 0) recomputeCoveredUntilSeq(db, anchor.chapterId)
  return staled
}

/** beat.grounding_json → GroundingItem[]；坏数据按空列表处理，不抛错。 */
export function parseGrounding(json: string): GroundingItem[] {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is GroundingItem =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { type?: unknown }).type === 'string' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { quote?: unknown }).quote === 'string'
    )
  } catch {
    return []
  }
}
