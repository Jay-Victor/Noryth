/**
 * 出口 DSL 的 main 侧入口。
 *
 * 语法、AST、校验与求值都在 `src/shared/dsl/exit.ts`（纯 TS，renderer 也能用）；
 * 这里只 re-export，避免调度器与工具层各拿一份实现。
 */
export {
  EXIT_CMP,
  RELATION_AXES,
  ExitCmpSchema,
  RelationAxisSchema,
  FactExprSchema,
  RelExprSchema,
  BeatsExprSchema,
  ExitExprSchema,
  MAX_DEPTH,
  MAX_NODES,
  validateExitAst,
  evaluateExit,
  exitAstFromJson,
  exitExpressionText,
  exitAstFromCall,
  validateExitSource,
  parseExitInput
} from '../../shared/dsl/exit'

export type {
  ExitCmp,
  RelationAxis,
  ExitExpr,
  ExitAst,
  ExitRegistry,
  ExitValidation,
  ExitFactView,
  ExitEdgeView,
  ExitEvalContext,
  ExitEvalNode,
  ExitEvaluation
} from '../../shared/dsl/exit'
