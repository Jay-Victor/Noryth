import { afterEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../../src/shared/schema/project'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { WriteService } from '../../src/main/scheduler/service'
import { saveStoryboardDraft } from '../../src/main/scheduler/storyboard'
import { confirmG2 } from '../../src/main/scheduler/g2'
import { verifyDatabase } from '../../src/main/db/verify'
import { chapterBudget, decideNext } from '../../src/main/scheduler/loop'
import type { WriteEvent } from '../../src/shared/schema/write'
import { openWriteWorld, type WriteWorldOptions, type WriteTestWorld } from '../support/write-world'

/**
 * 阶段 07 集成验收（PHASE-07 §6）：
 * - 3 场 24 拍：前 6 拍 4 确认 2 重生成，跑完 draft_complete；
 * - 自动模式在出口条件处停，不超 max_beats；
 * - 拒演 / 预算 / 模型错误各自暂停，理由保留；
 * - 全程无孤儿、无双活、verify 全绿。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const worlds: WriteTestWorld[] = []
const GATE_SECRET = 'integration-gate'

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

interface Harness {
  world: WriteTestWorld
  service: WriteService
  events: WriteEvent[]
}

function harness(options: WriteWorldOptions = {}, env: NodeJS.ProcessEnv = { NORYTH_WRITE_FAKE: '1' }): Harness {
  const world = openWriteWorld(options)
  worlds.push(world)
  const events: WriteEvent[] = []
  const service = new WriteService({
    host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    gateSecret: GATE_SECRET,
    send: (event) => events.push(event),
    fakeChunkDelayMs: 0,
    env
  })
  return { world, service, events }
}

function decideNextKind(world: WriteTestWorld, chapter: Parameters<typeof decideNext>[1]) {
  return decideNext(world.repos, chapter, { auto: false, budget: chapterBudget(world.repos, chapter) }).kind
}

function liveBeats(world: WriteTestWorld) {
  return world.repos.beat.listLiveByChapter(world.chapterId)
}

function assertNoOrphans(world: WriteTestWorld): void {
  const report = verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
  expect(report.ok, JSON.stringify(report.issues)).toBe(true)
  expect(report.issues.map((issue) => issue.code)).not.toContain('double_live_beat')
  const orphans = world.handle.db
    .prepare(
      `SELECT COUNT(*) AS count FROM revision_beat rb LEFT JOIN beat b ON b.id = rb.beat_id WHERE b.id IS NULL`
    )
    .get() as { count: number }
  expect(orphans.count).toBe(0)
}

describe('E2E-WRITE-01（集成）：3 场 24 拍跑到 draft_complete', () => {
  it('前 6 拍 4 确认 2 重生成，自动模式跑完，全程无孤儿', async () => {
    const { world, service, events } = harness({
      sceneCount: 3,
      beatsPerScene: 8,
      exit: 'all(fact("black_box","location"), beats(8))'
    })
    expect(liveBeats(world)).toHaveLength(24)

    const beats = liveBeats(world)
    const plan = [
      { beat: beats[0]!, regenerate: 0 },
      { beat: beats[1]!, regenerate: 1 },
      { beat: beats[2]!, regenerate: 0 },
      { beat: beats[3]!, regenerate: 3 },
      { beat: beats[4]!, regenerate: 0 },
      { beat: beats[5]!, regenerate: 0 }
    ]

    for (const step of plan) {
      const generated = await service.generate(step.beat.id)
      expect(generated.state.chapterStatus, JSON.stringify(generated.state.pauseReason)).toBe('drafting')
      let currentId = generated.state.currentBeatId!
      for (let index = 0; index < step.regenerate; index += 1) {
        const again = await service.regenerate(currentId)
        currentId = again.state.currentBeatId!
      }
      const confirmed = service.confirm(currentId)
      expect(confirmed.state.progress.confirmed).toBeGreaterThan(0)
    }

    expect(service.state().progress.confirmed).toBe(6)
    expect(world.repos.beat.listByChapter(world.chapterId).filter((beat) => beat.status === 'superseded')).toHaveLength(10) // 6 个分镜占位 + 4 次重生成

    const auto = await service.autoStart(world.chapterId)
    expect(auto.state.chapterStatus).toBe('draft_complete')
    expect(auto.state.progress.scenesClosed).toBe(3)
    for (const scene of auto.state.scenes) {
      expect(scene.status).toBe('closed')
      expect(scene.confirmed).toBe(8)
    }

    // 24 拍各一版 + 4 次重生成 + G2 基线
    const revisions = world.repos.revision.listByChapter(world.chapterId)
    expect(revisions).toHaveLength(24 + 4 + 1)
    for (const revision of world.repos.revision.listByChapter(world.chapterId).slice(-1)) {
      expect(world.repos.revision.countMembers(revision.id)).toBe(24)
    }
    assertNoOrphans(world)
    expect(events.some((event) => event.phase === 'committed')).toBe(true)
    expect(events.some((event) => event.phase === 'delta' && event.beatId.length > 0)).toBe(true)
    // 自动模式跳过了 G3：没有 waiting_for_human 的拍
    expect(liveBeats(world).filter((beat) => beat.status === 'waiting_for_human')).toHaveLength(0)
  }, 120_000)
})

describe('E2E-WRITE-02（集成）：自动模式收束', () => {
  it('出口满足即停，不把剩余拍写下去', async () => {
    const { service, world } = harness({
      sceneCount: 2,
      beatsPerScene: 6,
      exit: 'all(fact("black_box","location"), beats(3))'
    })
    const result = await service.autoStart(world.chapterId)
    expect(result.state.chapterStatus).toBe('draft_complete')
    expect(result.state.progress.confirmed).toBe(6) // 2 场 × 3 拍
    const remaining = liveBeats(world).filter((beat) => beat.status === 'proposed')
    expect(remaining).toHaveLength(6)
    assertNoOrphans(world)
  }, 120_000)

  it('max_beats 到顶就收束并留 WARN', async () => {
    const { service, world } = harness({
      sceneCount: 1,
      beatsPerScene: 6,
      exit: 'all(fact("black_box","location"), beats(9))'
    })
    world.repos.scene.update(world.sceneIds[0]!, { maxBeats: 2 })
    const result = await service.autoStart(world.chapterId)
    expect(result.state.chapterStatus).toBe('draft_complete')
    expect(result.state.progress.confirmed).toBe(2)
    const events = world.repos.schedulerEvent.listByChapter(world.chapterId)
    const closed = events.find((event) => event.kind === 'scene_closed')
    expect(closed?.reason).toBe('max_beats')
    expect(closed?.payloadJson).toContain('exit_conditions_unsatisfied')
  }, 120_000)
})

describe('F4：编辑已确认拍与三选一', () => {
  it('下游标 stale；默认开新分支保留旧文；仅替换与重跑后续各走一条路径', async () => {
    const { service, world } = harness({ sceneCount: 1, beatsPerScene: 4, exit: 'all(fact("black_box","location"), beats(4))' })
    const first = liveBeats(world)[0]!
    await service.generate(first.id)
    let state = service.state()
    const firstCommitted = state.currentBeatId!
    service.confirm(firstCommitted)

    const second = liveBeats(world).find((beat) => beat.ord === 2)!
    await service.generate(second.id)
    state = service.state()
    service.confirm(state.currentBeatId!)

    const edited = service.edit({
      beatId: firstCommitted,
      body: '她把话咽了回去，只把茶盏推远了一点。',
      expectedRevision: service.state().revisionId
    })
    const downstream = edited.state.scenes[0]!.beats.find((beat) => beat.ord === 2)!
    expect(downstream.status).toBe('stale')
    expect(edited.detail).toContain('开新分支')

    const branch = service.resolveStale({ chapterId: world.chapterId, beatId: firstCommitted, choice: 'branch' })
    expect(branch.detail).toContain('开新分支')
    expect(branch.state.scenes[0]!.beats.find((beat) => beat.ord === 2)!.status).toBe('stale')

    const replace = service.resolveStale({ chapterId: world.chapterId, beatId: firstCommitted, choice: 'replace' })
    expect(replace.state.scenes[0]!.beats.find((beat) => beat.ord === 2)!.status).toBe('confirmed')

    // 再改一次（编辑会产生新版本，旧版本已 superseded）→ 重新变 stale；这次选择重跑后续
    const currentFirst = replace.state.scenes[0]!.beats.find((beat) => beat.ord === 1)!.id
    service.edit({
      beatId: currentFirst,
      body: '她把话咽了回去，茶盏在桌上转了一圈。',
      expectedRevision: service.state().revisionId
    })
    const rerun = service.resolveStale({ chapterId: world.chapterId, beatId: currentFirst, choice: 'rerun' })
    expect(rerun.state.scenes[0]!.beats.find((beat) => beat.ord === 2)!.status).toBe('interrupted')

    const chapter = world.repos.chapter.get(world.chapterId)!
    expect(decideNextKind(world, chapter)).toBe('beat')
  })
})

describe('F7：分镜耗尽', () => {
  it('自动模式标 storyboard_exhausted，不即兴续写', async () => {
    const { service, world } = harness({
      sceneCount: 1,
      beatsPerScene: 2,
      exit: 'all(fact("black_box","location"), beats(5))'
    })
    const result = await service.autoStart(world.chapterId)
    expect(result.state.pauseReason).toBe('storyboard_exhausted')
    expect(result.state.progress.confirmed).toBe(2)
    expect(liveBeats(world)).toHaveLength(2)
    expect(liveBeats(world).every((beat) => beat.status === 'confirmed')).toBe(true)
    expect(result.state.events.some((event) => event.reason === 'storyboard_exhausted')).toBe(true)
  }, 60_000)
})

describe('F7：四类暂停原因可见且可恢复', () => {
  it('角色拒演：暂停保留理由，不写正文、不提供强制继续', async () => {
    const { service, world } = harness({ sceneCount: 1, beatsPerScene: 1 })
    saveStoryboardDraft(world.repos, {
      chapterId: world.chapterId,
      scenes: [
        {
          location: '祠堂',
          participants: world.characterIds,
          goal: '摊牌',
          exit: 'all(fact("black_box","location"), beats(1))',
          max_beats: 4,
          beats: [{ speaker_type: 'character', speaker_id: world.characterIds[0]!, intent: '拒演：她不会承认知道账本' }]
        }
      ],
      updatedBy: 'author'
    })
    confirmG2(world.handle.db, world.repos, { chapterId: world.chapterId })
    const beat = liveBeats(world)[0]!

    const result = await service.generate(beat.id)
    expect(result.state.pauseReason).toBe('character_refusal')
    expect(result.detail).toContain('账本')
    const after = world.repos.beat.get(beat.id)!
    expect(after.body).toBe('')
    expect(world.repos.writeMessage.listByChapter(world.chapterId).some((message) => message.kind === 'refusal')).toBe(true)
    // 不提供「强制继续」：恢复后仍是这一拍待生成
    expect(world.repos.beat.get(beat.id)!.status).toBe('proposed')
  })

  it('预算用尽：自动模式在拍边界暂停', async () => {
    const { service, world } = harness({ sceneCount: 1, beatsPerScene: 4, budgetTokens: 1_000 })
    const result = await service.autoStart(world.chapterId)
    expect(result.state.pauseReason).toBe('budget_exceeded')
    expect(result.state.progress.confirmed).toBe(1)
    expect(result.state.autoPaused).toBe(true)
    const paused = world.repos.schedulerEvent.listByChapter(world.chapterId).filter((event) => event.kind === 'paused')
    expect(paused.at(-1)?.reason).toBe('budget_exceeded')
  }, 120_000)

  it('模型错误（没有 Key）：自动模式暂停并标 model_error', async () => {
    const { service, world } = harness({ sceneCount: 1, beatsPerScene: 2 }, {})
    const result = await service.autoStart(world.chapterId)
    expect(result.state.pauseReason).toBe('model_error')
    expect(result.state.progress.confirmed).toBe(0)
    expect(liveBeats(world)[0]!.status).toBe('proposed')
    expect(world.repos.beat.listLiveByChapter(world.chapterId).some((beat) => beat.body.length > 0)).toBe(false)
  }, 60_000)
})
