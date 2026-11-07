import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SchemaVersionError } from './errors.js';
import type { Db } from './db.js';

/** 与 docs/02-schema.sql 的 PRAGMA user_version 一致。 */
export const SCHEMA_VERSION = 1;

const SCHEMA_REL = path.join('docs', '02-schema.sql');

function walk(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, SCHEMA_REL);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * docs/02-schema.sql 是唯一权威，不复制一份到包内——复制就会漂移。
 * 解析顺序：NORYTH_SCHEMA → 从 cwd 向上 → 从模块目录向上（安装后仍能找到仓库根）。
 */
export function findSchemaPath(): string {
  const fromEnv = process.env.NORYTH_SCHEMA;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new SchemaVersionError(`NORYTH_SCHEMA 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }
  const fromCwd = walk(process.cwd());
  if (fromCwd) return fromCwd;
  if (typeof __dirname !== 'undefined') {
    const fromModule = walk(__dirname);
    if (fromModule) return fromModule;
  }
  throw new SchemaVersionError('找不到 docs/02-schema.sql（从当前目录与模块目录向上都没有）');
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: boolean;
}

/**
 * 迁移器。v1 = 整份 schema。
 * - 版本高于本程序 → 拒绝打开（否则会把新字段当不存在，静默写坏数据）。
 * - 版本为 0 → 建库；schema.sql 自己设置 user_version，建完再复核一次。
 * 将来的迁移按 [{version, up}] 追加，不在 P0 预留空壳。
 */
export function migrate(db: Db): MigrationResult {
  const from = Number(db.pragma('user_version', { simple: true }));
  if (from > SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `此项目由更新版本创建（v${from} > v${SCHEMA_VERSION}），请升级 Noryth`,
    );
  }
  if (from === SCHEMA_VERSION) {
    return { from, to: from, applied: false };
  }
  if (from === 0) {
    const sql = readFileSync(findSchemaPath(), 'utf8');
    db.exec(sql);
    const after = Number(db.pragma('user_version', { simple: true }));
    if (after !== SCHEMA_VERSION) {
      throw new SchemaVersionError(`schema 建库后 user_version=${after}，期望 ${SCHEMA_VERSION}`);
    }
    return { from: 0, to: after, applied: true };
  }
  throw new SchemaVersionError(`没有从 v${from} 到 v${SCHEMA_VERSION} 的迁移路径`);
}
