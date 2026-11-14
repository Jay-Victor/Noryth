/**
 * 出口 DSL 的词法与语法（PRD §4.10 T28 / DEV-PLAN §8.4）。
 *
 * 唯一一份语法实现：工具层（T28）与调度器（G2 / 收束求值）都走这里，
 * 避免「校验通过但调度器解析不了」的第二套真源。
 *
 * 语法：
 *   fact("subject", "predicate") | fact("subject", "predicate", "object")
 *   rel("from", "to", "trust"|"intimacy"|"tension", ">=", 0.6)
 *   beats(12)
 *   all(expr, expr, ...) / any(expr, ...) / not(expr)
 *
 * 只接受这六个函数名；自然语言（没有函数调用结构）在 tokenize/parse 阶段失败。
 */

export type Token =
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'punct'; value: string; pos: number }

export class DslSyntaxError extends Error {}

export function tokenizeDsl(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const ch = input[index]!
    if (/\s/.test(ch)) {
      index += 1
      continue
    }
    if (ch === '"' || ch === '“' || ch === '「') {
      const closer = ch === '"' ? '"' : ch === '“' ? '”' : '」'
      let value = ''
      index += 1
      while (index < input.length && input[index] !== closer) {
        if (input[index] === '\\' && index + 1 < input.length) {
          value += input[index + 1]
          index += 2
          continue
        }
        value += input[index]
        index += 1
      }
      if (input[index] !== closer) throw new DslSyntaxError(`第 ${index} 位字符串未闭合`)
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
    const opMatch = /^(?:>=|<=|==|!=|>|<)/.exec(input.slice(index))
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
    throw new DslSyntaxError(`第 ${index} 位出现不支持的字符「${ch}」`)
  }
  return tokens
}

export type DslArg =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'call'; value: DslCall }

export interface DslCall {
  fn: string
  args: DslArg[]
}

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}

  parseExpression(): DslCall {
    const node = this.parseCall()
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!
      throw new DslSyntaxError(`第 ${token.pos} 位有多余内容`)
    }
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private take(): Token {
    const token = this.tokens[this.index]
    if (!token) throw new DslSyntaxError('表达式意外结束')
    this.index += 1
    return token
  }

  private expectPunct(value: string): void {
    const token = this.take()
    if (token.kind !== 'punct' || token.value !== value) {
      throw new DslSyntaxError(`第 ${token.pos} 位期望「${value}」`)
    }
  }

  private parseCall(): DslCall {
    const head = this.take()
    if (head.kind !== 'ident') throw new DslSyntaxError(`第 ${head.pos} 位期望函数名`)
    this.expectPunct('(')
    const args: DslArg[] = []
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ')') {
      this.take()
      return { fn: head.value, args }
    }
    for (;;) {
      args.push(this.parseArg())
      const token = this.take()
      if (token.kind === 'punct' && token.value === ')') break
      if (!(token.kind === 'punct' && token.value === ',')) {
        throw new DslSyntaxError(`第 ${token.pos} 位期望「,」或「)」`)
      }
    }
    return { fn: head.value, args }
  }

  private parseArg(): DslArg {
    const token = this.take()
    if (token.kind === 'string') return { kind: 'string', value: token.value }
    if (token.kind === 'number') return { kind: 'number', value: token.value }
    if (token.kind === 'ident') {
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.index -= 1
        return { kind: 'call', value: this.parseCall() }
      }
      return { kind: 'ident', value: token.value }
    }
    if (token.kind === 'op') return { kind: 'ident', value: token.value }
    throw new DslSyntaxError(`第 ${token.pos} 位期望参数`)
  }
}

export function parseDsl(input: string): DslCall {
  return new Parser(tokenizeDsl(input)).parseExpression()
}
