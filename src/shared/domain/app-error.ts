import type { ErrorCode } from './errors'
import { messageFor } from './errors'
import type { IpcError } from '../schema/ipc'

/**
 * 主进程内部错误：携带机器可读 code 与可进日志的技术细节。
 * 渲染层只看到 ERROR_MESSAGES 里的作者文案，细节留在日志与诊断包。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  toIpcError(): IpcError {
    return {
      code: this.code,
      message: messageFor(this.code),
      details: this.details
    }
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
