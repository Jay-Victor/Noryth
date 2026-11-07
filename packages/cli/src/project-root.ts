import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, ManifestSchema, type Manifest } from '@noryth/core';
import { IoError, SchemaVersionError } from '@noryth/store';

/** 从 start 向上找 noryth.json；找不到返回 null。 */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILE);
}

export function readManifest(root: string): Manifest {
  const file = manifestPath(root);
  if (!existsSync(file)) {
    throw new IoError(`不是 Noryth 项目（缺少 ${MANIFEST_FILE}）：${root}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new IoError(
      `${MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new IoError(`${MANIFEST_FILE} 校验失败：${detail}`);
  }
  return result.data;
}

export function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function assertManifestVersion(manifest: Manifest): void {
  if (manifest.schemaVersion > 1) {
    throw new SchemaVersionError(
      `此项目由更新版本创建（manifest v${manifest.schemaVersion}），请升级 Noryth`,
    );
  }
}
