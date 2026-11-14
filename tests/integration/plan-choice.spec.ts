import { afterEach, describe, expect, it } from 'vitest'
import { PlanService, type PlanHost } from '../../src/main/plan/service'
import type { PlannerModel } from '../../src/main/plan/model'
import type { ChatAdapter, ChatRequest, ChatResult, StreamHooks } from '../../src/main/model/adapter'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { SettingsSchema } from '../../src/shared/schema/project'
import type { ResolvedBinding } from '../../src/main/model/bindings'
import type { PlanChoiceRequest } from '../../src/shared/schema/plan'
import { openPlanWorld, type PlanTestWorld } from '../support/plan-world'

/** T42：规划 Agent 在会话中向作者要选择，选择结果进入工具结果并继续本轮。 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const binding: ResolvedBinding = {
  agentKey: 'planner',
  provider: 'deepseek',
  model: 'deepseek-flash',
  params: {},
  version: 0,
  source: 'preset'
}

class ChoiceAdapter implements ChatAdapter {
  readonly provider = 'deepseek'
  readonly model = 'deepseek-flash'
  private round = 0

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

  async stream(_request: ChatRequest, hooks: StreamHooks): Promise<ChatResult> {
    this.round += 1
    if (this.round === 1) {
      return {
        text: '',
        reasoning: '',
        toolCalls: [
          {
            id: 'call_choice',
            name: 'author.request_choice',
            arguments: JSON.stringify({
              question: '先写哪条线？',
              options: [
                { id: 'main', label: '主线：黑漆匣子' },
                { id: 'side', label: '支线：穆掌柜' }
              ]
            })
          }
        ],
        usage: { promptTokens: 100, completionTokens: 20 },
        finishReason: 'tool_calls',
        model: this.model,
        latencyMs: 1,
        firstTokenMs: 1,
        retries: 0
      }
    }
    const text = '按你选的主线推进；我先写一章的骨架。'
    hooks.onText?.(text, text)
    return {
      text,
      reasoning: '',
      toolCalls: [],
      usage: { promptTokens: 120, completionTokens: 30 },
      finishReason: 'stop',
      model: this.model,
      latencyMs: 1,
      firstTokenMs: 1,
      retries: 0
    }
  }
}

const worlds: PlanTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(10)
  }
  throw new Error('waitFor timeout')
}

describe('规划对话的作者选择', () => {
  it('T42 发出选择请求，作者选择后继续并记录审计', async () => {
    const w = openPlanWorld()
    worlds.push(w)
    const choices: PlanChoiceRequest[] = []
    const model: PlannerModel = {
      binding,
      adapter: new ChoiceAdapter(),
      status: { provider: 'deepseek', model: 'deepseek-flash', label: '测试', ready: true }
    }
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    const service = new PlanService({
      host: () => host,
      registry,
      settings: () => SettingsSchema.parse({}),
      allowFakeModel: true,
      emit: () => {},
      emitChoice: (event) => choices.push(event),
      model: () => model
    })

    try {
      const session = service.createSession({})
      const sent = service.send({ sessionId: session.id, text: '先写哪条线？' })
      await waitFor(() => choices.length === 1)
      const request = choices[0]!
      expect(request.question).toBe('先写哪条线？')
      expect(request.options).toHaveLength(2)

      service.choose({ choiceId: request.choiceId, optionId: 'main' })
      await waitFor(() => w.repos.planMessage.get(sent.assistantMessageId)!.status === 'done')

      const message = w.repos.planMessage.get(sent.assistantMessageId)!
      expect(message.body).toContain('主线')
      const audit = w.repos.toolCall.listByTurn(`pturn_${sent.assistantMessageId}`)
      expect(audit.some((row) => row.tool === 'author.request_choice' && row.status === 'ok')).toBe(true)
    } finally {
      w.cleanup()
      worlds.length = 0
    }
  })
})
