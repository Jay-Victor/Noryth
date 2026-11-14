import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTurnJob } from '../../src/main/agents/job'
import { runTurn, type TurnCommitInput, type TurnCommitResult } from '../../src/main/agents/turn'
import { confirmBeat } from '../../src/main/doc/beats'
import { commitBeat } from '../../src/main/doc/commit-beat'
import { writeTurnTrace } from '../../src/main/doc/trace'
import { verifyDatabase } from '../../src/main/db/verify'
import { recomputeRevisionHash } from '../../src/main/db/revision'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { createFakeSliceAdapter, type FakeSliceModelAdapter } from '../fixtures/slice/fake-adapter'
import { openSliceWorld, sliceFixture, type SliceTestWorld } from '../support/slice-world'

/**
 * 阶段 05 集成验收：假模型 + 真实装配/校验/commitBeat。
 *
 * 断言的是链路，不是文案：两个拍各产生一个 revision；grounding 必须来自
 * 本轮工具返回；伪造引用被拒绝且不落正文；重生成 supersede 旧版本。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const GATE_SECRET = 'slice-secret'
const AT = '2026-01-01T00:00:00.000Z'

const worlds: SliceTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): SliceTestWorld {
  const created = openSliceWorld()
  worlds.push(created)
  return created
}

function adapter(options: { forceInvalidGrounding?: boolean } = {}): FakeSliceModelAdapter {
  return createFakeSliceAdapter({
    fixture: sliceFixture,
    chunkDelayMs: 0,
    ...(options.forceInvalidGrounding === undefined
      ? {}
      : { forceInvalidGrounding: options.forceInvalidGrounding })
  })
}

/** 生产路径同款：trace 先归档，再由 commitBeat 写正文。 */
function committer(w: SliceTestWorld) {
  return (input: TurnCommitInput): TurnCommitResult => {
    const beat = w.repos.beat.get(input.beatId)!
    const traceRef = writeTurnTrace({
      projectDir: w.dir,
      jobId: input.jobId,
      turnId: input.turnId,
      beatId: input.beatId,
      envelope: input.envelope,
      context: input.context.bundle,
      binding: input.binding,
      recordedAt: AT
    })
    const committed = commitBeat(w.handle.db, w.repos, {
      chapterId: input.chapterId,
      expectedRevision: input.expectedRevision,
      epoch: input.epoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: input.envelope.body,
      intent: beat.intent,
      grounding: input.envelope.grounding,
      traceRef,
      supersedesId: input.supersedesId,
      status: 'draft',
      maxWords: beat.maxWords,
      createdBy: 'doc_controller'
    })
    return {
      beatId: committed.beatId,
      revisionId: committed.revisionId,
      seq: committed.seq,
      contentHash: committed.contentHash,
      mirrorHash: committed.mirrorHash,
      traceRef
    }
  }
}

async function runBeat(
  w: SliceTestWorld,
  model: FakeSliceModelAdapter,
  beatId: string,
  attempt: string
) {
  const beat = w.repos.beat.get(beatId)!
  const actor = beat.speakerType === 'character' ? (`character:${beat.speakerId}` as const) : 'narrator'
  const { job } = createTurnJob(
    w.repos,
    registry,
    {
      chapterId: w.chapterId,
      beatId,
      actor,
      mode: 'interactive',
      at: AT,
      supersedesId: beatId,
      attempt
    },
    { capabilitiesLookup: () => model.capabilities() }
  )
  const result = await runTurn(
    {
      repos: w.repos,
      registry,
      adapter: model,
      gateSecret: GATE_SECRET,
      commit: committer(w)
    },
    { job }
  )
  return { job, result }
}

