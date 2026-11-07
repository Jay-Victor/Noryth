/** 统一错误类型：CLI 退出码由 code 决定（04-ui.md §10.3）。 */

export type ErrorCode =
  | 'usage' // 2
  | 'constraint' // 3
  | 'model' // 4
  | 'human' // 5
  | 'budget' // 6
  | 'io' // 1
  | 'schema'; // 1

export class NorythError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = 'NorythError';
  }
}

/** 数据库拒绝：约束/触发器/唯一索引。constraint 是 ck_* 名（能取到时）。 */
export class ConstraintError extends NorythError {
  constructor(
    message: string,
    constraint?: string,
  ) {
    super(message, 'constraint', constraint);
    this.name = 'ConstraintError';
  }
}

export class UsageError extends NorythError {
  constructor(message: string) {
    super(message, 'usage');
    this.name = 'UsageError';
  }
}

export class IoError extends NorythError {
  constructor(message: string) {
    super(message, 'io');
    this.name = 'IoError';
  }
}

export class SchemaVersionError extends NorythError {
  constructor(message: string) {
    super(message, 'schema');
    this.name = 'SchemaVersionError';
  }
}

const CK_PATTERN = /\b(ck_[a-z0-9_]+)\b/i;

/** 从任意 SQLite 错误里取出 ck_* 名；取不到返回 null。 */
export function constraintNameOf(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return CK_PATTERN.exec(message)?.[1] ?? null;
}

/** better-sqlite3 的完整性错误码形如 SQLITE_CONSTRAINT_TRIGGER。 */
export function isSqliteConstraint(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** better-sqlite3 的触发器报错形如 "ck_event_immutable: 事件日志只追加，不修改"。 */
export function asConstraintError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const name = constraintNameOf(error);
  if (name) throw new ConstraintError(message, name);
  throw error;
}
