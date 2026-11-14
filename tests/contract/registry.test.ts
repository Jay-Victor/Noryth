import { describe, expect, it } from 'vitest'
import { ALL_MANIFESTS, AGENT_TOOLS, SYSTEM_TOOLS } from '../../src/main/tools/manifests'
import { buildRegistry, computeToolsetVersion } from '../../src/main/tools/registry'
import { resolveToolset, withToolLimit } from '../../src/main/tools/resolve'
import { AGENT_KEYS } from '../../src/main/tools/types'
import { M0_TOOL_COUNTS, TOOL_ALLOWLIST } from '../../src/main/tools/generated/allowlist'
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

  it('2. M0 注册 36 个，6 个里程碑工具不在注册表', () => {
    expect(AGENT_TOOLS.filter((tool) => tool.enabled)).toHaveLength(36)
    expect(registry.tools.size).toBe(44) // 36 Agent + 8 系统
    for (const name of ['foreshadow.list_open', 'timeline.query', 'voice.metrics', 'coverage.check', 'impact.analyze', 'memory.rebuild']) {
      expect(registry.get(name), name).toBeUndefined()
    }
  })

  it('3. 六个 Agent 的基线数量与 PRD §4.11 一致', () => {
    for (const agent of AGENT_KEYS) {
      expect(registry.baselineFor(agent)).toHaveLength(EXPECTED[agent])
      expect(M0_TOOL_COUNTS[agent]).toBe(EXPECTED[agent])
    }
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

  it('5. 审批列表恰好 17 个，且包含 G5 的 patch.propose', () => {
    const names = resolveToolset('reviewer', {}, registry).names()
    expect(names).toHaveLength(17)
    expect(names).toContain('patch.propose')
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
