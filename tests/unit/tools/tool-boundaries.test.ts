import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 工具层四条红线（DEV-PLAN §6.10）：
 * 不写 SQL、不读文件、不发网络、不开子进程；只能调 repos 与 services。
 * lint 与 dependency-cruiser 各自拦一层，这里再加一层源码级断言，防止规则被改坏。
 */

const TOOLS_DIR = resolve(process.cwd(), 'src/main/tools')
const FORBIDDEN_IMPORTS = [
  'better-sqlite3',
  'electron',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'undici'
]

function toolFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name))
}

describe('tool boundaries', () => {
  it('工具层不 import better-sqlite3 / node:fs / electron / 网络模块', () => {
    const violations: string[] = []
    for (const file of toolFiles(TOOLS_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!
        if (FORBIDDEN_IMPORTS.some((item) => specifier === item || specifier.startsWith(`${item}/`))) {
          violations.push(`${file}: ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('工具层不调用 fetch / 不执行 SQL', () => {
    const violations: string[] = []
    for (const file of toolFiles(TOOLS_DIR)) {
      const source = readFileSync(file, 'utf8')
      if (/(^|[^.\w])fetch\s*\(/.test(source)) violations.push(`${file}: fetch()`)
      if (/\.prepare\s*\(|\bCREATE\s+TABLE\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i.test(source)) {
        violations.push(`${file}: raw SQL`)
      }
    }
    expect(violations).toEqual([])
  })
})
