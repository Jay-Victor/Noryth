import { afterEach, describe, expect, it } from 'vitest'
import { SettingsSchema, type Settings } from '../../../src/shared/schema/project'
import { CapabilitiesSchema } from '../../../src/shared/schema/model'
import { resolveHeteroReview, secondProviderOf } from '../../../src/main/review/hetero'
import { openReviewWorld, type ReviewTestWorld } from '../../support/review-world'

/**
 * 异构复检（PHASE-16 §5.3 / M1-22）：
 *   - off：永远用配置的 reviewer 绑定；
 *   - prefer + 审批与生成同家 + 已验证第二家：自动改用第二家，报告记录 provider；
 *   - prefer + 无第二家：报告标 degraded=hetero_unavailable，照常产出、不阻断；
 *   - 生成已是别家：不切换。
 */

const worlds: Array<{ world: ReviewTestWorld['world']; service: ReviewTestWorld['service'] }> = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.world.cleanup()
})

function capabilities() {
  return CapabilitiesSchema.parse({
    stream: true,
    tools: true,
    jsonMode: true,
    contextWindow: 128_000,
    maxOutput: 16_384,
    pricing: { in: 1, out: 2 }
  })
}

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return SettingsSchema.parse({
    review: { hetero: 'prefer' },
    providers: {
      openai: {
        baseUrl: null,
        model: 'gpt-4.1-mini',
        capabilities: capabilities(),
        checkedAt: '2026-11-16T00:00:00.000Z'
      }
    },
    ...patch
  })
}

function open(settings: Settings): ReviewTestWorld {
  const created = openReviewWorld({ settings })
  worlds.push({ world: created.world, service: created.service })
  return created
}

