import type { Db } from './project-db'

/** better-sqlite3 的同步事务包装；嵌套调用会自动降级为 SAVEPOINT。 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)()
}
