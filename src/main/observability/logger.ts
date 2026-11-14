import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'

export type Logger = pino.Logger

export function logFilePath(logDir: string): string {
  return join(logDir, 'app.log')
}

/**
 * JSONL 日志：只写事件与错误，不写正文、不写 Key。
 * pino redact 只是一道保险，业务代码本身不传敏感字段。
 */
export function createLogger(logDir: string, options: { level?: string } = {}): Logger {
  mkdirSync(logDir, { recursive: true })
  const destination = pino.destination({
    dest: logFilePath(logDir),
    sync: true,
    mkdir: true
  })
  return pino(
    {
      level: options.level ?? 'info',
      base: { app: 'noryth' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['apiKey', '*.apiKey', 'key', '*.key', 'authorization', '*.authorization'],
        censor: '[redacted]'
      }
    },
    destination
  )
}
