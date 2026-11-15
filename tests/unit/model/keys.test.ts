import { describe, expect, it } from 'vitest'
import { envApiKeyLookup, settingsFirstLookup } from '../../../src/main/model/keys'

const ENV = {
  NORYTH_DEEPSEEK_API_KEY: 'sk-env-specific',
  NORYTH_PLAN_API_KEY: 'sk-env-plan',
  NORYTH_WRITE_API_KEY: 'sk-env-write'
} as NodeJS.ProcessEnv

describe('API Key 解析（I1）', () => {
  it('环境变量：先 provider 专属，再 Agent 兜底', () => {
    const lookup = envApiKeyLookup(['NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY'], ENV)
    expect(lookup('deepseek')).toEqual({ key: 'sk-env-specific', source: 'env' })
    expect(lookup('tongyi')).toEqual({ key: 'sk-env-write', source: 'env' })
  })

  it('设置页的 Key 优先于环境变量；没有设置值时回落环境变量', () => {
    const secrets = {
      get: (provider: string): string | null => (provider === 'deepseek' ? 'sk-settings' : null)
    }
    const lookup = settingsFirstLookup(secrets, ['NORYTH_PLAN_API_KEY'], ENV)
    expect(lookup('deepseek')).toEqual({ key: 'sk-settings', source: 'settings' })
    expect(lookup('tongyi')).toEqual({ key: 'sk-env-plan', source: 'env' })
  })

  it('空白值视为未配置', () => {
    const lookup = envApiKeyLookup([], { NORYTH_OPENAI_API_KEY: '   ' } as NodeJS.ProcessEnv)
    expect(lookup('openai')).toBeNull()
  })
})
