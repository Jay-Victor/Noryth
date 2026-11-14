import { describe, expect, it } from 'vitest'
import { argsHash, canonicalJson, idempotencyKey } from '../../../src/main/tools/idempotency'

describe('canonicalJson', () => {
  it('递归排序键，插入顺序不影响结果', () => {
    const left = { b: 1, a: { d: [3, 2], c: 'x' } }
    const right = { a: { c: 'x', d: [3, 2] }, b: 1 }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(canonicalJson(left)).toBe('{"a":{"c":"x","d":[3,2]},"b":1}')
  })

  it('数组顺序敏感', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('数字不转字符串', () => {
    expect(canonicalJson({ n: 1 })).toBe('{"n":1}')
    expect(canonicalJson({ n: 1 })).not.toBe(canonicalJson({ n: '1' }))
  })

  it('拒绝 undefined / NaN / Infinity / 类实例', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/)
    expect(() => canonicalJson(Number.NaN)).toThrow(/有限/)
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/有限/)
    expect(() => canonicalJson(new Date())).toThrow(/纯对象/)
  })
})

describe('idempotencyKey', () => {
  const base = {
    projectId: 'prj_1',
    jobId: 'job_1',
    tool: 'patch.propose',
    version: '1.0.0',
    args: { patches: [{ beat_id: 'bt_1', before: 'a', after: 'b' }] }
  }

  it('同参数、同 job、同版本稳定', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base, args: { patches: [{ after: 'b', before: 'a', beat_id: 'bt_1' }] } }))
    expect(idempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('换 job / 版本 / 参数都会漂移', () => {
    expect(idempotencyKey({ ...base, jobId: 'job_2' })).not.toBe(idempotencyKey(base))
    expect(idempotencyKey({ ...base, version: '1.0.1' })).not.toBe(idempotencyKey(base))
    expect(
      idempotencyKey({ ...base, args: { patches: [{ beat_id: 'bt_1', before: 'a', after: 'c' }] } })
    ).not.toBe(idempotencyKey(base))
  })

  it('argsHash 与 key 都只依赖规范 JSON', () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }))
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }))
  })
})
