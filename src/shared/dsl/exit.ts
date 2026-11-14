import { z } from 'zod'
import { DslSyntaxError, parseDsl, type DslCall } from './parse'

/**
 * 出口 DSL（PRD §4.10 T28 / DEV-PLAN §8.4）。
 *
 * 只接受 JSON AST：
 *   { op: 'fact', subject, predicate, object? }
 *   { op: 'rel', from, to, axis, cmp, value }
 *   { op: 'beats', cmp, value }
 *   { op: 'all' | 'any', of: ExitExpr[] }
 *   { op: 'not', of: ExitExpr }
 *
 * 求值只查事实、关系边与拍数；不调模型、不做自然语言解析。
 * 自然语言出口在解析阶段就失败（`valid: false`），这是「无法收束」的唯一防线。
 */

export const EXIT_CMP = ['>=', '>', '<=', '<', '==', '!='] as const
export type ExitCmp = (typeof EXIT_CMP)[number]

export const RELATION_AXES = ['trust', 'intimacy', 'tension'] as const
export type RelationAxis = (typeof RELATION_AXES)[number]

export type ExitExpr =
  | { op: 'fact'; subject: string; predicate: string; object?: string }
  | { op: 'rel'; from: string; to: string; axis: RelationAxis; cmp: ExitCmp; value: number }
  | { op: 'beats'; cmp: ExitCmp; value: number }
  | { op: 'all'; of: ExitExpr[] }
  | { op: 'any'; of: ExitExpr[] }
  | { op: 'not'; of: ExitExpr }

export const ExitCmpSchema = z.enum(EXIT_CMP)
export const RelationAxisSchema = z.enum(RELATION_AXES)

export const FactExprSchema = z.strictObject({
  op: z.literal('fact'),
  subject: z.string().min(1).max(120),
  predicate: z.string().min(1).max(80),
  object: z.string().min(1).max(200).optional()
})

export const RelExprSchema = z.strictObject({
  op: z.literal('rel'),
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  axis: RelationAxisSchema,
  cmp: ExitCmpSchema,
  value: z.number().min(-1).max(1)
})

export const BeatsExprSchema = z.strictObject({
  op: z.literal('beats'),
  cmp: ExitCmpSchema,
  value: z.number().int().min(0).max(10_000)
})

export type ExitAst = ExitExpr

export const ExitExprSchema: z.ZodType<ExitExpr> = z.lazy(() =>
  z.union([
    FactExprSchema,
    RelExprSchema,
    BeatsExprSchema,
    z.strictObject({ op: z.literal('all'), of: z.array(ExitExprSchema).min(2).max(10) }),
    z.strictObject({ op: z.literal('any'), of: z.array(ExitExprSchema).min(2).max(10) }),
    z.strictObject({ op: z.literal('not'), of: ExitExprSchema })
  ])
)

export const MAX_DEPTH = 5
export const MAX_NODES = 20

export interface ExitRegistry {
  /** 合法实体：角色 / 地点 / 道具 / 概念。缺省时不做 D3 检查。 */
  entities?: ReadonlySet<string>
  /** 合法谓词。缺省时不做 D4 检查。 */
  predicates?: ReadonlySet<string>
  /** 场景在场者（rel 的 from/to 必须在此集合内）。 */
  participants?: ReadonlySet<string>
  /** 场景拍数上限（beats 的边界）。 */
  maxBeats?: number
}

export interface ExitValidation {
  valid: boolean
  machine_decidable: boolean
  reasons: string[]
  warnings: string[]
  /** 纯 beats 出口：可判定但不能表达剧情收束，标告警。 */
  beats_only: boolean
  ast: ExitExpr | null
}

function invalid(reasons: string[], warnings: string[] = [], beatsOnly = false): ExitValidation {
  return { valid: false, machine_decidable: false, reasons, warnings, beats_only: beatsOnly, ast: null }
}

function countNodes(expr: ExitExpr): number {
  if (expr.op === 'all' || expr.op === 'any') {
    return 1 + expr.of.reduce((sum, child) => sum + countNodes(child), 0)
  }
  if (expr.op === 'not') return 1 + countNodes(expr.of)
  return 1
}

function depthOf(expr: ExitExpr): number {
  if (expr.op === 'all' || expr.op === 'any') {
    return 1 + Math.max(0, ...expr.of.map((child) => depthOf(child)))
  }
  if (expr.op === 'not') return 1 + depthOf(expr.of)
  return 1
}

