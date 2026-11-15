import { AppError } from '../../../shared/domain/app-error'
import type { WriteTimeline } from '../../../shared/schema/write'
import type { Repos } from '../../db/repos'

/**
 * 时间三轴查询（T23 `timeline.query` / PHASE-12 §5.2）。
 *
 * 三条轴分开返回，不合成一个 `story_time`：
 * - `story_start` / `story_end`：故事内时间，自由文本，M1 只展示不比较；
 * - `idx`：叙事顺序，取 `chapter.ord`（不新增列）；
 * - `timeline`：main | flashback | dream，按 `beat.seq` 返回每拍的 story_time 与所属时间轴。
 *
 * 故事时间先后只在 main 场景内有意义；flashback / dream 永不参与比较，
 * 所以这里不做任何「时间早于前章」的判定（那会把闪回误报成时间线矛盾）。
 */
export interface TimelineQueryInput {
  projectId: string
  chapterId: string
  /** 叙事序水位；省略 = 不限（作者视角）。 */
  asOf?: number
}

export function queryTimeline(repos: Repos, input: TimelineQueryInput): WriteTimeline {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter || chapter.projectId !== input.projectId) {
    throw new AppError('invalid_args', 'chapter not in project', { chapterId: input.chapterId })
  }
  if (input.asOf !== undefined && input.asOf > chapter.coveredUntilSeq) {
    // 不返回未来拍：水位之外一律拒绝，而不是裁剪成「看起来正确」的答案。
    throw new AppError('stale_revision', `as_of ${input.asOf} 超过本章水位 ${chapter.coveredUntilSeq}`, {
      chapterId: chapter.id,
      asOf: input.asOf,
      coveredUntilSeq: chapter.coveredUntilSeq
    })
  }

  const scenes = repos.scene.listByChapter(chapter.id)
  const sceneById = new Map(scenes.map((entry) => [entry.scene.id, entry]))
  const firstMain = scenes.find((entry) => entry.scene.timeline === 'main' && entry.scene.storyStart !== null)

  const timeline = repos.beat
    .listLiveByChapter(chapter.id)
    .filter((beat) => beat.seq !== null)
    .filter((beat) => input.asOf === undefined || (beat.seq as number) <= input.asOf)
    .sort((left, right) => (left.seq as number) - (right.seq as number))
    .map((beat) => {
      const entry = sceneById.get(beat.sceneId)
      return {
        seq: beat.seq as number,
        storyTime: entry?.scene.storyStart ?? null,
        timeline: entry?.scene.timeline ?? ('main' as const)
      }
    })

  return {
    chapterId: chapter.id,
    idx: chapter.ord,
    storyStart: firstMain?.scene.storyStart ?? null,
    storyEnd: firstMain?.scene.storyEnd ?? null,
    scenes: scenes.map((entry) => ({
      sceneId: entry.scene.id,
      ord: entry.chapterOrd,
      timeline: entry.scene.timeline,
      storyStart: entry.scene.storyStart,
      storyEnd: entry.scene.storyEnd
    })),
    timeline
  }
}
