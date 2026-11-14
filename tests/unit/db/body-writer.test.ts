import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_MAIN = join(process.cwd(), 'src', 'main')

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

function offenders(pattern: RegExp): string[] {
  return walk(SRC_MAIN)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC_MAIN, file).replace(/\\/g, '/'))
}

/**
 * PHASE-02 §8 第 5 条：没有第二处写 beat.body 的代码路径。
 * 正文写入只允许出现在 repos/beat.ts 的 INSERT 中；其他模块（阶段 07 的 DocController）
 * 必须调用该 repo，而不是自己拼 SQL。
 */
describe('beat.body 单一写入者', () => {
  it('src/main 只有 repos/beat.ts 插入或更新 beat', () => {
    expect(offenders(/insertInto\(\s*'beat'\s*\)|INSERT\s+INTO\s+beat\b/i)).toEqual(['db/repos/beat.ts'])
    expect(offenders(/updateTable\(\s*'beat'\s*\)|UPDATE\s+beat\s+SET/i)).toEqual(['db/repos/beat.ts'])
  })

  it('src/main 没有 UPDATE beat SET ... body 的写法', () => {
    expect(offenders(/UPDATE\s+beat\s+SET[\s\S]{0,160}?\bbody\s*=/i)).toEqual([])
  })
})
