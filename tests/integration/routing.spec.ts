import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../../src/shared/schema/model'
import { CapabilitiesSchema } from '../../src/shared/schema/model'
import { SettingsSchema, type Settings } from '../../src/shared/schema/project'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../../src/main/model/adapter'
import { ModelError } from '../../src/main/model/adapter'
import { createRoutingRuntime } from '../../src/main/model/router'
import { FakeWriteModelAdapter } from '../../src/main/scheduler/fake-adapter'
import { runBeatTurn } from '../../src/main/scheduler/beat'
import { commitBeat } from '../../src/main/doc/commit-beat'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { openWriteWorld, type WriteTestWorld } from '../support/write-world'

/**
 * 路由落在真实写拍路径上（PHASE-21 §5.5）。
 *
 * 适配器按 provider 注入：主家抛 429，备用用假适配器成功。
 * 断言「当前拍不中途换模型」「下一拍才切」「job 快照仍是主家」「turn_metric 记实际家」。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-11-21T00:00:00.000Z' })

function capabilities(): Capabilities {
  return CapabilitiesSchema.parse({
    stream: true,
    tools: true,
    jsonMode: true,
    contextWindow: 64_000,
    maxOutput: 8_192,
    pricing: { in: 2, out: 8 }
  })
}

function settingsWithRouting(): Settings {
  return SettingsSchema.parse({
    routing: {
      enabled: true,
      fallbackOn: ['rate_limit', 'server', 'timeout'],
      cooldownMs: 60_000,
      agents: { narrator: { preset: 'openai', model: 'gpt-4.1-mini' } }
    },
    providers: {
      openai: {
        baseUrl: null,
        model: 'gpt-4.1-mini',
        capabilities: capabilities(),
        checkedAt: '2026-11-21T00:00:00.000Z'
      }
    }
  })
}

class FailingAdapter implements ChatAdapter {
  readonly provider: string
  readonly model: string
  calls = 0
  private readonly code: 'rate_limit' | 'model_auth' | 'model_error'

  constructor(provider: string, model: string, code: 'rate_limit' | 'model_auth' | 'model_error') {
    this.provider = provider
    this.model = model
    this.code = code
  }

  async probe(): Promise<Capabilities> {
    return capabilities()
  }

  async stream(_request: ChatRequest, _hooks: StreamHooks): Promise<ChatResult> {
    this.calls += 1
    const status = this.code === 'rate_limit' ? 429 : this.code === 'model_auth' ? 401 : 500
    throw new ModelError(this.code, `injected ${this.code}`, { status, retryable: true })
  }
}

interface Harness {
  world: WriteTestWorld
  settings: Settings
  adapters: FailingAdapter[]
  fakeCount: number
  run: (beatId: string, attempt: string) => ReturnType<typeof runBeatTurn>
  cleanup: () => void
}

function harness(code: 'rate_limit' | 'model_auth' | 'model_error', failFallback = false): Harness {
  const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
  const settings = settingsWithRouting()
  const adapters: FailingAdapter[] = []
  const state = { fakeCount: 0 }

  const adapterFor = (binding: { provider: string; model: string }): ChatAdapter => {
    if (binding.provider === 'deepseek' || failFallback) {
      const adapter = new FailingAdapter(binding.provider, binding.model, code)
      adapters.push(adapter)
      return adapter
    }
    state.fakeCount += 1
    return new FakeWriteModelAdapter({ provider: binding.provider, model: binding.model, chunkDelayMs: 0 })
  }

  const routing = createRoutingRuntime({
    getSettings: () => settings,
    providerReady: () => true
  })

  return {
    world,
    settings,
    adapters,
    get fakeCount() {
      return state.fakeCount
    },
    run: (beatId, attempt) =>
      runBeatTurn(
        {
          host: { dir: world.dir, db: world.handle.db, repos: world.repos },
          registry,
          adapterFor,
          gateSecret: 'integration-routing-gate',
          mode: 'interactive',
          attempt,
          routing
        },
        { beat: world.repos.beat.get(beatId)!, chapter: world.repos.chapter.get(world.chapterId)! }
      ),
    cleanup: () => world.cleanup()
  }
}

function confirmFirstBeat(world: WriteTestWorld): { body: string; revisionId: string | null } {
  const project = world.repos.project.get()!
  const chapter = world.repos.chapter.get(world.chapterId)!
  const beat = world.repos.beat.get(world.beatIds[0]!)!
  commitBeat(world.handle.db, world.repos, {
    chapterId: chapter.id,
    expectedRevision: chapter.currentRevisionId,
    epoch: project.writeEpoch,
    sceneId: beat.sceneId,
    ord: beat.ord,
    speakerType: beat.speakerType,
    speakerId: beat.speakerId,
    body: '已确认的原句：茶盏在灯下泛着一层薄光。',
    intent: beat.intent,
    supersedesId: beat.id,
    status: 'confirmed',
    maxWords: beat.maxWords,
    createdBy: 'doc_controller'
  })
  const confirmed = world.repos.beat.get(beat.id)!
  return {
    body: confirmed.body,
    revisionId: world.repos.chapter.get(chapter.id)!.currentRevisionId
  }
}

describe('写拍路由（PHASE-21）', () => {
  it('429：当前拍不换模型、暂停；下一拍用备用并逐拍留痕', async () => {
    const h = harness('rate_limit')
    try {
      const before = confirmFirstBeat(h.world)
      const target = h.world.beatIds[1]!

      await expect(h.run(target, 'a1')).rejects.toMatchObject({ code: 'rate_limit' })
      expect(h.adapters).toHaveLength(1)
      expect(h.adapters[0]!.provider).toBe('deepseek')
      expect(h.fakeCount).toBe(0)
      expect(h.world.repos.beat.get(target)!.body).toBe('')

      const outcome = await h.run(target, 'a2')
      expect(outcome.status).toBe('committed')
      expect(h.adapters).toHaveLength(1) // 第一拍没有偷偷再打主家
      expect(h.fakeCount).toBe(1)
      expect(h.world.repos.beat.get(outcome.beatId!)!.body.length).toBeGreaterThan(0)

      const metric = h.world.repos.turnMetric.latestByBeat(target)!
      expect(metric.provider).toBe('openai')
      expect(metric.model).toBe('gpt-4.1-mini')
      const context = JSON.parse(metric.contextJson) as { routing?: Record<string, unknown> }
      expect(context.routing).toMatchObject({
        from: 'deepseek',
        to: 'openai',
        reason: 'primary_unhealthy',
        error: 'rate_limit'
      })

      // job 快照仍是初始绑定；实际调用以 turn_metric 为准。
      const job = h.world.repos.job.listRecent(h.world.projectId, 5).find((entry) => entry.id === outcome.jobId)!
      const payload = JSON.parse(job.payloadJson) as {
        bindings: { bindings: Record<string, { provider: string }> }
      }
      expect(payload.bindings.bindings.narrator!.provider).toBe('deepseek')

      // 已确认拍逐字不变。
      const after = confirmFirstBeatBody(h.world)
      expect(after.body).toBe(before.body)
    } finally {
      h.cleanup()
    }
  })

  it('401 不切换：两次都打主家，健康状态不变', async () => {
    const h = harness('model_auth')
    try {
      const target = h.world.beatIds[1]!
      await expect(h.run(target, 'b1')).rejects.toMatchObject({ code: 'model_auth' })
      await expect(h.run(target, 'b2')).rejects.toMatchObject({ code: 'model_auth' })
      expect(h.adapters.every((adapter) => adapter.provider === 'deepseek')).toBe(true)
      expect(h.adapters).toHaveLength(2)
      expect(h.fakeCount).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  it('两家都失败：第三次直接 routing_exhausted，不无限重试', async () => {
    const h = harness('model_error', true)
    try {
      const target = h.world.beatIds[1]!
      await expect(h.run(target, 'c1')).rejects.toMatchObject({ code: 'model_error' })
      await expect(h.run(target, 'c2')).rejects.toMatchObject({ code: 'model_error' })
      expect(h.adapters.map((adapter) => adapter.provider)).toEqual(['deepseek', 'openai'])
      const callsBefore = h.adapters.reduce((sum, adapter) => sum + adapter.calls, 0)

      await expect(h.run(target, 'c3')).rejects.toMatchObject({ code: 'routing_exhausted' })
      const callsAfter = h.adapters.reduce((sum, adapter) => sum + adapter.calls, 0)
      expect(callsAfter).toBe(callsBefore)
    } finally {
      h.cleanup()
    }
  })
})

function confirmFirstBeatBody(world: WriteTestWorld): { body: string; revisionId: string | null } {
  const beat = world.repos.beat.get(world.beatIds[0]!)!
  return {
    body: beat.body,
    revisionId: world.repos.chapter.get(world.chapterId)!.currentRevisionId
  }
}
