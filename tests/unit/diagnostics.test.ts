import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultDiagnosticsName,
  exportDiagnostics,
  exportDiagnosticsZip,
  scrubSecrets
} from '../../src/main/observability/diagnostics'
import { appInfo, tempDir } from './helpers'
import { unzip } from '../support/unzip'

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

  it('诊断 zip 可解压：README + 摘要 + 日志，且无 Key、无正文（PHASE-11 M1-24）', () => {
    const dir = tempDir('noryth-diag-zip-')
    cleanups.push(dir.cleanup)
    const logPath = join(dir.path, 'app.log')
    writeFileSync(
      logPath,
      [
        '{"level":30,"msg":"project_opened"}',
        '{"level":50,"msg":"auth failed","apiKey":"sk-live-abcdefghijklmn"}',
        '{"level":30,"msg":"beat committed","beatId":"bt_1"}'
      ].join('\n'),
      'utf8'
    )

    const target = join(dir.path, 'export', defaultDiagnosticsName(new Date('2026-11-15T00:00:00Z')))
    const result = exportDiagnosticsZip(
      {
        userDataDir: dir.path,
        appInfo: appInfo(),
        settings: { openLastProject: true, lastOpenedProjectId: 'prj_1' },
        projects: [
          {
            id: 'prj_1',
            title: '黑漆匣子',
            path: join(dir.path, 'book'),
            genre: '悬疑',
            pov: 'third_limited',
            targetWords: 100_000,
            setupState: 'complete',
            schemaVersion: 7,
            chapterCount: 30,
            wordCount: 140_000,
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-15T00:00:00.000Z',
            lastOpenedAt: '2026-11-15T00:00:00.000Z',
            available: true
          }
        ],
        logPath
      },
      target,
      {
        projectTitle: '黑漆匣子',
        schemaVersion: 7,
        jobs: [
          {
            id: 'job_1',
            type: 'beat.generate',
            status: 'failed',
            errorCode: 'model_error',
            createdAt: '2026-11-15T00:00:00.000Z',
            updatedAt: '2026-11-15T00:00:01.000Z'
          }
        ],
        verify: { ok: true, issues: [] }
      }
    )

    expect(result.path).toBe(target)
    expect(result.entries).toEqual(['README.txt', 'diagnostics.json', 'logs/app.log'])

    const entries = unzip(readFileSync(target))
    const byName = new Map(entries.map((entry) => [entry.name, entry.data.toString('utf8')]))
    const json = byName.get('diagnostics.json')!
    expect(json).toContain('"schemaVersion": 7')
    expect(json).toContain('"title": "黑漆匣子"')
    expect(json).toContain('"chapterCount": 30')
    expect(json).toContain('"status": "failed"')
    expect(json).not.toContain('sk-live-abcdefghijklmn')
    expect(json).toContain('[redacted-key]')

    const log = byName.get('logs/app.log')!
    expect(log).toContain('project_opened')
    expect(log).not.toContain('sk-live-abcdefghijklmn')
    // 结构性断言：诊断包不携带 body 字段（正文只在 beat 表与稿件里）。
    expect(json).not.toContain('"body"')

    // README 说明排除项，避免作者手工塞正文/db 进包。
    expect(byName.get('README.txt')).toContain('不包含：正文、secrets.bin、API Key')
  })
})
