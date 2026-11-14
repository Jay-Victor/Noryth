/**
 * 错误码与作者可见文案的唯一来源。
 * 依据 docs/DEV-PLAN.md §18.2；新增错误码必须同时更新该表。
 * 原则：文案只回答「能不能继续」，原因写日志。
 */

export const ERROR_CODES = [
  'model_error',
  'model_auth',
  'rate_limit',
  'content_filter',
  'memory_empty',
  'context_trimmed',
  'storyboard_conflict',
  'character_refusal',
  'storyboard_exhausted',
  'file_conflict',
  'human_takeover',
  'tool_not_found',
  'tool_unavailable',
  'tool_protocol_error',
  'tool_budget_exceeded',
  'stale_revision',
  'gate_required',
  'gate_consumed',
  'invalid_args',
  'timeout',
  'invalid_grounding',
  'patch_conflict',
  'project_locked',
  'migration_checksum_mismatch',
  'isolation_violation',
  'context_overflow',
  'setup_incomplete',
  'already_finalized',
  'project_not_found',
  'project_create_failed',
  'vector_unavailable',
  'internal_error'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  model_error: '模型超时或不可用，已重试 2 次',
  model_auth: 'API Key 无效或过期',
  rate_limit: '供应商限流，请稍后再试',
  content_filter: '供应商拒绝了本次生成',
  memory_empty: '没有检索到可用记忆，本拍依据不足',
  context_trimmed: '上下文已裁剪（历史拍/检索条数）',
  storyboard_conflict: '分镜有冲突，无法开演',
  character_refusal: '角色拒演：{reason}',
  storyboard_exhausted: '分镜已用完但场景未收束',
  file_conflict: '正文文件被外部修改',
  human_takeover: '已修订 3 轮，转人工',
  tool_not_found: '工具不可用',
  tool_unavailable: '工具不可用，任务已暂停',
  tool_protocol_error: '模型无法按要求调用工具',
  tool_budget_exceeded: '本轮取材已达上限',
  stale_revision: '稿件已变更，请重新读取',
  gate_required: '需要作者确认',
  gate_consumed: '该确认已使用',
  invalid_args: '参数不合法',
  timeout: '查询超时，已返回部分结果',
  invalid_grounding: '依据校验失败，本拍未保存',
  patch_conflict: '原文已变，patch 未套用',
  project_locked: '项目已在另一窗口打开',
  migration_checksum_mismatch: '迁移文件被修改，无法启动',
  isolation_violation: '记忆隔离自检失败',
  context_overflow: '上下文超预算且无法裁剪',
  setup_incomplete: '角色库未建好，暂不能开演',
  already_finalized: '本章已定稿',
  project_not_found: '项目不存在或路径不可用',
  project_create_failed: '无法创建项目',
  vector_unavailable: '向量索引不可用，检索已降级',
  internal_error: '发生内部错误，请导出诊断包'
}

export function messageFor(code: ErrorCode, fallback?: string): string {
  return ERROR_MESSAGES[code] ?? fallback ?? code
}
