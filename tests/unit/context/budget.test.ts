import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import type { BlockRole, CtxBlock, Layer } from '../../../src/main/context/budget'
import { fitToBudget, planBudget } from '../../../src/main/context/budget'
import { estimateTokens } from '../../../src/main/context/tokens'

function block(
  id: string,
  role: BlockRole,
  layer: Layer,
  priority: number,
  text: string,
  extra: Partial<CtxBlock> = {}
): CtxBlock {
  return { id, role, layer, priority, stable: false, tokens: estimateTokens(text), text, ...extra }
}

const CARD = block('L2:card', 'card', 'L2', 10, '角色：林砚\n身份/定位：账房学徒', { stable: true })
const INTENT = block('L2:intent', 'intent', 'L2', 50, '本拍意图：试探匣子的下落\n字数上限：120 字')

function recent(count: number, chars = 100): CtxBlock[] {
  return Array.from({ length: count }, (_, index) =>
    block(`L2:recent:bt_${String(index).padStart(2, '0')}`, 'recent', 'L2', 40, `第${index}拍：${'雨'.repeat(chars)}`, {
      order: index
    })
  )
}

function refs(count: number, chars = 40): CtxBlock[] {
  return Array.from({ length: count }, (_, index) =>
    block(`L2:ref:memory:mem_${index}`, 'ref', 'L2', 30, `记忆 ${index}：${'匣'.repeat(chars)}`, {
      refType: 'memory',
      order: index
    })
  )
}

function pinned(count: number, chars = 40): CtxBlock[] {
  return Array.from({ length: count }, (_, index) =>
    block(`L2:pinned:memory:mem_p${index}`, 'pinned', 'L2', 20, `钉住 ${index}：${'灯'.repeat(chars)}`, {
      refType: 'memory',
      order: index
    })
  )
}

function spectators(count: number): CtxBlock[] {
  return Array.from({ length: count }, (_, index) =>
    block(`L3:spectator:chr_${index}`, 'spectator', 'L3', 10, `[旁观] 角色${index}`, {
      stable: true,
      tension: 0.1 * (index + 1)
    })
  )
}

describe('上下文预算与裁剪（DEV-PLAN §7.3）', () => {
  it('预算按 hardCap 与输出预留计算，固定层先占位', () => {
    const plan = planBudget({ contextWindow: 64_000, maxWords: 120, spectators: 2 })
    expect(plan.hardCap).toBe(12_000)
    expect(plan.reserveOut).toBe(Math.ceil(120 * 1.4) + 400)
    expect(plan.total).toBe(12_000 - plan.reserveOut)
    expect(plan.dynamic).toBe(plan.total - (900 + 600 + 700 + 160 + 150 * 2))
    expect(plan.caps.spectators).toBe(2)
    expect(plan.limits.topK).toBe(5)
  })

  it('未知模型按 32k、观者上限 8、maxWords 放大预留', () => {
    const plan = planBudget({ maxWords: 2000, spectators: 20 })
    expect(plan.contextWindow).toBe(32_000)
    expect(plan.hardCap).toBe(12_000)
    expect(plan.reserveOut).toBe(3200)
    expect(plan.caps.spectators).toBe(8)
  })

  it('预算足够时不裁剪，顺序为 (layer, priority, id)', () => {
    const blocks = [INTENT, CARD, ...recent(3), ...refs(2), ...pinned(2), ...spectators(2)]
    const bundle = fitToBudget(blocks, 100_000)
    expect(bundle.trimmed).toEqual([])
    expect(bundle.degraded).toEqual([])
    expect(bundle.blocks.map((item) => item.id)).toEqual([
      'L2:card',
      ...pinned(2).map((item) => item.id),
      ...refs(2).map((item) => item.id),
      ...recent(3).map((item) => item.id),
      'L2:intent',
      ...spectators(2).map((item) => item.id)
    ])
  })

  it('超预算先裁最近拍，角色卡与意图永不裁', () => {
    const recentBlocks = recent(6)
    const blocks = [CARD, INTENT, ...recentBlocks, ...refs(3), ...pinned(2)]
    const total = blocks.reduce((sum, item) => sum + item.tokens, 0)
    const bundle = fitToBudget(blocks, total - 250)
    expect(bundle.trimmed.length).toBeGreaterThan(0)
    expect(bundle.trimmed[0]).toBe('L2:recent:bt_05')
    expect(bundle.blocks.some((item) => item.id === 'L2:card')).toBe(true)
    expect(bundle.blocks.some((item) => item.id === 'L2:intent')).toBe(true)
    expect(bundle.blocks.filter((item) => item.role === 'recent').length).toBeGreaterThanOrEqual(2)
    expect(bundle.degraded).toContain('context_trimmed')
    expect(bundle.totalTokens).toBeLessThanOrEqual(total - 250)
  })

  it('裁剪顺序：最近拍 → refs → 观者 → pinned → 记忆降级', () => {
    const blocks = [
      CARD,
      INTENT,
      ...recent(4),
      ...refs(4),
      ...pinned(4),
      ...spectators(3)
    ]
    const fixed = CARD.tokens + INTENT.tokens
    const budget = fixed + 2 * recent(1)[0]!.tokens + 2 * refs(1)[0]!.tokens + 130
    const bundle = fitToBudget(blocks, budget)
    const kept = new Set(bundle.blocks.map((item) => item.id))

    expect(kept.has('L2:card')).toBe(true)
    expect(kept.has('L2:intent')).toBe(true)
    expect([...kept].filter((id) => id.startsWith('L3:spectator:'))).toHaveLength(0)
    expect([...kept].filter((id) => id.startsWith('L2:recent:'))).toHaveLength(2)
    expect([...kept].filter((id) => id.startsWith('L2:ref:'))).toHaveLength(2)
    expect([...kept].filter((id) => id.startsWith('L2:pinned:')).length).toBeLessThan(4)
    expect([...kept].filter((id) => id.startsWith('L2:pinned:')).length).toBeGreaterThanOrEqual(1)
    expect(bundle.degraded).toContain('context_trimmed')
  })

  it('记忆先降级为 summary 再 facts_only，仍放不下抛 context_overflow', () => {
    const bigRefs = refs(2, 400)
    const blocks = [CARD, INTENT, ...bigRefs]
    const fixed = CARD.tokens + INTENT.tokens
    const bundle = fitToBudget(blocks, fixed + 80)
    expect(bundle.blocks.filter((item) => item.role === 'ref').length).toBe(2)
    expect(bundle.degraded.some((level) => level === 'memory_summary' || level === 'memory_facts_only')).toBe(true)

    expect(() => fitToBudget(blocks, 1)).toThrowError(AppError)
    try {
      fitToBudget(blocks, 1)
    } catch (error) {
      expect((error as AppError).code).toBe('context_overflow')
    }
  })

  it('同一输入两次输出完全一致', () => {
    const blocks = [CARD, INTENT, ...recent(5), ...refs(3), ...pinned(2), ...spectators(2)]
    const first = fitToBudget(blocks, 500)
    const second = fitToBudget(blocks, 500)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
