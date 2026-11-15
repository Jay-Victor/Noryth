import { describe, expect, it } from 'vitest'
import { buildZip, crc32 } from '../../../src/main/observability/zip'
import { unzip } from '../../support/unzip'

describe('zip 写入器（PHASE-11 M1-24）', () => {
  it('crc32 与已知值一致（"123456789" = 0xCBF43926）', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })

  it('多条目 roundtrip：名字、内容与 CRC 全部可校验', () => {
    const zip = buildZip(
      [
        { name: 'README.txt', data: Buffer.from('无正文', 'utf8') },
        { name: 'logs/app.log', data: Buffer.from('{"level":30}\n', 'utf8') },
        { name: 'empty.txt', data: Buffer.alloc(0) }
      ],
      new Date('2026-11-15T10:00:00Z')
    )
    const entries = unzip(zip)
    expect(entries.map((entry) => entry.name)).toEqual(['README.txt', 'logs/app.log', 'empty.txt'])
    expect(entries[0]!.data.toString('utf8')).toBe('无正文')
    expect(entries[1]!.data.toString('utf8')).toContain('"level":30')
    expect(entries[2]!.data.length).toBe(0)
    // zip 以 PK\x03\x04 开头、以 EOCD 结束：Windows 资源管理器可直接打开。
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304')
  })

  it('非 ASCII 文件名拒绝写入（诊断包内部名字固定为 ASCII）', () => {
    expect(() => buildZip([{ name: '正文.txt', data: Buffer.from('x') }])).toThrow(/ascii/)
  })
})
