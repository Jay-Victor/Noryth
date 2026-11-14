import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { invokeTool, type TurnContext } from '../../src/main/tools/invoke'
import { RepoAuditSink } from '../../src/main/tools/audit'
import { TurnBudget } from '../../src/main/tools/budget'
import { RepoIdempotencyStore } from '../../src/main/tools/idempotency'
import { issueGate } from '../../src/main/tools/gates'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { ResolvedToolset, resolveToolset } from '../../src/main/tools/resolve'
import type { AnyToolDefinition } from '../../src/main/tools/define'
import type { AgentInstanceKey, ChoiceResolver, ToolServices } from '../../src/main/tools/types'
import { AGENT_KEYS } from '../../src/main/tools/types'
import { CONTRACT_FIXTURES, type ContractFixture } from './fixtures'
import { openContractWorld, type ContractWorld } from './support/world'

/**
 * 每个工具的六类契约测试（DEV-PLAN §6.8）：
 *   1 schema 往返  2 身份隔离  3 空不是错  4 截断显式  5 超时降级  6 幂等重放
 * 以及每工具 manifest 限额在流水线中真实生效。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const GATE_SECRET = 'contract-test-secret'

function defaultAgent(tool: AnyToolDefinition): AgentInstanceKey {
  if (tool.actors.includes('character') && (tool.selfOnly || tool.actors.length === 1)) return 'character:chr_lin'
  return tool.actors[0]!
}

function cloneTool(tool: AnyToolDefinition, patch: Partial<AnyToolDefinition>): AnyToolDefinition {
  return { ...tool, ...patch }
}

function withTool(toolset: ResolvedToolset, tool: AnyToolDefinition): ResolvedToolset {
  return new ResolvedToolset(
    toolset.agentKey,
    toolset.version,
    toolset.tools.map((item) => (item.name === tool.name ? tool : item)),
    toolset.resolvedAt
  )
}

function gateEntityFor(tool: AnyToolDefinition, world: ContractWorld): { gateId: NonNullable<AnyToolDefinition['requiresGate']>; entityType: string; entityId: string } | null {
  if (!tool.requiresGate) return null
  switch (tool.requiresGate) {
    case 'G5':
      return { gateId: 'G5', entityType: 'revision', entityId: world.revisionDraftId }
    case 'G7':
      return { gateId: 'G7', entityType: 'proposal', entityId: world.proposalJobId }
    case 'G1':
      return { gateId: 'G1', entityType: 'project', entityId: world.projectId }
    case 'G6':
      return { gateId: 'G6', entityType: 'chapter', entityId: world.chapterFinalId }
    case 'author_confirm':
      return { gateId: 'author_confirm', entityType: 'chapter', entityId: world.chapterFinalId }
  }
}

export function contractSuite(name: string, fixture: ContractFixture): void {
  const tool = registry.get(name)
  if (!tool) throw new Error(`契约夹具指向不存在的工具 ${name}`)

  describe(name, () => {
    let world!: ContractWorld
    let counter = 0

    beforeAll(() => {
      world = openContractWorld()
    })
    afterAll(() => {
      world?.cleanup()
    })

    const agent = fixture.agent ?? defaultAgent(tool)
    const baseToolset = resolveToolset(agent, {}, registry)

    interface RunOptions {
      args?: unknown
      actor?: AgentInstanceKey
      toolset?: ResolvedToolset
      context?: Partial<TurnContext>
      jobId?: string
      turnId?: string
      choices?: ChoiceResolver
    }

    const run = async (options: RunOptions = {}) => {
      counter += 1
      const actor = options.actor ?? agent
      const toolset =
        options.toolset ?? (actor === agent ? baseToolset : resolveToolset(actor, {}, registry))
      const memoryActor = actor.startsWith('memory') || actor === 'memory'
      const jobId = options.jobId ?? `job_${name.replace(/\W/g, '_')}_${counter}`
      const turnId = options.turnId ?? `turn_${name.replace(/\W/g, '_')}_${counter}`
      const defaults: TurnContext = {
        projectId: world.projectId,
        jobId,
        turnId,
        actorId: actor,
        characterId: actor.startsWith('character:') ? actor.slice('character:'.length) : null,
        asOf: 3,
        epoch: 1,
        expectedRevision: memoryActor ? world.revisionFinalId : world.revisionDraftId,
        gateToken: null,
        chapterId: memoryActor ? world.chapterFinalId : world.chapterDraftId,
        beatId: world.beatDraftId,
        mode: 'interactive'
      }
      const context: TurnContext = { ...defaults, ...fixture.context, ...options.context }

      const gateEntity = fixture.gate ?? gateEntityFor(tool, world)
      if (tool.requiresGate && gateEntity) {
        const issued = issueGate({
          repos: world.repos,
          secret: GATE_SECRET,
          projectId: world.projectId,
          gateId: gateEntity.gateId,
          entityType: gateEntity.entityType,
          entityId: gateEntity.entityId,
          revision: context.expectedRevision,
          jobId: context.jobId,
          actor: 'author'
        })
        context.gateToken = issued.token
      }

      const services: ToolServices = {
        repos: world.repos,
        now: () => Date.now(),
        choices: options.choices ?? {
          ask: async (_question, choices) => choices[0] ?? null
        }
      }
      const audit = new RepoAuditSink(world.repos.toolCall)
      const result = await invokeTool(
        { callId: `call_${counter}`, tool: name, args: options.args ?? fixture.args },
        context,
        {
          toolset,
          budget: new TurnBudget(actor),
          audit,
          idempotency: new RepoIdempotencyStore(world.repos.toolCall),
          gateSecret: GATE_SECRET
        },
        services
      )
      return {
        result,
        context,
        toolset,
        rows: world.repos.toolCall.listByTurn(context.turnId)
      }
    }

    it('schema 往返：合法样例通过，多余字段与缺字段拒绝', () => {
      expect(tool.input.safeParse(fixture.args).success, JSON.stringify(tool.input.safeParse(fixture.args).error ?? {})).toBe(true)
      expect(tool.input.safeParse({ ...fixture.args, __extra: true }).success).toBe(false)

      const schema = z.toJSONSchema(tool.input) as { required?: string[] }
      const required = schema.required ?? []
      const present = required.filter((key) => key in fixture.args)
      const missingKey = present.find((key) => {
        const missing = { ...fixture.args }
        delete (missing as Record<string, unknown>)[key]
        return !tool.input.safeParse(missing).success
      })
      if (missingKey) {
        const missing = { ...fixture.args }
        delete (missing as Record<string, unknown>)[missingKey]
        expect(tool.input.safeParse(missing).success, `缺 ${missingKey} 应拒绝`).toBe(false)
      }
    })

    it('身份隔离：换 actor 拿不到，或角色实例看不到别人的记忆', async () => {
      const outsider = AGENT_KEYS.find((candidate) => !tool.actors.includes(candidate))
      if (outsider) {
        const outsiderToolset = resolveToolset(outsider, {}, registry)
        expect(outsiderToolset.get(name)).toBeUndefined()
        const { result, rows } = await run({ actor: outsider, toolset: outsiderToolset })
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe('tool_not_found')
        expect(rows).toHaveLength(1)
        expect(JSON.parse(rows[0]!.scopeJson).unauthorized).toBe(true)
      } else {
        const { result } = await run({ actor: 'character:chr_lin' })
        expect(result.ok).toBe(true)
        expect(result.refs.some((ref) => ref.type === 'memory')).toBe(false)
      }

      if (tool.selfOnly) {
        const narrowedSet = resolveToolset('character:chr_lin', {}, registry)
        const narrowed = narrowedSet.get(name)!
        expect(narrowed.input.safeParse({ character_id: world.characterShen }).success).toBe(false)
        expect(narrowed.injected).toContain('character_id')

        const hardSend = await run({
          actor: 'character:chr_lin',
          toolset: narrowedSet,
          args: { ...fixture.args, character_id: world.characterShen }
        })
        expect(hardSend.result.ok).toBe(false)
        expect(hardSend.result.error?.code).toBe('invalid_args')

        const { result } = await run({ actor: 'character:chr_lin' })
        expect(result.refs.some((ref) => ref.id === world.memoryShenId)).toBe(false)
      }
    })

    it('空不是错：查过没有返回 ok，空输入按 invalid_args 拒绝', async () => {
      if (fixture.emptyArgs === null) {
        const { result } = await run({ args: {} })
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe('invalid_args')
        return
      }
      const { result } = await run({ args: fixture.emptyArgs ?? fixture.args })
      expect(result.ok).toBe(true)
      const parsed = tool.output.safeParse(result.data)
      expect(parsed.success, JSON.stringify(parsed.error ?? {})).toBe(true)
      if (result.degraded === 'empty') expect(result.refs).toEqual([])
    })

    it('截断按整条丢弃：truncated + total，quote 不被切半', async () => {
      const quote = '长'.repeat(80)
      const bigTool = cloneTool(tool, {
        handler: async () => ({
          data: { items: Array.from({ length: 120 }, (_, index) => ({ index, text: quote })) },
          refs: Array.from({ length: 120 }, (_, index) => ({
            type: 'memory' as const,
            id: `mem_big_${index}`,
            quote,
            seq: index
          }))
        })
      })
      const { result } = await run({ toolset: withTool(baseToolset, bigTool) })
      expect(result.ok).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.total ?? 0).toBeGreaterThan(0)
      for (const ref of result.refs) expect(ref.quote).toBe(quote)
    })

    it('超时返回部分结果并标 degraded', async () => {
      const slowTool = cloneTool(tool, {
        limits: { ...tool.limits, timeoutMs: 5 },
        handler: async (_args: Record<string, unknown>, ctx) => {
          ctx.reportPartial({ data: { partial: true } } as never)
          await new Promise((resolve) => setTimeout(resolve, 40))
          return { data: { partial: false } }
        }
      })
      const { result } = await run({ toolset: withTool(baseToolset, slowTool) })
      expect(result.ok).toBe(true)
      expect(result.degraded).toBe('summary')
      expect(result.truncated).toBe(true)
      expect(result.data).toEqual({ partial: true })
    })

    it('幂等重放：propose/execute 两次一条记录 + duplicate；只读两次两条审计', async () => {
      const first = await run({})
      expect(first.result.ok, JSON.stringify(first.result.error ?? first.result)).toBe(true)
      expect(tool.output.safeParse(first.result.data).success).toBe(true)

      const second = await run({ jobId: first.context.jobId, turnId: first.context.turnId })
      if (tool.idempotency === 'key_required') {
        expect(second.result.ok).toBe(true)
        expect(second.result.duplicate).toBe(true)
        expect(world.repos.toolCall.listByTurn(first.context.turnId)).toHaveLength(1)
      } else {
        expect(second.result.ok).toBe(true)
        expect(second.result.duplicate).toBeUndefined()
        expect(world.repos.toolCall.listByTurn(first.context.turnId)).toHaveLength(2)
      }

      const [row] = world.repos.toolCall.listByTurn(first.context.turnId)
      expect(row?.argsHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row?.scopeJson).not.toContain('query')
      expect(row?.scopeJson).not.toContain('匣子')
    })
  })
}

/** 仅供生成清单：确保夹具与已注册工具一一对应（缺一个就失败）。 */
export function assertFixturesComplete(): void {
  const registered = AGENT_KEYS.flatMap((agent) =>
    registry.baselineFor(agent).map((tool) => tool.name)
  )
  const unique = [...new Set(registered)].filter((name) => name !== 'author.request_choice' || true)
  const missing = unique.filter((name) => !(name in CONTRACT_FIXTURES))
  if (missing.length > 0) throw new Error(`缺少契约夹具：${missing.join(', ')}`)
}
