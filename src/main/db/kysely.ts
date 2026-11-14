import { Kysely, SqliteDialect, type CompiledQuery } from 'kysely'
import type { Db } from './project-db'
import type { Database } from './schema'

/**
 * Kysely 只负责查询构造与类型；执行仍走 better-sqlite3 的同步 API。
 *
 * 原因（DEV-PLAN §5.2）：单连接、单写队列、同步事务是数据层的核心约束。
 * Kysely 的标准执行器是 Promise API，会在 `withTransaction(() => ...)` 里
 * 把同步事务变成异步，破坏 commitBeat 的原子边界；因此这里用 `compile()`
 * 拿到 SQL + 参数，再由 better-sqlite3 同步执行。迁移、PRAGMA、VACUUM 仍用原生 SQL。
 */
export type KyselyDb = Kysely<Database>

export class QueryRunner {
  readonly db: KyselyDb

  constructor(readonly raw: Db) {
    this.db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: raw })
    })
  }
}

export function createQueryRunner(raw: Db): QueryRunner {
  return new QueryRunner(raw)
}

export function asQueryRunner(input: Db | QueryRunner): QueryRunner {
  return input instanceof QueryRunner ? input : new QueryRunner(input)
}

export interface CompilableQuery {
  compile(): CompiledQuery
}

export function allRows<O>(runner: QueryRunner, query: CompilableQuery): O[] {
  const { sql, parameters } = query.compile()
  return runner.raw.prepare(sql).all(...parameters) as O[]
}

export function firstRow<O>(runner: QueryRunner, query: CompilableQuery): O | undefined {
  const { sql, parameters } = query.compile()
  return runner.raw.prepare(sql).get(...parameters) as O | undefined
}

export function runStatement(
  runner: QueryRunner,
  query: CompilableQuery
): { changes: number | bigint; lastInsertRowid: number | bigint } {
  const { sql, parameters } = query.compile()
  return runner.raw.prepare(sql).run(...parameters) as {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }
}