function hasEventLeaf(expr: ExitExpr): boolean {
  if (expr.op === 'fact' || expr.op === 'rel') return true
  if (expr.op === 'beats') return false
  if (expr.op === 'not') return hasEventLeaf(expr.of)
  return expr.of.some((child) => hasEventLeaf(child))
}

/**
 * 结构校验（D1/D2/D5/D7）与可判定性（D3/D4/D6/D8）。
 *
 * - `valid` 只看结构与值域：不合法就是写错了；
 * - `machine_decidable` 还要求实体/谓词/在场者已在项目里登记：
 *   未登记的引用不算写错，但调度器无法求值，G2 必须拦住。
 */
export function validateExitAst(input: unknown, registry?: ExitRegistry): ExitValidation {
  const parsed = ExitExprSchema.safeParse(input)
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'expr'}: ${issue.message}`))
  }
  const ast = parsed.data
  const reasons: string[] = []
  const warnings: string[] = []

  const depth = depthOf(ast)
  if (depth > MAX_DEPTH) reasons.push(`表达式深度 ${depth} 超过 ${MAX_DEPTH}`)
  const nodes = countNodes(ast)
  if (nodes > MAX_NODES) reasons.push(`表达式节点数 ${nodes} 超过 ${MAX_NODES}`)
  if (ast.op === 'beats' && ast.value < 1) reasons.push('beats 的拍数必须 ≥ 1')
  if (ast.op === 'beats' && registry?.maxBeats !== undefined && ast.value > registry.maxBeats) {
    reasons.push(`beats(${ast.value}) 超过本场拍数上限 ${registry.maxBeats}`)
  }

  const beatsOnly = !hasEventLeaf(ast)
  if (beatsOnly) warnings.push('beats_only：出口只有拍数条件，无法表达剧情收束')

  const undecidable: string[] = []
  const walk = (expr: ExitExpr): void => {
    if (expr.op === 'fact') {
      if (registry?.entities && !registry.entities.has(expr.subject)) {
        undecidable.push(`实体「${expr.subject}」未登记`)
      }
      if (registry?.predicates && !registry.predicates.has(expr.predicate)) {
        undecidable.push(`谓词「${expr.predicate}」未登记`)
      }
      return
    }
    if (expr.op === 'rel') {
      if (registry?.participants) {
        if (!registry.participants.has(expr.from)) undecidable.push(`关系主体「${expr.from}」不在本场`)
        if (!registry.participants.has(expr.to)) undecidable.push(`关系对象「${expr.to}」不在本场`)
      }
      return
    }
    if (expr.op === 'beats') return
    if (expr.op === 'not') {
      walk(expr.of)
      return
    }
    for (const child of expr.of) walk(child)
  }
  walk(ast)

  const reasonsAll = reasons.length === 0 ? undecidable : reasons
  return {
    valid: reasons.length === 0,
    machine_decidable: reasons.length === 0 && undecidable.length === 0,
    reasons: reasonsAll,
    warnings,
    beats_only: beatsOnly,
    ast
  }
}

export interface ExitFactView {
  subject: string
  predicate: string
  object: string
  truth?: string
  validFromSeq: number
  validToSeq: number | null
}

export interface ExitEdgeView {
  from: string
  to: string
  axis: string
  value: number
  sinceSeq: number
  validToSeq: number | null
}

export interface ExitEvalContext {
  facts: readonly ExitFactView[]
  edges: readonly ExitEdgeView[]
  /** 本场已确认的拍数（DEV-PLAN §8.4：beats 只数本场）。 */
  beatCount: number
  /** 当前叙事序；事实与关系边按 as_of 过滤。 */
  asOfSeq: number
}

export interface ExitEvalNode {
  op: ExitExpr['op']
  label: string
  satisfied: boolean
  detail?: string
}

export interface ExitEvaluation {
  satisfied: boolean
  nodes: ExitEvalNode[]
}

function compare(left: number, cmp: ExitCmp, right: number): boolean {
  switch (cmp) {
    case '>=':
      return left >= right
    case '>':
      return left > right
    case '<=':
      return left <= right
    case '<':
      return left < right
    case '==':
      return left === right
    case '!=':
      return left !== right
  }
}

function activeFact(fact: ExitFactView, asOf: number): boolean {
  if (fact.validFromSeq > asOf) return false
  if (fact.validToSeq !== null && fact.validToSeq < asOf) return false
  return true
}

function activeEdge(edge: ExitEdgeView, asOf: number): boolean {
  if (edge.sinceSeq > asOf) return false
  if (edge.validToSeq !== null && edge.validToSeq < asOf) return false
  return true
}

/**
 * 求值（纯函数）：只读事实、关系边与拍数。
 * `details` 记录每个叶节点的判定，UI 用它解释「为什么还没收束」。
 */
export function evaluateExit(ast: ExitExpr, context: ExitEvalContext): ExitEvaluation {
  const nodes: ExitEvalNode[] = []
  const walk = (expr: ExitExpr): boolean => {
    if (expr.op === 'fact') {
      const matched = context.facts.filter(
        (fact) =>
          activeFact(fact, context.asOfSeq) &&
          fact.subject === expr.subject &&
          fact.predicate === expr.predicate &&
          (expr.object === undefined || fact.object === expr.object)
      )
      const satisfied = matched.length > 0
      nodes.push({
        op: 'fact',
        label: `${expr.subject}.${expr.predicate}${expr.object === undefined ? '' : `=${expr.object}`}`,
        satisfied,
        detail: satisfied ? matched[0]!.object : '没有有效事实'
      })
      return satisfied
    }
    if (expr.op === 'rel') {
      const edge = context.edges.find(
        (item) =>
          activeEdge(item, context.asOfSeq) &&
          item.axis === expr.axis &&
          ((item.from === expr.from && item.to === expr.to) || (item.from === expr.to && item.to === expr.from))
      )
      const value = edge?.value ?? 0
      const satisfied = edge !== undefined && compare(value, expr.cmp, expr.value)
      nodes.push({
        op: 'rel',
        label: `${expr.from}↔${expr.to}.${expr.axis}`,
        satisfied,
        detail: edge ? `${value} ${expr.cmp} ${expr.value}` : '没有有效关系边'
      })
      return satisfied
    }
    if (expr.op === 'beats') {
      const satisfied = compare(context.beatCount, expr.cmp, expr.value)
      nodes.push({
        op: 'beats',
        label: `beats ${expr.cmp} ${expr.value}`,
        satisfied,
        detail: `本场 ${context.beatCount} 拍`
      })
      return satisfied
    }
    if (expr.op === 'not') {
      const satisfied = !walk(expr.of)
      nodes.push({ op: 'not', label: 'not', satisfied })
      return satisfied
    }
    const results = expr.of.map((child) => walk(child))
    const satisfied = expr.op === 'all' ? results.every(Boolean) : results.some(Boolean)
    nodes.push({ op: expr.op, label: expr.op, satisfied })
    return satisfied
  }
  return { satisfied: walk(ast), nodes }
}

/** 读取存库的 `scene.exit_json`：支持 `{ dsl: ExitExpr }` 与裸 AST 两种形态。 */
export function exitAstFromJson(raw: unknown): ExitExpr | null {
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as { dsl?: unknown }
  const source = candidate.dsl !== undefined ? candidate.dsl : raw
  const parsed = ExitExprSchema.safeParse(source)
  return parsed.success ? parsed.data : null
}

export function exitExpressionText(expr: ExitExpr): string {
  switch (expr.op) {
    case 'fact':
      return `fact(${[expr.subject, expr.predicate, expr.object]
        .filter((part): part is string => typeof part === 'string')
        .map((part) => JSON.stringify(part))
        .join(', ')})`
    case 'rel':
      return `rel(${JSON.stringify(expr.from)}, ${JSON.stringify(expr.to)}, ${expr.axis}, ${expr.cmp}, ${expr.value})`
    case 'beats':
      return `beats(${expr.value})`
    case 'not':
      return `not(${exitExpressionText(expr.of)})`
    case 'all':
      return `all(${expr.of.map(exitExpressionText).join(', ')})`
    case 'any':
      return `any(${expr.of.map(exitExpressionText).join(', ')})`
  }
}

const CALL_OPS = new Set(['fact', 'rel', 'beats', 'all', 'any', 'not'])

/**
 * 文本 DSL → AST。
 *
 * `rel` 必须是 5 个参数（from, to, axis, cmp, value）；4 参数的老写法仍然
 * 语法合法，但无法求值（没有 to），因此不算 machine_decidable。
 */
export function exitAstFromCall(call: DslCall): { ast: ExitExpr | null; reasons: string[] } {
  if (!CALL_OPS.has(call.fn)) return { ast: null, reasons: [`未知函数 ${call.fn}`] }
  if (call.fn === 'fact') {
    if (call.args.length < 2 || call.args.length > 3) {
      return { ast: null, reasons: ['fact 需要 2–3 个字符串参数'] }
    }
    const strings = call.args.map((arg) => (arg.kind === 'string' ? arg.value : null))
    if (strings.some((value) => value === null || value.length === 0)) {
      return { ast: null, reasons: ['fact 的参数必须是非空字符串'] }
    }
    return { ast: { op: 'fact', subject: strings[0]!, predicate: strings[1]!, ...(strings[2] ? { object: strings[2] } : {}) }, reasons: [] }
  }
  if (call.fn === 'rel') {
    if (call.args.length !== 5) {
      return {
        ast: null,
        reasons: ['rel 需要 5 个参数：from, to, axis, cmp, value（4 参数写法不可判定）']
      }
    }
    const [from, to, axis, cmp, value] = call.args
    const reasons: string[] = []
    if (from?.kind !== 'string' || from.value.length === 0) reasons.push('rel 的 from 必须是非空字符串')
    if (to?.kind !== 'string' || to.value.length === 0) reasons.push('rel 的 to 必须是非空字符串')
    const axisValue = axis && (axis.kind === 'ident' || axis.kind === 'string') ? axis.value : null
    const cmpValue = cmp && (cmp.kind === 'ident' || cmp.kind === 'string') ? cmp.value : null
    if (axisValue === null || !(RELATION_AXES as readonly string[]).includes(axisValue)) {
      reasons.push('rel 的 axis 必须是 trust/intimacy/tension')
    }
    if (cmpValue === null || !(EXIT_CMP as readonly string[]).includes(cmpValue)) {
      reasons.push('rel 的 cmp 必须是 >=/<=/>/</==/!=')
    }
    if (value?.kind !== 'number' || !Number.isFinite(value.value)) reasons.push('rel 的 value 必须是数字')
    if (reasons.length > 0) return { ast: null, reasons }
    return {
      ast: {
        op: 'rel',
        from: (from as { value: string }).value,
        to: (to as { value: string }).value,
        axis: axisValue as RelationAxis,
        cmp: cmpValue as ExitCmp,
        value: (value as { value: number }).value
      },
      reasons: []
    }
  }
  if (call.fn === 'beats') {
    if (call.args.length !== 1 || call.args[0]?.kind !== 'number' || !Number.isFinite(call.args[0].value)) {
      return { ast: null, reasons: ['beats 需要 1 个数字参数'] }
    }
    return { ast: { op: 'beats', cmp: '>=', value: call.args[0].value }, reasons: [] }
  }
  if (call.fn === 'not') {
    if (call.args.length !== 1 || call.args[0]?.kind !== 'call') {
      return { ast: null, reasons: ['not 需要 1 个子表达式'] }
    }
    const inner = exitAstFromCall(call.args[0].value)
    if (!inner.ast) return inner
    return { ast: { op: 'not', of: inner.ast }, reasons: [] }
  }
  // all / any
  if (call.args.length < 2) {
    return { ast: null, reasons: [`${call.fn} 至少需要 2 个子表达式`] }
  }
  const children: ExitExpr[] = []
  for (const arg of call.args) {
    if (arg.kind !== 'call') return { ast: null, reasons: [`${call.fn} 的参数必须是子表达式`] }
    const inner = exitAstFromCall(arg.value)
    if (!inner.ast) return inner
    children.push(inner.ast)
  }
  return { ast: { op: call.fn as 'all' | 'any', of: children }, reasons: [] }
}

/** 文本 DSL → 校验结果（G2 与 T28 共用）。 */
export function validateExitSource(source: string, registry?: ExitRegistry): ExitValidation {
  const trimmed = source.trim()
  if (trimmed.length === 0) return invalid(['表达式为空'])
  if (trimmed.length > 500) return invalid(['表达式超过 500 字符'])
  let call: DslCall
  try {
    call = parseDsl(trimmed)
  } catch (error) {
    return invalid([error instanceof DslSyntaxError ? error.message : '表达式无法解析'])
  }
  const converted = exitAstFromCall(call)
  if (!converted.ast) return invalid(converted.reasons)
  return validateExitAst(converted.ast, registry)
}

/**
 * 出口条件的统一入口：文本或 JSON AST 都接受。
 * `scene.exit_json` 允许 `{ dsl: ... }` 包装；两种历史形态都兼容。
 */
export function parseExitInput(input: unknown, registry?: ExitRegistry): ExitValidation {
  if (typeof input === 'string') return validateExitSource(input, registry)
  if (input === null || input === undefined) return invalid(['出口条件为空'])
  if (typeof input === 'object' && !Array.isArray(input)) {
    const candidate = input as { dsl?: unknown }
    if (candidate.dsl !== undefined) {
      const inner = candidate.dsl
      if (typeof inner === 'string') return validateExitSource(inner, registry)
      return validateExitAst(inner, registry)
    }
  }
  return validateExitAst(input, registry)
}