describe('resolveHeteroReview', () => {
  it('off：使用 reviewer 绑定，不标记降级', () => {
    const w = open(SettingsSchema.parse({}))
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const resolution = resolveHeteroReview({
      repos: w.world.repos,
      project,
      chapter,
      settings: SettingsSchema.parse({}),
      providerReady: () => true
    })
    expect(resolution.provider).toBe('deepseek')
    expect(resolution.switched).toBe(false)
    expect(resolution.degraded).toBeNull()
  })

  it('prefer + 同家 + 已验证第二家：切到第二家，记录 generationProvider', () => {
    const w = open(settingsWith())
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const resolution = resolveHeteroReview({
      repos: w.world.repos,
      project,
      chapter,
      settings: settingsWith(),
      providerReady: () => true
    })
    expect(resolution.reviewerBinding.provider).toBe('deepseek')
    expect(resolution.generationProvider).toBe('deepseek')
    expect(resolution.switched).toBe(true)
    expect(resolution.provider).toBe('openai')
    expect(resolution.model).toBe('gpt-4.1-mini')
    expect(resolution.degraded).toBeNull()
  })

  it('prefer + 无第二家：degraded=hetero_unavailable，保留原绑定', () => {
    const w = open(settingsWith())
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const settings = SettingsSchema.parse({ review: { hetero: 'prefer' } })
    const resolution = resolveHeteroReview({
      repos: w.world.repos,
      project,
      chapter,
      settings,
      providerReady: () => true
    })
    expect(resolution.switched).toBe(false)
    expect(resolution.provider).toBe('deepseek')
    expect(resolution.degraded).toBe('hetero_unavailable')
  })

  it('生成已是另一家：不切换，也不降级', () => {
    const w = open(settingsWith())
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const beat = w.world.repos.beat.listLiveByChapter(w.world.chapterId)[0]!
    w.world.repos.turnMetric.insert({
      turnId: 'turn_test_1',
      projectId: w.world.projectId,
      jobId: 'job_test_1',
      beatId: beat.id,
      chapterId: w.world.chapterId,
      agentKey: 'narrator',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      bindingVersion: 1,
      tokensIn: 10,
      tokensOut: 10,
      costCny: null,
      latencyMs: 10,
      firstTokenMs: 10,
      contextJson: '{}'
    })
    const resolution = resolveHeteroReview({
      repos: w.world.repos,
      project,
      chapter,
      settings: settingsWith(),
      providerReady: () => true
    })
    expect(resolution.generationProvider).toBe('openai')
    expect(resolution.switched).toBe(false)
    expect(resolution.provider).toBe('deepseek')
    expect(resolution.degraded).toBeNull()
  })

  it('secondProviderOf：停用 / 未测试 / 无 Key 的提供方都不算第二家', () => {
    const settings = settingsWith()
    expect(secondProviderOf(settings, 'deepseek', () => true)?.provider).toBe('openai')
    expect(secondProviderOf(settings, 'deepseek', () => false)).toBeNull()
    const disabled = SettingsSchema.parse({
      ...settings,
      providersEnabled: { openai: false }
    })
    expect(secondProviderOf(disabled, 'deepseek', () => true)).toBeNull()
    const untested = SettingsSchema.parse({ review: { hetero: 'prefer' } })
    expect(secondProviderOf(untested, 'deepseek', () => true)).toBeNull()
  })

  it('路由优先级：异构第二家不健康时，备用家不能等于生成家', () => {
    const w = open(settingsWith())
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const base = {
      repos: w.world.repos,
      project,
      chapter,
      settings: settingsWith(),
      providerReady: () => true
    }

    // 第二家 openai 不健康；备用家 tongyi 不是生成家 deepseek → 用 tongyi。
    const routed = resolveHeteroReview({
      ...base,
      fallback: { preset: 'tongyi', model: 'qwen-plus' },
      usable: (provider) => provider !== 'openai'
    })
    expect(routed.provider).toBe('tongyi')
    expect(routed.switched).toBe(true)
    expect(routed.routing?.reason).toBe('hetero_second_unhealthy')
    expect(routed.generationProvider).toBe('deepseek')
    expect(routed.degraded).toBeNull()

    // 备用家就是生成家 → 不切换，宁可 hetero_unavailable。
    const refused = resolveHeteroReview({
      ...base,
      fallback: { preset: 'deepseek', model: 'deepseek-flash' },
      usable: (provider) => provider !== 'openai'
    })
    expect(refused.provider).toBe('deepseek')
    expect(refused.switched).toBe(false)
    expect(refused.degraded).toBe('hetero_unavailable')
    expect(refused.routing).toBeNull()
  })

  it('异构关闭时仍可按路由备用家切换 reviewer', () => {
    const w = open(SettingsSchema.parse({}))
    const project = w.world.repos.project.get()!
    const chapter = w.world.repos.chapter.get(w.world.chapterId)!
    const resolution = resolveHeteroReview({
      repos: w.world.repos,
      project,
      chapter,
      settings: SettingsSchema.parse({ routing: { enabled: true } }),
      providerReady: () => true,
      fallback: { preset: 'tongyi', model: 'qwen-plus' },
      usable: (provider) => provider !== 'deepseek'
    })
    expect(resolution.provider).toBe('tongyi')
    expect(resolution.switched).toBe(true)
    expect(resolution.routing?.reason).toBe('primary_unhealthy')
    expect(resolution.degraded).toBeNull()
  })
})

describe('ReviewService 异构复检', () => {
  it('prefer 自动换第二家：报告 provider=openai，model 记录第二家', async () => {
    const w = open(settingsWith())
    await w.service.run(w.world.chapterId)
    const state = w.service.state(w.world.chapterId)
    expect(state.report?.provider).toBe('openai')
    expect(state.report?.model).toBe('gpt-4.1-mini')
    expect(state.report?.degraded).not.toBe('hetero_unavailable')
  })

  it('prefer 无第二家：报告照常产出，degraded=hetero_unavailable', async () => {
    const w = open(SettingsSchema.parse({ review: { hetero: 'prefer' } }))
    await w.service.run(w.world.chapterId)
    const state = w.service.state(w.world.chapterId)
    expect(state.report).not.toBeNull()
    expect(state.report?.degraded).toBe('hetero_unavailable')
    expect(state.report?.provider).toBe('deepseek')
  })
})
