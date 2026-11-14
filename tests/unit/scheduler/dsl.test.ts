import { describe, expect, it } from 'vitest'
import {
  MAX_DEPTH,
  MAX_NODES,
  evaluateExit,
  exitAstFromJson,
  exitExpressionText,
  parseExitInput,
  validateExitAst,
  validateExitSource,
  type ExitExpr
} from '../../../src/main/scheduler/dsl'

/**
 * 出口 DSL（PHASE-07 §1 第 2 条 / DEV-PLAN §8.4 D1–D8）：
 * 自然语言必须被拒；纯 beats 告警；求值只查事实/关系/拍数。
 */

const registry = {
  entities: new Set(['black_box', 'lin', 'yan']),
  predicates: new Set(['location', 'owner']),
  participants: new Set(['lin', 'yan']),
  maxBeats: 12
}

describe('出口 DSL 校验', () => {
  it('接受六种节点：fact / rel / beats / all / any / not', () => {
    const exprs: ExitExpr[] = [
      { op: 'fact', subject: 'black_box', predicate: 'location' },
      { op: 'rel', from: 'lin', to: 'yan', axis: 'trust', cmp: '>=', value: 0.6 },
      { op: 'beats', cmp: '>=', value: 6 },
      { op: 'all', of: [{ op: 'beats', cmp: '>=', value: 2 }, { op: 'fact', subject: 'black_box', predicate: 'location' }] },
      { op: 'any', of: [{ op: 'beats', cmp: '>=', value: 2 }, { op: 'beats', cmp: '>=', value: 5 }] },
      { op: 'not', of: { op: 'fact', subject: 'black_box', predicate: 'owner', object: 'lin' } }
    ]
    for (const expr of exprs) {
      const result = validateExitAst(expr, registry)
      expect(result.valid, JSON.stringify(result.reasons)).toBe(true)
      expect(result.machine_decidable, JSON.stringify(result.reasons)).toBe(true)
    }
  })

  it('自然语言出口直接拒绝（valid=false）', () => {
    const result = validateExitSource('等他们吵完就算这场结束', registry)
    expect(result.valid).toBe(false)
    expect(result.machine_decidable).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('纯 beats 出口合法但标 beats_only 告警', () => {
    const result = validateExitSource('beats(6)', registry)
    expect(result.valid).toBe(true)
    expect(result.machine_decidable).toBe(true)
    expect(result.beats_only).toBe(true)
    expect(result.warnings[0]).toContain('beats_only')
  })

  it('fact/rel 叶子不算 beats_only', () => {
    const result = validateExitSource('all(fact("black_box","location"), beats(2))', registry)
    expect(result.beats_only).toBe(false)
  })

  it('未登记的实体/谓词 → machine_decidable=false，但语法仍合法', () => {
    const result = validateExitSource('fact("unknown","smell")', registry)
    expect(result.valid).toBe(true)
    expect(result.machine_decidable).toBe(false)
    expect(result.reasons.join('|')).toContain('未登记')
  })

  it('rel 的 from/to 必须在场者内', () => {
    const result = validateExitSource('rel("lin","stranger","trust",">=",0.5)', registry)
    expect(result.valid).toBe(true)
    expect(result.machine_decidable).toBe(false)
    expect(result.reasons.join('|')).toContain('不在本场')
  })

  it('4 参数的 rel 写法不可判定（没有 to）', () => {
    const result = validateExitSource('rel("lin","trust",">=",0.5)', registry)
    expect(result.valid).toBe(false)
    expect(result.reasons[0]).toContain('rel 需要 5 个参数')
  })

  it('深度 > 5 拒绝', () => {
    let expr: ExitExpr = { op: 'beats', cmp: '>=', value: 1 }
    for (let index = 0; index < MAX_DEPTH; index += 1) expr = { op: 'not', of: expr }
    const result = validateExitAst(expr)
    expect(result.valid).toBe(false)
    expect(result.reasons.join('|')).toContain('深度')
  })

  it('节点数 > 20 拒绝', () => {
    // 3 个 all × 10 拍 + 外层 = 34 个节点；schema 允许（每个 all ≤10 子节点），D1 必须拦住。
    const group = (): ExitExpr => ({
      op: 'all',
      of: Array.from({ length: 10 }, () => ({ op: 'beats', cmp: '>=', value: 1 }) as ExitExpr)
    })
    const result = validateExitAst({ op: 'all', of: [group(), group(), group()] })
    expect(MAX_NODES).toBe(20)
    expect(result.valid).toBe(false)
    expect(result.reasons.join('|')).toContain('节点数')
  })

  it('beats 超过场景上限拒绝；0 拍拒绝', () => {
    expect(validateExitSource('beats(99)', registry).valid).toBe(false)
    expect(validateExitSource('beats(0)', registry).valid).toBe(false)
  })

  it('all/any 至少 2 个子表达式；not 恰好 1 个', () => {
    expect(validateExitSource('all(beats(1))').valid).toBe(false)
    expect(validateExitSource('not(beats(1),beats(2))').valid).toBe(false)
  })

  it('未知函数被拒', () => {
    expect(validateExitSource('until("scene ends")').valid).toBe(false)
  })

  it('支持 { dsl: ... } 包装与裸 AST 两种形态', () => {
    const wrapped = parseExitInput({ dsl: 'beats(3)' }, registry)
    expect(wrapped.valid).toBe(true)
    const bare = parseExitInput({ op: 'beats', cmp: '>=', value: 3 }, registry)
    expect(bare.valid).toBe(true)
    expect(exitAstFromJson({ dsl: { op: 'beats', cmp: '>=', value: 3 } })).toEqual({ op: 'beats', cmp: '>=', value: 3 })
  })

  it('文本能往返成同一种可读形式', () => {
    const result = validateExitSource('all(fact("black_box","location"), beats(2))', registry)
    expect(result.ast).not.toBeNull()
    expect(exitExpressionText(result.ast!)).toBe('all(fact("black_box", "location"), beats(2))')
  })
})

describe('出口 DSL 求值', () => {
  const base = {
    facts: [
      { subject: 'black_box', predicate: 'location', object: '祠堂供桌下面', validFromSeq: 1, validToSeq: null },
      { subject: 'black_box', predicate: 'owner', object: 'lin', validFromSeq: 20, validToSeq: null }
    ],
    edges: [
      { from: 'lin', to: 'yan', axis: 'trust', value: 0.7, sinceSeq: 1, validToSeq: null }
    ],
    beatCount: 6,
    asOfSeq: 10
  }

  it('fact：命中 / 未命中 / 未来事实不算', () => {
    const hit = evaluateExit({ op: 'fact', subject: 'black_box', predicate: 'location' }, base)
    expect(hit.satisfied).toBe(true)
    const miss = evaluateExit({ op: 'fact', subject: 'black_box', predicate: 'owner' }, base)
    expect(miss.satisfied).toBe(false)
    expect(miss.nodes[0]!.detail).toBe('没有有效事实')
  })

  it('fact 带 object 时精确匹配', () => {
    const hit = evaluateExit({ op: 'fact', subject: 'black_box', predicate: 'location', object: '祠堂供桌下面' }, base)
    expect(hit.satisfied).toBe(true)
    const miss = evaluateExit({ op: 'fact', subject: 'black_box', predicate: 'location', object: '书房' }, base)
    expect(miss.satisfied).toBe(false)
  })

  it('rel：比较数值，方向无关（双向边）', () => {
    expect(evaluateExit({ op: 'rel', from: 'lin', to: 'yan', axis: 'trust', cmp: '>=', value: 0.6 }, base).satisfied).toBe(true)
    expect(evaluateExit({ op: 'rel', from: 'yan', to: 'lin', axis: 'trust', cmp: '<', value: 0.6 }, base).satisfied).toBe(false)
    expect(evaluateExit({ op: 'rel', from: 'lin', to: 'yan', axis: 'tension', cmp: '>=', value: 0 }, base).satisfied).toBe(false)
  })

  it('beats：按本场已确认拍数比较', () => {
    expect(evaluateExit({ op: 'beats', cmp: '>=', value: 6 }, base).satisfied).toBe(true)
    expect(evaluateExit({ op: 'beats', cmp: '>', value: 6 }, base).satisfied).toBe(false)
  })

  it('all / any / not 的组合语义', () => {
    const all = evaluateExit(
      { op: 'all', of: [{ op: 'beats', cmp: '>=', value: 6 }, { op: 'fact', subject: 'black_box', predicate: 'location' }] },
      base
    )
    expect(all.satisfied).toBe(true)
    const any = evaluateExit(
      { op: 'any', of: [{ op: 'beats', cmp: '>=', value: 99 }, { op: 'fact', subject: 'black_box', predicate: 'location' }] },
      base
    )
    expect(any.satisfied).toBe(true)
    const not = evaluateExit({ op: 'not', of: { op: 'beats', cmp: '>=', value: 99 } }, base)
    expect(not.satisfied).toBe(true)
    expect(not.nodes.map((node) => node.op)).toContain('not')
  })
})
