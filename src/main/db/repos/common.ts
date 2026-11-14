import type { Db } from '../project-db'
import { asQueryRunner, type QueryRunner } from '../kysely'
import { randomUUID } from 'node:crypto'

/** 可注入时钟：测试用固定时间，生产用系统时间。 */
export type Clock = () => string

export const systemClock: Clock = () => new Date().toISOString()

/** 与阶段 01 的 id 约定一致：前缀 + 16 位十六进制。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/**
 * repo 基类：Kysely 负责查询构造，better-sqlite3 负责同步执行。
 * 传入 Db 时自动建一个 QueryRunner；createRepos 会共享同一个实例。
 */
export abstract class BaseRepo {
  protected readonly runner: QueryRunner
  protected readonly now: Clock

  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    this.runner = asQueryRunner(input)
    this.now = now
  }
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0
}

export function intToBool(value: number): boolean {
  return value !== 0
}

/** 把字符串安全地放进单引号 SQL 字面量（只用于路径等无法参数化的场景）。 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
