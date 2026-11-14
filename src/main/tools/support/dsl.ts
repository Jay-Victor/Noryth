/**
 * 出口 DSL（PRD §4.10 T28 / DEV-PLAN §8.4）：
 *   fact("subject","predicate"[,"object"])
 *   rel("from","trust"|"intimacy"|"tension",">="|"<="|">"|"<"|"==",0.6)
 *   beats(12)
 *   all(expr, ...) / any(expr, ...) / not(expr)
 *
 * 只接受 AST 可判定表达式；自然语言直接拒绝（不做模糊解析）。
 */

export interface DslValidation {
  valid: boolean
  machine_decidable: boolean
  reasons: string[]
}

const PREDICATES = new Set(['fact', 'rel', 'beats'])
const COMBINATORS = new Set(['all', 'any', 'not'])
const AXES = new Set(['trust', 'intimacy', 'tension'])
const OPS = new Set(['>=', '<=', '>', '<', '=='])

type Token =
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'punct'; value: string; pos: number }

class DslError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const ch = input[index]!
    if (/\s/.test(ch)) {
      index += 1
      continue
    }
    if (ch === '"') {
      let value = ''
      index += 1
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\' && index + 1 < input.length) {
          value += input[index + 1]
          index += 2
          continue
        }
        value += input[index]
        index += 1
      }
      if (input[index] !== '"') throw new DslError(`第 ${index} 位字符串未闭合`)
      index += 1
      tokens.push({ kind: 'string', value, pos: index })
      continue
    }
    const numberMatch = /^-?\d+(?:\.\d+)?/.exec(input.slice(index))
    if (numberMatch) {
      tokens.push({ kind: 'number', value: Number(numberMatch[0]), pos: index })
      index += numberMatch[0].length
      continue
    }
    const opMatch = /^(?:>=|<=|==|>|<)/.exec(input.slice(index))
    if (opMatch) {
      tokens.push({ kind: 'op', value: opMatch[0], pos: index })
      index += opMatch[0].length
      continue
    }
    const identMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(index))
    if (identMatch) {
      tokens.push({ kind: 'ident', value: identMatch[0], pos: index })
      index += identMatch[0].length
      continue
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: 'punct', value: ch, pos: index })
      index += 1
      continue
    }
    throw new DslError(`第 ${index} 位出现不支持的字符「${ch}」`)
  }
  return tokens
}

type Arg =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'call'; value: CallNode }

interface CallNode {
  fn: string
  args: Arg[]
}

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}

  parseExpression(): CallNode {
    const node = this.parseCall()
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!
      throw new DslError(`第 ${token.pos} 位有多余内容`)
    }
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private take(): Token {
    const token = this.tokens[this.index]
    if (!token) throw new DslError('表达式意外结束')
    this.index += 1
    return token
  }

  private expectPunct(value: string): void {
    const token = this.take()
    if (token.kind !== 'punct' || token.value !== value) {
      throw new DslError(`第 ${token.pos} 位期望「${value}」`)
    }
  }

  private parseCall(): CallNode {
    const head = this.take()
    if (head.kind !== 'ident') throw new DslError(`第 ${head.pos} 位期望函数名`)
    this.expectPunct('(')
    const args: Arg[] = []
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ')') {
      this.take()
      return { fn: head.value, args }
    }
    for (;;) {
      args.push(this.parseArg())
      const token = this.take()
      if (token.kind === 'punct' && token.value === ')') break
      if (!(token.kind === 'punct' && token.value === ',')) {
        throw new DslError(`第 ${token.pos} 位期望「,」或「)」`)
      }
    }
    return { fn: head.value, args }
  }

  private parseArg(): Arg {
    const token = this.take()
    if (token.kind === 'string') return { kind: 'string', value: token.value }
    if (token.kind === 'number') return { kind: 'number', value: token.value }
    if (token.kind === 'ident') {
      // 函数调用：ident 后面紧跟 '('
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.index -= 1
        return { kind: 'call', value: this.parseCall() }
      }
      return { kind: 'ident', value: token.value }
    }
    if (token.kind === 'op') return { kind: 'ident', value: token.value }
    throw new DslError(`第 ${token.pos} 位期望参数`)
  }
}

function validateNode(node: CallNode, reasons: string[]): void {
  if (!PREDICATES.has(node.fn) && !COMBINATORS.has(node.fn)) {
    reasons.push(`未知函数 ${node.fn}`)
    return
  }
  if (node.fn === 'fact') {
    if (node.args.length < 2 || node.args.length > 3) reasons.push('fact 需要 2–3 个字符串参数')
    for (const arg of node.args) if (arg.kind !== 'string' || arg.value.length === 0) reasons.push('fact 的参数必须是非空字符串')
    return
  }
  if (node.fn === 'rel') {
    if (node.args.length !== 4) {
      reasons.push('rel 需要 4 个参数：from, axis, op, value')
      return
    }
    const [from, axis, op, value] = node.args
    if (from?.kind !== 'string' || from.value.length === 0) reasons.push('rel 的 from 必须是非空字符串')
    if (axis?.kind !== 'ident' || !AXES.has(axis.value)) reasons.push('rel 的 axis 必须是 trust/intimacy/tension')
    if (op?.kind !== 'ident' || !OPS.has(op.value)) reasons.push('rel 的 op 必须是 >=/<=/>/</==')
    if (value?.kind !== 'number' || !Number.isFinite(value.value)) reasons.push('rel 的 value 必须是数字')
    return
  }
  if (node.fn === 'beats') {
    if (node.args.length !== 1 || node.args[0]?.kind !== 'number' || !Number.isFinite(node.args[0].value)) {
      reasons.push('beats 需要 1 个数字参数')
    }
    return
  }
  if (node.fn === 'not') {
    if (node.args.length !== 1 || node.args[0]?.kind !== 'call') reasons.push('not 需要 1 个子表达式')
    for (const arg of node.args) if (arg.kind === 'call') validateNode(arg.value, reasons)
    return
  }
  // all / any
  if (node.args.length === 0) reasons.push(`${node.fn} 至少需要 1 个子表达式`)
  for (const arg of node.args) {
    if (arg.kind !== 'call') reasons.push(`${node.fn} 的参数必须是子表达式`)
    else validateNode(arg.value, reasons)
  }
}

export function validateExitExpr(expr: string): DslValidation {
  const trimmed = expr.trim()
  if (trimmed.length === 0) return { valid: false, machine_decidable: false, reasons: ['表达式为空'] }
  if (trimmed.length > 500) return { valid: false, machine_decidable: false, reasons: ['表达式超过 500 字符'] }

  let node: CallNode
  try {
    node = new Parser(tokenize(trimmed)).parseExpression()
  } catch (error) {
    const reason = error instanceof DslError ? error.message : '表达式无法解析'
    return { valid: false, machine_decidable: false, reasons: [reason] }
  }

  const reasons: string[] = []
  validateNode(node, reasons)
  return { valid: reasons.length === 0, machine_decidable: reasons.length === 0, reasons }
}
