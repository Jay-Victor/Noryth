import { describe, expect, it } from 'vitest'
import { ALL_MANIFESTS, AGENT_TOOLS } from '../../src/main/tools/manifests'
import { CONTRACT_FIXTURES } from './fixtures'
import { contractSuite } from './harness'

for (const [name, fixture] of Object.entries(CONTRACT_FIXTURES)) {
  contractSuite(name, fixture)
}

describe('contract fixtures', () => {
  it('36 个已实现工具每个都有六类契约夹具', () => {
    const enabled = AGENT_TOOLS.filter((tool) => tool.enabled).map((tool) => tool.name).sort()
    expect(enabled).toHaveLength(36)
    expect(Object.keys(CONTRACT_FIXTURES).sort()).toEqual(enabled)
  })

  it('夹具只指向 M0 已注册工具', () => {
    for (const name of Object.keys(CONTRACT_FIXTURES)) {
      const tool = ALL_MANIFESTS.find((item) => item.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.enabled, name).toBe(true)
      expect(tool?.milestone, name).toBe('M0')
    }
  })
})
