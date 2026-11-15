import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { ALL_MANIFESTS } from '../../../src/main/tools/manifests'
import { queryTimeline } from '../../../src/main/tools/support/timeline'
import { openTestDb } from '../db/support/db'
import { seedFixture } from '../db/support/fixture'
import { tempDir } from '../helpers'

/**
 * T23 `timeline.query`（PHASE-12 §5.2 / §6 验收 5–6）：
 * - 三轴分开返回：story_start/end、idx、timeline（按 beat.seq）；
 * - 闪回只换标签，不参与故事时间先后判定；
 * - as_of 不越章水位：超过 covered_until_seq → stale_revision。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-timeline-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed }
}

describe('timeline.query（T23）', () => {
  it('三轴分开：idx 取章序，story_start/end 取第一个 main 场景，timeline 按 seq 返回', () => {
    const { handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const [first, second] = seed.chapters[0]!.sceneIds
    handle.repos.scene.update(first!, { storyStart: '民国二十三年 三月初七 夜', storyEnd: '三月初八 凌晨' })
    handle.repos.scene.update(second!, { storyStart: '三月初八 午后' })

    const view = queryTimeline(handle.repos, { projectId: seed.projectId, chapterId })
    expect(view.idx).toBe(1)
    expect(view.storyStart).toBe('民国二十三年 三月初七 夜')
    expect(view.storyEnd).toBe('三月初八 凌晨')
    expect(view.scenes).toHaveLength(3)
    expect(view.scenes[0]).toMatchObject({ ord: 1, timeline: 'main', storyStart: '民国二十三年 三月初七 夜' })

    // 24 拍按 seq 排序，故事时间取所属场景；seq 是全书统一的叙事序。
    expect(view.timeline).toHaveLength(24)
    expect(view.timeline.map((row) => row.seq)).toEqual([...view.timeline.map((row) => row.seq)].sort((a, b) => a - b))
    expect(view.timeline[0]!.storyTime).toBe('民国二十三年 三月初七 夜')
    expect(view.timeline.at(-1)!.storyTime).toBe(null)
    expect(view.timeline.every((row) => row.timeline === 'main')).toBe(true)
  })

  it('闪回：章 3 的时间早于章 1 也只换标签，不产生时间线错误', () => {
    const { handle, seed } = setup()
    const chapterOne = seed.chapterIds[0]!
    const chapterTwo = seed.chapterIds[1]!
    handle.repos.scene.update(seed.chapters[0]!.sceneIds[0]!, { storyStart: '民国二十三年 三月初七 夜' })
    // 第 2 章整章闪回，故事时间比第 1 章更早。
    for (const sceneId of seed.chapters[1]!.sceneIds) {
      handle.repos.scene.update(sceneId, { storyStart: '民国二十年 冬', timeline: 'flashback' })
    }

    const first = queryTimeline(handle.repos, { projectId: seed.projectId, chapterId: chapterOne })
    const second = queryTimeline(handle.repos, { projectId: seed.projectId, chapterId: chapterTwo })
    expect(first.idx).toBe(1)
    expect(second.idx).toBe(2)
    expect(second.storyStart).toBeNull() // 章内没有 main 场景
    expect(second.scenes.every((scene) => scene.timeline === 'flashback')).toBe(true)
    expect(second.timeline.every((row) => row.timeline === 'flashback')).toBe(true)
    expect(second.timeline.every((row) => row.storyTime === '民国二十年 冬')).toBe(true)
    // 叙事序仍然按章递增：闪回不参与先后判定。
    expect(second.timeline[0]!.seq).toBeGreaterThan(first.timeline[0]!.seq)
  })

  it('as_of 超过章水位 → stale_revision，不返回未来拍', () => {
    const { handle, seed } = setup()
    const chapterId = seed.chapterIds[1]!
    // fixture 的章没有 covered_until_seq，水位是 0。
    expect(handle.repos.chapter.get(chapterId)!.coveredUntilSeq).toBe(0)
    let error: unknown = null
    try {
      queryTimeline(handle.repos, { projectId: seed.projectId, chapterId, asOf: 1 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('stale_revision')

    // 水位以内：返回 seq ≤ as_of 的拍。
    const view = queryTimeline(handle.repos, { projectId: seed.projectId, chapterId, asOf: 0 })
    expect(view.timeline).toEqual([])
  })

  it('审批的确定性检查不因闪回报时间线：consistency.check 只比叙事序', async () => {
    const { handle, seed } = setup()
    const chapterTwo = seed.chapterIds[1]!
    handle.repos.scene.update(seed.chapters[0]!.sceneIds[0]!, { storyStart: '民国二十三年 三月初七 夜' })
    for (const sceneId of seed.chapters[1]!.sceneIds) {
      handle.repos.scene.update(sceneId, { storyStart: '民国二十年 冬', timeline: 'flashback' })
    }
    const revisionId = handle.repos.chapter.get(chapterTwo)!.currentRevisionId!
    const tool = ALL_MANIFESTS.find((item) => item.name === 'consistency.check')!
    const payload = await tool.handler(
      { revision_id: revisionId },
      { runtime: { project_id: seed.projectId } } as never,
      { repos: handle.repos } as never
    )
    const issues = (payload.data as { issues: Array<{ code: string }> }).issues
    expect(issues.some((issue) => issue.code === 'timeline_non_monotonic')).toBe(false)
  })

  it('别的项目的章按 invalid_args 拒绝', () => {
    const { handle, seed } = setup()
    expect(() => queryTimeline(handle.repos, { projectId: 'prj_other', chapterId: seed.chapterIds[0]! })).toThrowError(
      /not in project/
    )
  })
})
