import { AppError } from '../../shared/domain/app-error'
import type { FallbackResponse } from '../../shared/schema/envelope'
import { FallbackResponseSchema } from '../../shared/schema/envelope'

/**
 * JSON 回退协议（DEV-PLAN §7.6）。
 *
 * 模型不支持原生 tool calling 但支持 JSON mode 时，要求一次只输出一个对象：
 *   {"tool_calls":[{"tool":"<name>","args":{...}}],"final":null}
 *   {"tool_calls":[],"final":{"body":"...","grounding":[...]}}
 *
 * 解析失败带错误重问一次；连续 2 次 → tool_protocol_error，暂停任务。
 * 绝不把非 JSON 的输出当正文使用（不静默裸答）。
 */

export const FALLBACK_INSTRUCTION = [
  '你必须只输出一个 JSON 对象，形如：',
  '{"tool_calls":[{"tool":"<name>","args":{}}],"final":null}',
  '或',
  '{"tool_calls":[],"final":{"body":"<本拍正文>","grounding":[]}}',
  '不得输出 JSON 以外的任何字符。一次只允许一轮工具；拿到工具结果后再给 final。'
].join('\n')

export interface ProtocolParseFailure {
  ok: false
  reason: string
}

export function parseFallbackResponse(text: string): FallbackResponse {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new AppError('tool_protocol_error', 'fallback response is empty')
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new AppError('tool_protocol_error', 'fallback response is not JSON', {
      preview: trimmed.slice(0, 120)
    })
  }
  const parsed = FallbackResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('tool_protocol_error', 'fallback response shape is invalid', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.'))
    })
  }
  if (parsed.data.tool_calls.length === 0 && parsed.data.final === null) {
    throw new AppError('tool_protocol_error', 'fallback response has neither tool_calls nor final')
  }
  return parsed.data
}

export interface ProtocolLoopOptions<T> {
  /** 发一次请求；feedback 是上一次解析失败的原因，首次为 null。 */
  ask: (feedback: string | null) => Promise<string>
  parse: (text: string) => T
  /** 默认 2：首次 + 带错误重问一次。 */
  maxAttempts?: number
  onFailure?: (error: AppError, attempt: number) => void
}

export interface ProtocolLoopResult<T> {
  value: T
  attempts: number
}

export async function runJsonProtocol<T>(options: ProtocolLoopOptions<T>): Promise<ProtocolLoopResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
  let feedback: string | null = null
  let lastError: AppError | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const text = await options.ask(feedback)
    try {
      return { value: options.parse(text), attempts: attempt + 1 }
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError('tool_protocol_error', 'fallback parse failed', {
              message: error instanceof Error ? error.message : String(error)
            })
      lastError = appError
      options.onFailure?.(appError, attempt + 1)
      feedback = `上一次输出无法解析：${appError.message}。请只输出协议要求的 JSON 对象，不要输出其他字符。`
    }
  }

  throw lastError ?? new AppError('tool_protocol_error', 'fallback protocol failed')
}
