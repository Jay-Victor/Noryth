import { describe, expect, it } from 'vitest'
import { ALL_MANIFESTS, AGENT_TOOLS, SYSTEM_TOOLS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { AGENT_KEYS } from '../../src/main/tools/types'
import { M0_TOOL_COUNTS, TOOL_ALLOWLIST } from '../../src/main/tools/generated/allowlist'
import { TOOLSET_VERSION } from '../../src/main/tools/generated/toolset-version'
import { ERROR_CODES, ERROR_MESSAGES } from '../../src/shared/domain/errors'

const EXPECTED_COUNTS = {
  planner: 8,
  orchestrator: 16,
  character: 9,
  narrator: 5,
  reviewer: 17,
  memory: 13
} as const

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })

describe('tool registry', () => {
  it('42 个 Agent 工具 + 8 个系统能力全部通过 A1–A5', () => {
    expect(AGENT_TOOLS).toHaveLength(42)
    expect(SYSTEM_TOOLS).toHaveLength(8)
    expect(ALL_MANIFESTS).toHaveLength(50)
    for (const tool of ALL_MANIFESTS) {
      expect(tool.validationErrors, tool.name).toEqual([])
    }
    expect(registry.unavailable).toEqual([])
  })

  it('M0 注册 36 个，六个 Agent 的工具数与 PRD §4.11 一致', () => {
    const enabled = AGENT_TOOLS.filter((tool) => tool.enabled)
    expect(enabled).toHaveLength(36)
    for (const agent of AGENT_KEYS) {
      expect(registry.baselineFor(agent).length, agent).toBe(EXPECTED_COUNTS[agent])
      expect(M0_TOOL_COUNTS[agent], agent).toBe(EXPECTED_COUNTS[agent])
      expect(TOOL_ALLOWLIST[agent]).toEqual(registry.baselineFor(agent).map((tool) => tool.name))
    }
  })

  it('旁白快照恰好 5 个，审批 17 个', () => {
    expect(registry.baselineFor('narrator').map((tool) => tool.name)).toEqual([
      'canon.search_public',
      'character.get_public_profile',
      'outline.get_chapter_brief',
      'storyboard.get_beat',
      'world.get_reader_known'
    ])
    expect(registry.baselineFor('reviewer')).toHaveLength(17)
  })

  it('commit 工具永不下发给 Agent', () => {
    for (const tool of ALL_MANIFESTS.filter((item) => item.sideEffect === 'commit')) {
      expect(tool.agentCallable).toBe(false)
      expect(tool.actors).toEqual([])
      expect(registry.get(tool.name)).toBeDefined()
      for (const agent of AGENT_KEYS) {
        expect(registry.baselineFor(agent).some((item) => item.name === tool.name)).toBe(false)
      }
    }
  })

  it('有闸门的工具一定不是只读', () => {
    for (const tool of ALL_MANIFESTS.filter((item) => item.requiresGate !== null)) {
      expect(tool.sideEffect, tool.name).not.toBe('none')
    }
  })

  it('6 个里程碑工具保留契约但不注册、不下发', () => {
    const deferred = ALL_MANIFESTS.filter((tool) => !tool.system && !tool.enabled).map((tool) => tool.name).sort()
    expect(deferred).toEqual([
      'coverage.check',
      'foreshadow.list_open',
      'impact.analyze',
      'memory.rebuild',
      'timeline.query',
      'voice.metrics'
    ])
    for (const name of deferred) {
      expect(registry.get(name)).toBeUndefined()
      for (const agent of AGENT_KEYS) {
        expect(registry.baselineFor(agent).some((tool) => tool.name === name)).toBe(false)
      }
    }
  })

  it('生成的 allowlist 与注册表零漂移', () => {
    for (const agent of AGENT_KEYS) {
      expect(TOOL_ALLOWLIST[agent]).toEqual(registry.baselineFor(agent).map((tool) => tool.name))
    }
    expect(TOOLSET_VERSION).toBe(registry.version)
  })

  it('toolset_version 由全部 name@version 排序后哈希，改动会漂移', () => {
    const changed = ALL_MANIFESTS.map((tool) =>
      tool.name === 'project.get_meta' ? { ...tool, version: '1.0.1' } : tool
    )
    expect(buildRegistry(changed, { at: registry.at }).version).not.toBe(registry.version)
  })

  it('每个工具名唯一、版本 semver、tool_id 唯一', () => {
    const names = new Set(ALL_MANIFESTS.map((tool) => tool.name))
    const ids = new Set(ALL_MANIFESTS.map((tool) => tool.toolId))
    expect(names.size).toBe(ALL_MANIFESTS.length)
    expect(ids.size).toBe(ALL_MANIFESTS.length)
    for (const tool of ALL_MANIFESTS) expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('error codes', () => {
  it('每个错误码都有作者文案', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code]?.length ?? 0, code).toBeGreaterThan(0)
    }
  })

  it('工具层错误码齐全', () => {
    for (const code of ['tool_not_found', 'tool_unavailable', 'invalid_args', 'gate_required', 'gate_consumed', 'stale_revision']) {
      expect(ERROR_CODES).toContain(code)
    }
  })
})
