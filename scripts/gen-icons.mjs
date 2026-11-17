/**
 * 品牌图标生成（PHASE-18 M1-25）。
 *
 * 不引第三方图像库：直接按归一化坐标光栅化（4× 超采样）+ 手写 PNG/ICO 容器。
 * 输出确定性字节，改设计只改这个脚本，不在仓库里手改二进制。
 *
 * 产物：
 *   resources/icon.png              512×512（electron-builder 的备用源 / 文档）
 *   resources/icon.ico              16–256 多尺寸（安装包、exe、任务栏）
 *   resources/icons/noryth-<n>.png  各尺寸 PNG（窗口 / 应用内品牌位）
 *
 * 设计：深墨色圆角方块 + 米色 N 字 + 琥珀书脊，缩到 16px 仍是「N + 竖条」。
 *
 * 用法：node scripts/gen-icons.mjs [--check]
 *   --check 只校验现有文件与重新生成的结果一致（CI 可守「图标被手改」）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const COLORS = {
  bgTop: [0x20, 0x20, 0x27],
  bgBottom: [0x12, 0x12, 0x16],
  ink: [0xef, 0xe6, 0xd2],
  amber: [0xc8, 0x96, 0x3e]
}

const SS = 4 // 超采样倍数

/** 圆角矩形的归一化几何：x/y 为左上角，w/h 为宽高，r 为圆角半径。 */
function insideRoundedRect(nx, ny, x, y, w, h, r) {
  if (nx < x || nx > x + w || ny < y || ny > y + h) return false
  const cx = Math.min(Math.max(nx, x + r), x + w - r)
  const cy = Math.min(Math.max(ny, y + r), y + h - r)
  const dx = nx - cx
  const dy = ny - cy
  return dx * dx + dy * dy <= r * r
}

/** 凸多边形（归一化坐标）的点包含测试。 */
function insidePolygon(nx, ny, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    const intersects = yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/** 单像素颜色（归一化坐标）；返回 null = 透明。 */
function shade(nx, ny) {
  // 圆角方块背景（留 3% 边距，避免 Windows 图标贴边）。
  if (!insideRoundedRect(nx, ny, 0.03, 0.03, 0.94, 0.94, 0.2)) return null
  const t = Math.min(1, Math.max(0, (ny - 0.03) / 0.94))
  const bg = mix(COLORS.bgTop, COLORS.bgBottom, t)
  // 琥珀书脊
  if (insideRoundedRect(nx, ny, 0.13, 0.24, 0.075, 0.52, 0.028)) return COLORS.amber
  // 米色 N：左竖、斜杠、右竖
  if (insideRoundedRect(nx, ny, 0.29, 0.285, 0.11, 0.43, 0.022)) return COLORS.ink
  if (insideRoundedRect(nx, ny, 0.7, 0.285, 0.11, 0.43, 0.022)) return COLORS.ink
  const diagonal = [
    [0.4, 0.285],
    [0.512, 0.285],
    [0.7, 0.715],
    [0.588, 0.715]
  ]
  if (insidePolygon(nx, ny, diagonal)) return COLORS.ink
  return bg
}

/** 渲染 size×size 的 RGBA（非预乘）。 */
function render(size) {
  const big = size * SS
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const nx = (x * SS + sx + 0.5) / big
          const ny = (y * SS + sy + 0.5) / big
          const color = shade(nx, ny)
          if (color === null) continue
          r += color[0]
          g += color[1]
          b += color[2]
          a += 255
        }
      }
      const samples = SS * SS
      const alpha = a / samples
      const offset = (y * size + x) * 4
      out[offset] = alpha === 0 ? 0 : Math.round(r / (a / 255))
      out[offset + 1] = alpha === 0 ? 0 : Math.round(g / (a / 255))
      out[offset + 2] = alpha === 0 ? 0 : Math.round(b / (a / 255))
      out[offset + 3] = Math.round(alpha)
    }
  }
  return out
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── ICO（32 位 BMP 条目，Windows/rcedit 都认）────────────────────────────────

function encodeIcoEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight：XOR + AND 两份
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bit count
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // XOR 字节数
  // 其余（pels/ppm/clr）保持 0

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4 // BMP 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }
  const maskRowBytes = Math.ceil(size / 8 / 4) * 4
  const and = Buffer.alloc(maskRowBytes * size)
  return Buffer.concat([header, xor, and])
}

function encodeIco(sizes, images) {
  const entries = []
  let offset = 6 + sizes.length * 16
  for (const size of sizes) {
    const data = images.get(size)
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  return Buffer.concat([header, ...entries, ...sizes.map((size) => images.get(size))])
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512]

function build() {
  const pngs = new Map()
  for (const size of PNG_SIZES) pngs.set(size, encodePng(size, render(size)))
  const icoImages = new Map()
  for (const size of ICO_SIZES) {
    icoImages.set(size, encodeIcoEntry(size, render(size)))
  }
  return { pngs, ico: encodeIco(ICO_SIZES, icoImages) }
}

const check = process.argv.includes('--check')
const { pngs, ico } = build()

const targets = [
  [join(ROOT, 'resources', 'icon.png'), pngs.get(512)],
  [join(ROOT, 'resources', 'icon.ico'), ico],
  ...PNG_SIZES.map((size) => [join(ROOT, 'resources', 'icons', `noryth-${size}.png`), pngs.get(size)])
]

let mismatch = 0
for (const [path, data] of targets) {
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(data)) {
      console.error(`icon drift: ${path}`)
      mismatch += 1
    }
    continue
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`wrote ${path} (${data.length} B)`)
}

if (check) {
  if (mismatch > 0) {
    console.error(`图标与脚本不一致（${mismatch} 个文件）；运行 node scripts/gen-icons.mjs 重新生成`)
    process.exit(1)
  }
  console.log(`icons ok: ${targets.length} files`)
}
