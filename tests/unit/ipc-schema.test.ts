import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '../../src/shared/domain/errors'
import { ErrorCodeSchema, IpcRequest, ok } from '../../src/shared/schema/ipc'
import {
  CreateProjectInputSchema,
  OpenProjectInputSchema,
  ProjectSummarySchema,
  SettingsSchema,
  ValidatePathInputSchema
} from '../../src/shared/schema/project'

describe('IPC schema', () => {
  it('请求信封要求 requestId 与 payload', () => {
    const schema = IpcRequest(ValidatePathInputSchema)
    expect(schema.safeParse({ requestId: 'rq_1', payload: { parentDir: 'E:\\x', folderName: 'y' } }).success).toBe(true)
    expect(schema.safeParse({ payload: {} }).success).toBe(false)
    expect(schema.safeParse({ requestId: '', payload: {} }).success).toBe(false)
  })

  it('多余字段一律拒绝（additionalProperties:false 的等价约束）', () => {
    const result = ValidatePathInputSchema.safeParse({ parentDir: 'E:\\x', folderName: 'y', extra: 1 })
    expect(result.success).toBe(false)
    const create = CreateProjectInputSchema.safeParse({
      parentDir: 'E:\\x',
      folderName: 'y',
      title: 't',
      genre: '',
      targetWords: null,
      pov: 'first',
      boundaries: '',
      characterId: 'char_1'
    })
    expect(create.success).toBe(false)
  })

  it('新建项目参数校验：视角枚举与篇幅下限', () => {
    const base = {
      parentDir: 'E:\\x',
      folderName: 'y',
      title: 't',
      genre: '',
      targetWords: 100_000,
      pov: 'third_limited',
      boundaries: ''
    }
    expect(CreateProjectInputSchema.safeParse(base).success).toBe(true)
    expect(CreateProjectInputSchema.safeParse({ ...base, pov: 'second' }).success).toBe(false)
    expect(CreateProjectInputSchema.safeParse({ ...base, targetWords: 100 }).success).toBe(false)
    expect(CreateProjectInputSchema.safeParse({ ...base, targetWords: null }).success).toBe(true)
  })

  it('只读字段是可选布尔，不接受任意字符串', () => {
    expect(OpenProjectInputSchema.safeParse({ path: 'E:\\x' }).success).toBe(true)
    expect(OpenProjectInputSchema.safeParse({ path: 'E:\\x', readOnly: true }).success).toBe(true)
    expect(OpenProjectInputSchema.safeParse({ path: 'E:\\x', readOnly: 'yes' }).success).toBe(false)
  })

  it('项目摘要与设置都有默认值', () => {
    expect(SettingsSchema.parse({})).toEqual({
      theme: 'system',
      lastOpenedProjectId: null,
      providers: {},
      tokenCalibration: {}
    })
    const summary = ProjectSummarySchema.safeParse({
      id: 'prj_1',
      title: 'x',
      path: 'E:\\x',
      genre: '',
      pov: 'first',
      targetWords: null,
      setupState: 'pending',
      schemaVersion: 1,
      chapterCount: 0,
      wordCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: null,
      available: true
    })
    expect(summary.success).toBe(true)
  })

  it('错误码 schema 与错误码表同步', () => {
    for (const code of ERROR_CODES) {
      expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true)
    }
    expect(ErrorCodeSchema.safeParse('made_up').success).toBe(false)
  })

  it('ok() 生成统一结果形状', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } })
  })
})
