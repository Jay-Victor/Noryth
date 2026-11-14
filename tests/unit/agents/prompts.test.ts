import { describe, expect, it } from 'vitest'
import type { ContextBundle, CtxBlock } from '../../../src/main/context/budget'
import { estimateTokens } from '../../../src/main/context/tokens'
import { FALLBACK_INSTRUCTION } from '../../../src/main/model/json-fallback'
import { AGENT_PROMPTS, PROMPT_VERSION, renderPrompt } from '../../../src/main/agents/prompts'

function block(partial: Omit<CtxBlock, 'tokens'>): CtxBlock {
  return { ...partial, tokens: estimateTokens(partial.text) }
}

function bundle(patch: Partial<ContextBundle> = {}): ContextBundle {
  const blocks: CtxBlock[] = [
    block({ id: 'L0:chapter', layer: 'L0', stable: true, priority: 10, text: '本章目标：确认匣子的下落', role: 'l0' }),
    block({ id: 'L1:scene', layer: 'L1', stable: true, priority: 10, text: '地点：沈家祠堂', role: 'l1' }),
    block({ id: 'L2:card', layer: 'L2', stable: true, priority: 10, text: '角色：林砚', role: 'card' }),
    block({ id: 'L2:ref:memory:mem_1', layer: 'L2', stable: false, priority: 30, text: '记忆：匣子在供桌下', role: 'ref', refType: 'memory' }),
    block({ id: 'L2:intent', layer: 'L2', stable: false, priority: 50, text: '本拍意图：试探', role: 'intent' })
  ]
  return { blocks, totalTokens: blocks.reduce((sum, item) => sum + item.tokens, 0), trimmed: [], degraded: [], ...patch }
}

describe('六角色提示词与稳定前缀（DEV-PLAN §7.9）', () => {
  it('六个 Agent 各一份，提示词里没有时间戳/job id/拍 id', () => {
    expect(Object.keys(AGENT_PROMPTS).sort()).toEqual([
      'character',
      'memory',
      'narrator',
      'orchestrator',
      'planner',
      'reviewer'
    ])
    for (const prompt of Object.values(AGENT_PROMPTS)) {
      expect(prompt.prefix.length).toBeGreaterThan(20)
      expect(prompt.prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(prompt.prefix).not.toMatch(/job_|turn_|bt_\d/)
    }
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{64}$/)
  })

  it('system 只放角色提示词与 L0/L1，动态块进 user', () => {
    const rendered = renderPrompt({ agentKey: 'character:chr_lin', bundle: bundle() })
    expect(rendered.messages).toHaveLength(2)
    expect(rendered.messages[0]?.role).toBe('system')
    expect(rendered.system).toContain('你就是分镜指定的这个角色')
    expect(rendered.system).toContain('本章目标：确认匣子的下落')
    expect(rendered.system).toContain('地点：沈家祠堂')
    expect(rendered.system).not.toContain('记忆：匣子在供桌下')
    expect(rendered.user).toContain('角色：林砚')
    expect(rendered.user).toContain('记忆：匣子在供桌下')
    expect(rendered.user).toContain('本拍意图：试探')
    expect(rendered.prefixHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('动态内容变化不影响前缀 hash（前缀缓存）', () => {
    const first = renderPrompt({ agentKey: 'character:chr_lin', bundle: bundle() })
    const changed = bundle({
      blocks: bundle().blocks.map((item) =>
        item.role === 'ref' ? { ...item, text: '记忆：另一条完全不同的材料' } : item
      )
    })
    const second = renderPrompt({ agentKey: 'character:chr_lin', bundle: changed })
    expect(second.system).toBe(first.system)
    expect(second.prefixHash).toBe(first.prefixHash)
    expect(second.user).not.toBe(first.user)
  })

  it('JSON 回退时用协议替换最终答复契约', () => {
    const native = renderPrompt({ agentKey: 'character:chr_lin', bundle: bundle() })
    const fallback = renderPrompt({ agentKey: 'character:chr_lin', bundle: bundle(), jsonFallback: true })
    expect(native.system).toContain('【输出契约】')
    expect(fallback.system).toContain(FALLBACK_INSTRUCTION)
    expect(fallback.system).not.toContain('【输出契约】')
  })

  it('工具不使用提示词下发：system 里不出现工具名', () => {
    const rendered = renderPrompt({ agentKey: 'character:chr_lin', bundle: bundle() })
    expect(rendered.system).not.toContain('memory.retrieve_own')
    expect(rendered.system).not.toContain('world.get_limited')
  })
})
