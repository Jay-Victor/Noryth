import { describe, expect, it } from 'vitest'
import { ALL_MANIFESTS, AGENT_TOOLS, SYSTEM_TOOLS } from '../../src/main/tools/manifests'
import { buildRegistry, computeToolsetVersion } from '../../src/main/tools/registry'
import { resolveToolset, withToolLimit } from '../../src/main/tools/resolve'
import { AGENT_KEYS } from '../../src/main/tools/types'
import { M0_TOOL_COUNTS, TOOL_ALLOWLIST, TOOL_COUNTS } from '../../src/main/tools/generated/allowlist'
import { TOOLSET_VERSION } from '../../src/main/tools/generated/toolset-version'

/** 注册表三类 + 授权快照的硬门（PHASE-03 C2/C7）。 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const EXPECTED = { planner: 8, orchestrator: 16, character: 9, narrator: 5, reviewer: 17, memory: 13 } as const

describe('registry contracts', () => {
  it('1. 清单总数：42 Agent 工具 + 8 系统能力', () => {
    expect(AGENT_TOOLS).toHaveLength(42)
    expect(SYSTEM_TOOLS).toHaveLength(8)
    expect(ALL_MANIFESTS).toHaveLength(50)
  })

  it('2. M0 注册 36 个 + 已打开 T22/T23/T25/T26/T29/T40；42 个 Agent 工具全部已注册', () => {
    expect(AGENT_TOOLS.filter((tool) => tool.enabled)).toHaveLength(42)
    expect(registry.tools.size).toBe(50) // 42 Agent + 8 系统
    for (const name of ['voice.metrics', 'foreshadow.list_open', 'coverage.check', 'impact.analyze']) {
      expect(registry.get(name), name).toBeDefined()
    }
  })

  it('3. 六个 Agent 的 M0 基线与 PRD §4.11 一致（当前白名单含 M1 开关）', () => {
    for (const agent of AGENT_KEYS) {
      expect(M0_TOOL_COUNTS[agent]).toBe(EXPECTED[agent])
      const baseline = registry.baselineFor(agent).length
      expect(baseline).toBeGreaterThanOrEqual(EXPECTED[agent])
      expect(TOOL_COUNTS[agent]).toBe(baseline)
    }
    for (const agent of ['orchestrator'] as const) {
      expect(registry.baselineFor(agent), agent).toHaveLength(EXPECTED[agent] + 2)
      expect(registry.baselineFor(agent).map((tool) => tool.name)).toContain('timeline.query')
      expect(registry.baselineFor(agent).map((tool) => tool.name)).toContain('foreshadow.list_open')
    }
    // 审批：T23 + T22 + T25（M2 声音指标）
    expect(registry.baselineFor('reviewer')).toHaveLength(20)
    expect(registry.baselineFor('reviewer').map((tool) => tool.name)).toContain('voice.metrics')
    // 规划：T26 覆盖检查 + T29 影响分析
    expect(registry.baselineFor('planner')).toHaveLength(EXPECTED.planner + 2)
    expect(registry.baselineFor('planner').map((tool) => tool.name)).toContain('coverage.check')
    expect(registry.baselineFor('planner').map((tool) => tool.name)).toContain('impact.analyze')
    // 记忆管理：T23 + T40（按章重建）+ T22
    expect(registry.baselineFor('memory')).toHaveLength(EXPECTED.memory + 3)
    expect(registry.baselineFor('memory').map((tool) => tool.name)).toContain('memory.rebuild')
  })

  it('4. 旁白列表恰好 5 个', () => {
    expect(resolveToolset('narrator', {}, registry).names()).toEqual([
      'canon.search_public',
      'character.get_public_profile',
      'outline.get_chapter_brief',
      'storyboard.get_beat',
      'world.get_reader_known'
    ])
  })

  it('5. 审批列表恰好 20 个（17 + T23 + T22 + T25），且包含 G5 的 patch.propose', () => {
    const names = resolveToolset('reviewer', {}, registry).names()
    expect(names).toHaveLength(20)
    expect(names).toContain('patch.propose')
    expect(names).toContain('timeline.query')
    expect(names).toContain('voice.metrics')
    expect(names).not.toContain('memory.apply')
  })

  it('6. commit 工具不进任何 Agent 白名单', () => {
    const commitTools = ALL_MANIFESTS.filter((tool) => tool.sideEffect === 'commit').map((tool) => tool.name)
    for (const agent of AGENT_KEYS) {
      const names = registry.baselineFor(agent).map((tool) => tool.name)
      for (const name of commitTools) expect(names, `${agent}/${name}`).not.toContain(name)
    }
  })

  it('7. 未授权硬调不在 tools 列表（解析期就不存在）', () => {
    const narrator = resolveToolset('narrator', {}, registry)
    expect(narrator.get('world.get_objective')).toBeUndefined()
    expect(narrator.names()).not.toContain('world.get_objective')
  })

  it('8. 名称唯一、版本 semver、tool_id 唯一', () => {
    expect(new Set(ALL_MANIFESTS.map((tool) => tool.name)).size).toBe(50)
    expect(new Set(ALL_MANIFESTS.map((tool) => tool.toolId)).size).toBe(50)
    for (const tool of ALL_MANIFESTS) expect(tool.version, tool.name).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('9. 生成的 allowlist 与注册表零 diff', () => {
    for (const agent of AGENT_KEYS) {
      expect(TOOL_ALLOWLIST[agent]).toEqual(registry.baselineFor(agent).map((tool) => tool.name))
    }
  })

  it('10. toolset_version 与生成物一致，清单变化会漂移', () => {
    expect(TOOLSET_VERSION).toBe(registry.version)
    expect(computeToolsetVersion(ALL_MANIFESTS)).toBe(registry.version)
    const changed = ALL_MANIFESTS.map((tool) =>
      tool.name === 'project.get_meta' ? { ...tool, version: '1.1.0' } : tool
    )
    expect(computeToolsetVersion(changed)).not.toBe(registry.version)
  })

  it('11. job 快照不随中途设置漂移', () => {
    const jobToolset = resolveToolset('narrator', {}, registry)
    const later = buildRegistry(ALL_MANIFESTS, { at: '2030-01-01T00:00:00.000Z' })
    const changed = resolveToolset('narrator', { disabledTools: ['canon.search_public'] }, later)
    expect(jobToolset.version).toBe(TOOLSET_VERSION)
    expect(jobToolset.names()).toHaveLength(5)
    expect(changed.names()).toHaveLength(4)
    expect(jobToolset.get('canon.search_public')).toBeDefined()
  })

  it('12. 角色实例收窄 schema；模型描述里没有 character_id', () => {
    const characterToolset = resolveToolset('character:chr_lin', {}, registry)
    const own = characterToolset.get('memory.retrieve_own')!
    expect(Object.keys(own.input.shape)).not.toContain('character_id')
    expect(own.injected).toContain('character_id')

    const edges = characterToolset.get('relationship.get_edges')!
    expect(Object.keys(edges.input.shape)).not.toContain('character_id')
    expect(edges.injected).toContain('character_id')

    const modelTools = characterToolset.toModelTools()
    const ownDescriptor = modelTools.find((descriptor) => descriptor.function.name === 'memory.retrieve_own')!
    expect(JSON.stringify(ownDescriptor.function.parameters)).not.toContain('character_id')
    expect(withToolLimit(characterToolset, 'memory.retrieve_own', { maxResultTokens: 10 }).get('memory.retrieve_own')?.limits.maxResultTokens).toBe(10)
  })
})
