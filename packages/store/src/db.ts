import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * 打开 SQLite 连接。桌面单进程场景，WAL + NORMAL 是写入延迟与安全的平衡点；
 * foreign_keys 必须显式打开（SQLite 默认是关的）。
 */
export function openDatabase(file: string, options: OpenOptions = {}): Db {
  const db = new Database(file, { readonly: options.readonly ?? false });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

export function closeDatabase(db: Db): void {
  if (db.open) db.close();
}
