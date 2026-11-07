import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Manifest, Settings } from '@noryth/core';
import { PROJECT_LAYOUT } from '@noryth/core';
import {
  IoError,
  SCHEMA_VERSION,
  SchemaVersionError,
  closeDatabase,
  openDatabase,
  readStatus,
  type Db,
  type StatusSummary,
} from '@noryth/store';
import type { Warning } from '../output.js';
import { assertManifestVersion, findProjectRoot, readManifest } from '../project-root.js';
import { loadMergedSettings } from '../settings-store.js';

export interface OpenedProject {
  root: string;
  manifest: Manifest;
  status: StatusSummary;
  settings: Settings;
  warnings: Warning[];
  db: Db;
  close(): void;
}

export function resolveRoot(dirArg: string | undefined): string {
  if (dirArg) {
    const root = path.resolve(dirArg);
    if (!existsSync(path.join(root, PROJECT_LAYOUT.manifest))) {
      throw new IoError(`不是 Noryth 项目：${root}`);
    }
    return root;
  }
  const found = findProjectRoot(process.cwd());
  if (!found) {
    throw new IoError('当前目录不在 Noryth 项目内（用 --project <dir> 指定）');
  }
  return found;
}

/**
 * 打开项目：只读连接 + 版本校验。
 * 版本不一致时拒绝打开，而不是"尽量读"——把新字段当不存在会静默写坏数据。
 */
export function openProject(dirArg?: string): OpenedProject {
  const root = resolveRoot(dirArg);
  const manifest = readManifest(root);
  assertManifestVersion(manifest);

  const dbPath = path.join(root, PROJECT_LAYOUT.database);
  if (!existsSync(dbPath)) {
    throw new IoError(`数据库缺失：${dbPath}（项目文件不完整）`);
  }
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version !== manifest.schemaVersion || version > SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `schema 版本不一致：manifest v${manifest.schemaVersion}，数据库 v${version}，程序支持 v${SCHEMA_VERSION}`,
      );
    }
    const { settings, warnings } = loadMergedSettings(manifest);
    const status = readStatus(db);
    return {
      root,
      manifest,
      status,
      settings,
      warnings,
      db,
      close: () => closeDatabase(db),
    };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}
