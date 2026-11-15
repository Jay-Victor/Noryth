/**
 * SQLite 锁竞争的错误识别（DEV-PLAN §13.6「数据库锁」）。
 *
 * better-sqlite3 在 `busy_timeout`（5s）后抛 `SQLITE_BUSY` / `SQLITE_LOCKED`。
 * 这类错误不是内部 bug，而是「另一个进程正持有写锁」——对外统一成
 * `project_locked`，作者看到的是「项目已在另一窗口打开」，而不是 internal_error。
 */
export function isBusyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_BUSY_') || code.startsWith('SQLITE_LOCKED_')
}
