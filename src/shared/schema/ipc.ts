import { z } from 'zod'
import { ERROR_CODES } from '../domain/errors'

/** 统一错误模型：renderer 永远不 catch 原始异常（DEV-PLAN §4.2）。 */
export const ErrorCodeSchema = z.enum(ERROR_CODES)

export const IpcErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional()
})

export type IpcError = z.infer<typeof IpcErrorSchema>
export type IpcSuccess<T> = { ok: true; data: T }
export type IpcFailure = { ok: false; error: IpcError }
export type IpcResult<T> = IpcSuccess<T> | IpcFailure

/** 每个请求带 requestId，便于日志与迟到结果归因。 */
export const IpcRequest = <T extends z.ZodTypeAny>(payload: T) =>
  z.strictObject({ requestId: z.string().min(1).max(120), payload })

export type IpcRequestOf<T extends z.ZodTypeAny> = z.infer<ReturnType<typeof IpcRequest<T>>>

export const ok = <T>(data: T): IpcSuccess<T> => ({ ok: true, data })
export const fail = (error: IpcError): IpcFailure => ({ ok: false, error })

export { IPC, IPC_EVENTS } from '../ipc-channels'
export type { IpcChannel, IpcEventChannel } from '../ipc-channels'
