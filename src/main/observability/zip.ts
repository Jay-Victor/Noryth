/**
 * 最小 ZIP 写入器（PHASE-11 M1-24）。
 *
 * 为什么自己写：诊断包必须能在打包产物里用，而 zip 库要么带原生模块
 * （打包 + 签名成本）要么体积过大。诊断包只有几个小 JSON/文本，
 * 用「store（不压缩）」就够，解压由 Windows 资源管理器 / 7-Zip 原生支持。
 *
 * 格式：PKZIP APPNOTE 6.3 §4.3 单盘、无加密、无 data descriptor。
 * 只支持 ASCII 文件名（诊断包内部文件名固定，不需要 UTF-8 扩展）。
 */

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50

export interface ZipEntry {
  /** 包内路径，必须使用 `/` 分隔且只含 ASCII。 */
  name: string
  data: Buffer
}

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
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2) & 0x1f) << 0)
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, date: day }
}

/** 组装 zip 字节。条目顺序即写入顺序，重复名字不检查（调用方负责）。 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    if (!/^[\x20-\x7e]+$/.test(entry.name)) {
      throw new Error(`zip entry name must be ascii: ${entry.name}`)
    }
    const name = Buffer.from(entry.name, 'ascii')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const centralEntry = Buffer.alloc(46)
    centralEntry.writeUInt32LE(CENTRAL_HEADER, 0)
    centralEntry.writeUInt16LE(20, 4)
    centralEntry.writeUInt16LE(20, 6)
    centralEntry.writeUInt16LE(0x0800, 8)
    centralEntry.writeUInt16LE(0, 10)
    centralEntry.writeUInt16LE(time, 12)
    centralEntry.writeUInt16LE(date, 14)
    centralEntry.writeUInt32LE(crc, 16)
    centralEntry.writeUInt32LE(entry.data.length, 20)
    centralEntry.writeUInt32LE(entry.data.length, 24)
    centralEntry.writeUInt16LE(name.length, 28)
    centralEntry.writeUInt16LE(0, 30)
    centralEntry.writeUInt16LE(0, 32)
    centralEntry.writeUInt16LE(0, 34)
    centralEntry.writeUInt16LE(0, 36)
    centralEntry.writeUInt32LE(0, 38)
    centralEntry.writeUInt32LE(offset, 42)

    chunks.push(local, name, entry.data)
    central.push(centralEntry, name)
    offset += local.length + name.length + entry.data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}
