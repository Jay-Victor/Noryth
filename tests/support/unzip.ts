import { inflateRawSync } from 'node:zlib'

/**
 * 测试用的最小 zip 读取器（PHASE-11 M1-24 / PHASE-17）。
 *
 * 支持 store（方法 0，诊断包）与 deflate（方法 8，DOCX）单盘 zip。
 * 用它把导出的文件重新读出来，才能断言「包里到底有什么」而不是猜。
 */

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table.push(value >>> 0)
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

export interface UnzippedEntry {
  name: string
  data: Buffer
}

export function unzip(buffer: Buffer): UnzippedEntry[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD missing')

  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries: UnzippedEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central header')
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('ascii')

    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method} for ${name}`)
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? raw : inflateRawSync(raw)
    if (data.length !== size) throw new Error(`size mismatch for ${name}`)
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`)
    entries.push({ name, data: Buffer.from(data) })

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
