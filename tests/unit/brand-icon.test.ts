import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 品牌图标资源（PHASE-18 M1-25）。
 *
 * 图标由 `scripts/gen-icons.mjs` 生成：这里校验容器结构（PNG IHDR、ICO 目录），
 * 并跑一次 `--check` 守住「有人手改二进制」——图标只改脚本，不直接换文件。
 */

const ROOT = resolve(__dirname, '../..')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function pngSize(path: string): { width: number; height: number; colorType: number } {
  const buffer = readFileSync(path)
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25]!
  }
}

describe('品牌图标', () => {
  it('resources/icon.png 是 512×512 RGBA', () => {
    const size = pngSize(join(ROOT, 'resources', 'icon.png'))
    expect(size).toEqual({ width: 512, height: 512, colorType: 6 })
  })

  it('resources/icons 各尺寸 PNG 与文件名一致', () => {
    for (const size of [16, 32, 48, 64, 128, 256, 512]) {
      const png = pngSize(join(ROOT, 'resources', 'icons', `noryth-${size}.png`))
      expect(png.width).toBe(size)
      expect(png.height).toBe(size)
    }
  })

  it('resources/icon.ico 有 7 个 32 位 BMP 条目（16–256），偏移在文件内', () => {
    const ico = readFileSync(join(ROOT, 'resources', 'icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0) // reserved
    expect(ico.readUInt16LE(2)).toBe(1) // type: icon
    const count = ico.readUInt16LE(4)
    expect(count).toBe(ICO_SIZES.length)
    const sizes: number[] = []
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      const width = ico[entry] === 0 ? 256 : ico[entry]!
      const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1]!
      const planes = ico.readUInt16LE(entry + 4)
      const bitCount = ico.readUInt16LE(entry + 6)
      const bytes = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(width).toBe(height)
      expect(sizes).not.toContain(width)
      expect(planes).toBe(1)
      expect(bitCount).toBe(32)
      expect(offset + bytes).toBeLessThanOrEqual(ico.length)
      // 每个条目以 40 字节的 BITMAPINFOHEADER 开头（rcedit/NSIS 认的格式）。
      expect(ico.readUInt32LE(offset)).toBe(40)
      expect(ico.readInt32LE(offset + 4)).toBe(width)
      expect(ico.readInt32LE(offset + 8)).toBe(height * 2)
      sizes.push(width)
    }
    expect(sizes).toEqual(ICO_SIZES)
  })

  it('图标与生成脚本一致（node scripts/gen-icons.mjs --check）', () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-icons.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    expect(output).toContain('icons ok')
  })
})
