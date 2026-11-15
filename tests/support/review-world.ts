import { commitBeat } from '../../src/main/doc/commit-beat'
import { markChapterComplete } from '../../src/main/scheduler/loop'
import { ReviewService } from '../../src/main/review/service'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { SettingsSchema } from '../../src/shared/schema/project'
import type { ReviewEvent, ReviewState } from '../../src/shared/schema/review'
import { openWriteWorld, type WriteTestWorld } from './write-world'

/**
 * 审批台的测试世界：在创作台世界上补「4 拍确认 + draft_complete」。
 *
 * 走真实原语（commitBeat → markChapterComplete），所以审批台的 revision、
 * 清单、hash 与生产路径一致；只有模型是假的（NORYTH_REVIEW_FAKE=1）。
 */

export interface ReviewTestWorld {
  world: WriteTestWorld
  service: ReviewService
  events: ReviewEvent[]
  state: () => ReviewState
}

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const GATE_SECRET = 'integration-review-gate'

/** 与 review.devSeed 相同的确定性台词：假模型从中取 evidence / patch before。 */
export const REVIEW_LINES = [
  '她把茶盏往他那边推了推，声音压得很低：「我爹书房里那只黑漆匣子，你见过没有？」',
  '他知道那匣子里装着什么，却只低头拨了拨灯芯，说：「没见过。」',
  '她把他的沉默当成回答：「账本在祠堂。」',
  '窗外的雨忽然大了，瓦上像有人在数拍子。'
]

export function fillConfirmedBeats(world: WriteTestWorld, lines: readonly string[] = REVIEW_LINES): void {
  const project = world.repos.project.get()!
  const beats = world.repos.beat.listLiveByChapter(world.chapterId)
  for (const [index, beat] of beats.entries()) {
    const chapter = world.repos.chapter.get(world.chapterId)!
    commitBeat(world.handle.db, world.repos, {
      chapterId: world.chapterId,
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: lines[index % lines.length]!,
      intent: beat.intent,
      supersedesId: beat.id,
      status: 'confirmed',
      maxWords: beat.maxWords,
      createdBy: 'doc_controller'
    })
  }
  markChapterComplete(world.handle.db, world.repos, world.repos.chapter.get(world.chapterId)!)
}

export function openReviewWorld(
  options: { lines?: readonly string[]; env?: NodeJS.ProcessEnv } = {}
): ReviewTestWorld {
  const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 4 })
  fillConfirmedBeats(world, options.lines)
  const events: ReviewEvent[] = []
  const service = new ReviewService({
    host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    gateSecret: GATE_SECRET,
    send: (event) => events.push(event),
    fakeChunkDelayMs: 0,
    env: options.env ?? { NORYTH_REVIEW_FAKE: '1' }
  })
  return {
    world,
    service,
    events,
    state: () => service.state(world.chapterId)
  }
}
