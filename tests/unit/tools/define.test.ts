import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { inputJsonSchema, toManifestJson, toModelTool } from '../../../src/main/tools/define'
import { makeTool } from './support'

describe('defineTool A1–A5', () => {
  it('合法工具没有断言问题', () => {
    expect(makeTool('demo.valid').validationErrors).toEqual([])
  })

  it('A1：commit 工具不得 agent_callable', () => {
    const tool = makeTool('demo.commit', {
      sideEffect: 'commit',
      agentCallable: true,
      idempotency: 'key_required'
    })
    expect(tool.validationErrors.join(' ')).toContain('A1')
  })

  it('A2：injected 与 input 重叠、身份参数进 schema 都拒绝', () => {
    const overlap = makeTool('demo.overlap', {
      injected: ['character_id'],
      input: z.strictObject({ character_id: z.string() })
    })
    expect(overlap.validationErrors.join(' ')).toContain('A2')

    const identity = makeTool('demo.identity', {
      input: z.strictObject({ actor_id: z.string() })
    })
    expect(identity.validationErrors.join(' ')).toContain('A2')
  })

  it('A3：非 strict object 拒绝', () => {
    const tool = makeTool('demo.loose', {
      input: z.object({ q: z.string() }),
      output: z.object({ value: z.number() })
    })
    expect(tool.validationErrors.join(' ')).toContain('A3')
  })

  it('A5：空 actors、只读带闸门、执行无闸门、提案 natural 都拒绝', () => {
    expect(makeTool('demo.noactors', { actors: [] }).validationErrors.join(' ')).toContain('A5')

    const readonlyGate = makeTool('demo.readonlygate', { requiresGate: 'G5', sideEffect: 'none' })
    expect(readonlyGate.validationErrors.join(' ')).toContain('A5')

    const executeNoGate = makeTool('demo.execgate', { sideEffect: 'execute', idempotency: 'key_required' })
    expect(executeNoGate.validationErrors.join(' ')).toContain('A5')

    const proposeNatural = makeTool('demo.proposenatural', { sideEffect: 'propose', idempotency: 'natural' })
    expect(proposeNatural.validationErrors.join(' ')).toContain('A5')
  })

  it('commit 工具不得进入任何白名单（A1 + 空 actors）', () => {
    const tool = makeTool('demo.systemcommit', {
      sideEffect: 'commit',
      agentCallable: false,
      actors: [],
      system: true,
      idempotency: 'key_required'
    })
    expect(tool.validationErrors).toEqual([])
    expect(tool.enabled).toBe(true)
    expect(tool.agentCallable).toBe(false)
  })
})

describe('manifest JSON 映射', () => {
  it('snake_case 字段齐全且 contract_complete=true', () => {
    const tool = makeTool('demo.json', { injected: ['as_of'] })
    const json = toManifestJson(tool)
    expect(json.side_effect).toBe('none')
    expect(json.agent_callable).toBe(true)
    expect(json.requires_gate).toBeNull()
    expect(json.input_schema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(json.output_schema).toMatchObject({ type: 'object' })
    expect(json.contract_complete).toBe(true)
    expect(json.tool_id).toBe('T99')
    expect(json.m0).toBe(true)
  })

  it('非法工具禁止生成清单', () => {
    const broken = makeTool('demo.broken', { actors: [] })
    expect(() => toManifestJson(broken)).toThrow(/契约不合法/)
  })

  it('inputJsonSchema 与模型描述一致', () => {
    const tool = makeTool('demo.schema', { input: z.strictObject({ q: z.string().min(1).max(10) }) })
    const schema = inputJsonSchema(tool) as { properties?: Record<string, unknown>; additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties?.q).toMatchObject({ type: 'string', minLength: 1, maxLength: 10 })

    const descriptor = toModelTool(tool)
    expect(descriptor.type).toBe('function')
    expect(descriptor.function.name).toBe('demo.schema')
    expect(descriptor.function.parameters).toEqual(schema)
  })
})
