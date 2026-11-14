import { describe, expect, it } from 'vitest'
import { truncatePayload } from '../../../src/main/tools/truncate'

const quote = '长'.repeat(80)

describe('truncatePayload', () => {
  it('预算内原样返回', () => {
    const shaped = truncatePayload({ data: { items: [1, 2] }, refs: [] }, 2000)
    expect(shaped.truncated).toBe(false)
    expect(shaped.payload.data).toEqual({ items: [1, 2] })
  })

  it('先丢 refs 尾部，total 记原始条数，quote 不切半', () => {
    const refs = Array.from({ length: 60 }, (_, index) => ({
      type: 'memory' as const,
      id: `mem_${index}`,
      quote
    }))
    const shaped = truncatePayload({ data: { hit_count: 60 }, refs }, 120)
    expect(shaped.truncated).toBe(true)
    expect(shaped.total).toBe(60)
    expect(shaped.payload.refs!.length).toBeLessThan(60)
    for (const ref of shaped.payload.refs!) expect(ref.quote).toBe(quote)
  })

  it('refs 丢完仍超预算时整条丢数组元素', () => {
    const data = { items: Array.from({ length: 80 }, (_, index) => ({ index, text: quote })) }
    const shaped = truncatePayload({ data }, 200)
    expect(shaped.truncated).toBe(true)
    expect(shaped.total).toBe(80)
    expect((shaped.payload.data as { items: unknown[] }).items.length).toBeLessThan(80)
  })

  it('仍超预算时整体降级为 summary', () => {
    const shaped = truncatePayload({ data: { blob: quote.repeat(50) } }, 10)
    expect(shaped.truncated).toBe(true)
    expect(shaped.degraded).toBe('summary')
    expect(shaped.payload.data).toEqual({ truncated: true })
  })

  it('handler 已标记 truncated 时保留标记与 total', () => {
    const shaped = truncatePayload({ data: { ok: true }, refs: [], truncated: true, total: 9 }, 2000)
    expect(shaped.truncated).toBe(true)
    expect(shaped.total).toBe(9)
  })
})
