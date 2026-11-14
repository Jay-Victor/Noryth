/**
 * Token 估算的唯一实现在 `context/tokens.ts`（DEV-PLAN §7.4）。
 * 工具层从这里取，避免「预算」与「结果截断」两套口径。
 */
export { estimateTokens } from '../context/tokens'
