import { validateExitSource } from '../../../shared/dsl/exit'

/**
 * T28 `exit_dsl.validate` 的入口（PRD §4.10 / DEV-PLAN §8.4）。
 *
 * 语法与 AST 校验在 `shared/dsl/exit.ts`；这里只把结果收敛成 T28 的输出形状，
 * 保证「工具说 valid 的表达式，调度器一定解析得了」。
 */

export interface DslValidation {
  valid: boolean
  machine_decidable: boolean
  reasons: string[]
}

export function validateExitExpr(expr: string): DslValidation {
  const result = validateExitSource(expr)
  return {
    valid: result.valid,
    machine_decidable: result.machine_decidable,
    reasons: result.reasons.length > 0 ? result.reasons : result.warnings
  }
}
