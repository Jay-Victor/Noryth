import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * PHASE-19 §6 验收：指标不进入提示词。
 * `agents/prompts/**` 与 `context/**` 不允许读 `voice_metric` / `distinctness` /
 * `voice.metrics`；指标只进 UI 与报告建议，不是模型的质量判断依据。
 */

function filesUnder(dir: string): string[] {
  const entries = readdirSync(dir)
  return entries.flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('声音指标不进入提示词', () => {
  it('prompts 与 context 不含 voice_metric / distinctness / voice.metrics', () => {
    const roots = ['src/main/agents/prompts', 'src/main/context']
    const matches: string[] = []
    for (const root of roots) {
      for (const file of filesUnder(root)) {
        const text = readFileSync(file, 'utf8')
        for (const needle of ['voice_metric', 'distinctness', 'voice.metrics']) {
          if (text.includes(needle)) matches.push(`${file}: ${needle}`)
        }
      }
    }
    expect(matches).toEqual([])
  })
})
