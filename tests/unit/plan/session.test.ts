import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../../../src/main/tools/registry'
import { ALL_MANIFESTS } from '../../../src/main/tools/manifests'
import { PlanService, type PlanHost } from '../../../src/main/plan/service'
import type { PlannerModel } from '../../../src/main/plan/model'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../../../src/main/model/adapter'
import { ModelError } from '../../../src/main/model/adapter'
import { SettingsSchema } from '../../../src/shared/schema/project'
import type { ResolvedBinding } from '../../../src/main/model/bindings'
import { openPlanWorld } from '../../support/plan-world'

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(10)
  }
  throw new Error('waitFor timeout')
}

class SlowAdapter implements ChatAdapter {
  readonly provider = 'deepseek'
  readonly model = 'deepseek-flash'

  constructor(private readonly delayMs = 20) {}

  async probe() {
    return {
      stream: true,
      tools: true,
      jsonMode: true,
      contextWindow: 64_000,
      maxOutput: 4_096,
      pricing: { in: 0, out: 0 }
    }
  }

  async stream(request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    const chunks = ['第一段。', '第二段。', '第三段。']
    let full = ''
    for (const chunk of chunks) {
      if (request.signal?.aborted) throw new ModelError('model_error', 'aborted', { aborted: true })
      full += chunk
      hooks.onText?.(chunk, full)
      await sleep(this.delayMs)
    }
    return {
      text: full,
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 30 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: this.delayMs * chunks.length,
      firstTokenMs: this.delayMs,
      retries: 0
    }
  }
}

const binding: ResolvedBinding = {
  agentKey: 'planner',
  provider: 'deepseek',
  model: 'deepseek-flash',
  params: {},
  version: 0,
  source: 'preset'
}

function serviceFor(host: PlanHost, adapter: ChatAdapter, ready = true): PlanService {
  const model: PlannerModel = {
    binding,
    adapter,
    status: { provider: 'deepseek', model: 'deepseek-flash', label: '测试', ready }
  }
  return new PlanService({
    host: () => host,
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    emit: () => {},
    emitChoice: () => {},
    model: () => model
  })
}

describe('规划会话', () => {
  it('停止保留已生成文本；重试复用同一条回复，不产生孤儿消息', async () => {
    const w = openPlanWorld()
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    try {
      const service = serviceFor(host, new SlowAdapter(20))
      const session = service.createSession({})
      const sent = service.send({ sessionId: session.id, text: '写一个民国悬疑' })

      await waitFor(() => w.repos.planMessage.get(sent.assistantMessageId)!.body.length > 0)
      expect(service.stop({ sessionId: session.id }).stopped).toBe(true)
      await waitFor(() => w.repos.planMessage.get(sent.assistantMessageId)!.status === 'stopped')

      const stopped = w.repos.planMessage.get(sent.assistantMessageId)!
      expect(stopped.body.length).toBeGreaterThan(0)
      expect(stopped.status).toBe('stopped')
      expect(w.repos.planMessage.countBySession(session.id)).toBe(2)
      expect(w.repos.outline.listByProject(w.projectId)).toHaveLength(0)
      expect(w.repos.planCharacter.listByProject(w.projectId)).toHaveLength(0)

      service.retry({ messageId: stopped.id })
      await waitFor(() => w.repos.planMessage.get(stopped.id)!.status === 'done')
      const retried = w.repos.planMessage.get(stopped.id)!
      expect(retried.id).toBe(stopped.id)
      expect(retried.attempt).toBe(2)
      expect(retried.body).toBe('第一段。第二段。第三段。')
      expect(w.repos.planMessage.countBySession(session.id)).toBe(2)
    } finally {
      w.cleanup()
    }
  })

  it('模型未配置时消息标 failed，并给出 model_auth', async () => {
    const w = openPlanWorld()
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    try {
      const service = serviceFor(host, new SlowAdapter(1), false)
      const session = service.createSession({})
      const sent = service.send({ sessionId: session.id, text: '你好' })
      await waitFor(() => w.repos.planMessage.get(sent.assistantMessageId)!.status === 'failed')
      const failed = w.repos.planMessage.get(sent.assistantMessageId)!
      expect(JSON.parse(failed.metaJson).error_code).toBe('model_auth')
    } finally {
      w.cleanup()
    }
  })

  it('只读项目拒绝发送；会话状态可恢复', () => {
    const w = openPlanWorld()
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: true }
    try {
      const service = serviceFor(host, new SlowAdapter(1))
      const session = w.repos.planSession.insert({ projectId: w.projectId, title: '规划 · 第 1 次' })
      let code = ''
      try {
        service.send({ sessionId: session.id, text: '写一个故事' })
      } catch (error) {
        code = (error as { code?: string }).code ?? ''
      }
      expect(code).toBe('project_locked')
    } finally {
      w.cleanup()
    }
  })

  it('G1 已锁蓝图但建库未完成：getState 修正为 failed 并给出重试路径', () => {
    const w = openPlanWorld()
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    try {
      w.repos.project.lockBlueprint(w.projectId)
      expect(w.repos.project.get()!.setupState).toBe('pending')
      const service = serviceFor(host, new SlowAdapter(1))
      const state = service.getState()
      expect(state.setupState).toBe('failed')
      expect(state.g1.locked).toBe(true)
      expect(w.repos.project.get()!.setupState).toBe('failed')
    } finally {
      w.cleanup()
    }
  })
})