describe('切片：一拍跑到落盘', () => {
  async function generateFirstBeat(w: SliceTestWorld, model: FakeSliceModelAdapter): Promise<void> {
    const first = await runBeat(w, model, w.beatIds[0]!, `b1-${model.completionsOf(sliceFixture.beats[0]!.intent)}`)
    expect(first.result.status, JSON.stringify(first.result.rejection)).toBe('validated')
    w.repos.beat.setStatus(first.result.commit!.beatId, 'waiting_for_human')
    confirmBeat(w.handle.db, w.repos, first.result.commit!.beatId)
  }

  it('两拍各生成一个 revision；grounding 来自本轮工具返回；trace 落盘不含正文', async () => {
    const w = world()
    const model = adapter()

    await generateFirstBeat(w, model)

    const second = await runBeat(w, model, w.beatIds[1]!, 'a2')
    expect(second.result.status, JSON.stringify(second.result.rejection)).toBe('validated')
    expect(second.result.toolCalls).toBe(1)
    expect(second.result.envelope?.speaker).toEqual({ type: 'character', id: 'chr_lin' })
    expect(second.result.envelope?.grounding).toEqual([
      {
        type: 'memory',
        id: 'mem_slice_lin_1',
        quote: '父亲书房有一只上锁的黑漆匣子'
      }
    ])
    expect(model.completionsOf(sliceFixture.beats[0]!.intent)).toBe(1)
    expect(model.completionsOf(sliceFixture.beats[1]!.intent)).toBe(1)

    // 基线 + 两拍 = 3 个 revision；每次清单 2 行，hash 可复算。
    const revisions = w.repos.revision.listByChapter(w.chapterId)
    expect(revisions).toHaveLength(3)
    for (const revision of revisions) {
      expect(w.repos.revision.countMembers(revision.id)).toBe(2)
      expect(recomputeRevisionHash(w.handle.db, revision.id)).toBe(revision.contentHash)
    }
    expect(w.repos.beat.listByChapter(w.chapterId).filter((beat) => beat.status === 'superseded')).toHaveLength(2)

    const traceRef = w.repos.beat.get(second.result.commit!.beatId)!.traceRef!
    expect(traceRef.startsWith('logs/trace/')).toBe(true)
    const traceFile = join(w.dir, traceRef)
    expect(existsSync(traceFile)).toBe(true)
    const document = JSON.parse(readFileSync(traceFile, 'utf8')) as Record<string, unknown>
    expect(document['turn_id']).toBe(second.result.turnId)
    expect(document['body']).toBeUndefined()
    expect(Array.isArray(document['trace'])).toBe(true)

    const report = verifyDatabase(w.handle.db, { projectDir: w.dir, checkMirror: false })
    expect(report.ok, JSON.stringify(report.issues)).toBe(true)
  })

  it('伪造 grounding → 重试一次仍失败 → rejected，不写正文、不产生 revision', async () => {
    const w = world()
    await generateFirstBeat(w, adapter())
    const model = adapter({ forceInvalidGrounding: true })
    const revisionsBefore = w.repos.revision.listByChapter(w.chapterId).length

    const outcome = await runBeat(w, model, w.beatIds[1]!, 'forged')

    expect(outcome.result.status).toBe('rejected')
    expect(outcome.result.envelope).toBeNull()
    expect(outcome.result.commit).toBeNull()
    expect(outcome.result.rejection?.code).toBe('grounding_not_returned')
    expect(outcome.result.attempts).toBe(2)
    expect(w.repos.job.get(outcome.job.id)!.status).toBe('failed')
    expect(w.repos.job.get(outcome.job.id)!.errorCode).toBe('grounding_not_returned')
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisionsBefore)
    expect(w.repos.beat.get(w.beatIds[1]!)!.status).toBe('proposed')
    expect(w.repos.beat.get(w.beatIds[1]!)!.body).toBe('')
  })

  it('重生成：supersede 旧拍、正文换版本、revision 再 +1', async () => {
    const w = world()
    const model = adapter()
    await generateFirstBeat(w, model)

    const first = await runBeat(w, model, w.beatIds[1]!, 'g1')
    expect(first.result.status).toBe('validated')
    const original = first.result.commit!.beatId
    expect(w.repos.beat.get(original)!.body).toBe(sliceFixture.fakeModel.beats[1]!.bodies[0])
    w.repos.beat.setStatus(original, 'waiting_for_human')

    const revisionsBefore = w.repos.revision.listByChapter(w.chapterId).length
    const again = await runBeat(w, model, original, 'g2')
    expect(again.result.status, JSON.stringify(again.result.rejection)).toBe('validated')
    expect(again.result.commit!.beatId).not.toBe(original)
    expect(w.repos.beat.get(original)!.status).toBe('superseded')
    expect(w.repos.beat.get(again.result.commit!.beatId)!.body).toBe(
      sliceFixture.fakeModel.beats[1]!.bodies[1]
    )
    expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(revisionsBefore + 1)
    expect(w.repos.revision.countMembers(again.result.commit!.revisionId)).toBe(2)
    expect(recomputeRevisionHash(w.handle.db, again.result.commit!.revisionId)).toBe(
      again.result.commit!.contentHash
    )
  })
})
