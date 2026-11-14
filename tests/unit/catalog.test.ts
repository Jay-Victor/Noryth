import { describe, expect, it } from 'vitest'
import {
  ALL_ENTRIES,
  ALLOWLIST,
  M0_COUNTS,
  M0_TOOLS,
  SYSTEM_CAPABILITIES,
  TOOLS,
  catalogIntegrityErrors
} from '../../src/main/tools/catalog'
import { ERROR_CODES, ERROR_MESSAGES } from '../../src/shared/domain/errors'

describe('tool catalog', () => {
  it('构建期断言全部通过', () => {
    const errors = catalogIntegrityErrors()
    expect(errors, errors.join(' | ')).toEqual([])
  })

  it('42 个 Agent 工具 + 8 个系统能力，M0 注册 36 个', () => {
    expect(TOOLS).toHaveLength(42)
    expect(SYSTEM_CAPABILITIES).toHaveLength(8)
    expect(ALL_ENTRIES).toHaveLength(50)
    expect(M0_TOOLS).toHaveLength(36)
  })

  it('六个 Agent 的 M0 工具数与 PRD §4.11 一致', () => {
    for (const [agent, expected] of Object.entries(M0_COUNTS)) {
      expect(ALLOWLIST[agent as keyof typeof ALLOWLIST].length, agent).toBe(expected)
    }
    expect(ALLOWLIST.narrator).toEqual([
      'canon.search_public',
      'character.get_public_profile',
      'outline.get_chapter_brief',
      'storyboard.get_beat',
      'world.get_reader_known'
    ])
  })

  it('commit 工具永远不下发给 Agent', () => {
    for (const entry of ALL_ENTRIES.filter((item) => item.sideEffect === 'commit')) {
      expect(entry.agentCallable).toBe(false)
      expect(entry.actors).toEqual([])
    }
  })

  it('有闸门的工具一定不是只读', () => {
    for (const entry of ALL_ENTRIES.filter((item) => item.requiresGate !== null)) {
      expect(entry.sideEffect, entry.name).not.toBe('none')
    }
  })

  it('未实现的 6 个工具仍在清单里，但不在 M0 白名单', () => {
    const deferred = TOOLS.filter((tool) => !tool.m0).map((tool) => tool.name).sort()
    expect(deferred).toEqual([
      'coverage.check',
      'foreshadow.list_open',
      'impact.analyze',
      'memory.rebuild',
      'timeline.query',
      'voice.metrics'
    ])
    for (const name of deferred) {
      expect(M0_TOOLS.some((tool) => tool.name === name)).toBe(false)
    }
  })
})

describe('error codes', () => {
  it('每个错误码都有作者文案', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code]?.length ?? 0, code).toBeGreaterThan(0)
    }
  })
})
