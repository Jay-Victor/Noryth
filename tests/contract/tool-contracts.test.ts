import { describe, expect, it } from 'vitest'
import { ALL_MANIFESTS, AGENT_TOOLS } from '../../src/main/tools/manifests'
import { CONTRACT_FIXTURES } from './fixtures'
import { contractSuite } from './harness'

for (const [name, fixture] of Object.entries(CONTRACT_FIXTURES)) {
  contractSuite(name, fixture)
}

describe('contract fixtures', () => {
  it('37 个已实现工具每个都有六类契约夹具', () => {
    const enabled = AGENT_TOOLS.filter((tool) => tool.enabled).map((tool) => tool.name).sort()
    expect(enabled).toHaveLength(37)
    expect(Object.keys(CONTRACT_FIXTURES).sort()).toEqual(enabled)
  })

  it('夹具只指向已注册工具（M0 + 已打开的 M1）', () => {
    for (const name of Object.keys(CONTRACT_FIXTURES)) {
      const tool = ALL_MANIFESTS.find((item) => item.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.enabled, name).toBe(true)
      expect(['M0', 'M1', 'P1', 'M2'], name).toContain(tool?.milestone)
    }
  })
})
