import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportDiagnostics, scrubSecrets } from '../../src/main/observability/diagnostics'
import { appInfo, tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('diagnostics', () => {
  it('导出包只含元数据与日志尾部，不含 Key 与正文', () => {
    const dir = tempDir('noryth-diag-')
    cleanups.push(dir.cleanup)
    const logPath = join(dir.path, 'app.log')
    writeFileSync(
      logPath,
      [
        '{"level":30,"msg":"project_created"}',
        '{"level":50,"msg":"auth failed","apiKey":"sk-abcdefghijklmnop"}',
        '{"level":30,"msg":"authorization: Bearer topsecret"}'
      ].join('\n'),
      'utf8'
    )

    const target = exportDiagnostics({
      userDataDir: dir.path,
      appInfo: appInfo(),
      settings: { theme: 'system', lastOpenedProjectId: null },
      projects: [],
      logPath
    })
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('project_created')
    expect(content).not.toContain('sk-abcdefghijklmnop')
    expect(content).not.toContain('topsecret')
    expect(content).toContain('[redacted-key]')
    expect(content).not.toMatch(/\u4f60\u5728\u6211\u7238\u4e66\u623f/)
  })

  it('scrubSecrets 处理 sk- 与 api_key 形态', () => {
    expect(scrubSecrets('key sk-1234567890abcdef')).toBe('key [redacted-key]')
    expect(scrubSecrets('api_key=abcd1234')).toContain('[redacted]')
    expect(scrubSecrets('normal text')).toBe('normal text')
  })
})
