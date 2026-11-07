import path from 'node:path';
import { ZodError } from 'zod';
import {
  coerceConfigValue,
  getSetting,
  resolveSettings,
  type Settings,
} from '@noryth/core';
import { IoError, NorythError, UsageError } from '@noryth/store';
import type { Warning } from '../output.js';
import { findProjectRoot, readManifest, writeManifest } from '../project-root.js';
import { globalSettingsPath, loadGlobalSettings, saveGlobalSettings } from '../settings-store.js';

export interface ConfigOptions {
  global: boolean;
  dir?: string;
}

export interface ConfigResult {
  key: string | null;
  value: unknown;
  scope: 'global' | 'project';
  warnings: Warning[];
}

function projectRoot(options: ConfigOptions): string | null {
  if (options.dir) {
    const root = path.resolve(options.dir);
    try {
      readManifest(root);
      return root;
    } catch (error) {
      throw new IoError(error instanceof Error ? error.message : String(error));
    }
  }
  return findProjectRoot(process.cwd());
}

/** 用户给错的键/值都算用法错误（退出码 2），不要混进 IO 错误（退出码 1）。 */
function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof NorythError) throw error;
    if (error instanceof ZodError) {
      throw new UsageError(
        error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      );
    }
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function runConfigGet(key: string | undefined, options: ConfigOptions): ConfigResult {
  const global = loadGlobalSettings();
  const warnings: Warning[] = global.warning ? [global.warning] : [];

  const root = options.global ? null : projectRoot(options);
  if (!root) {
    const settings = usage(() => resolveSettings(global.value, undefined));
    return {
      key: key ?? null,
      value: key ? usage(() => getSetting(settings, key)) : settings,
      scope: 'global',
      warnings,
    };
  }

  const manifest = readManifest(root);
  let settings: Settings;
  try {
    settings = resolveSettings(global.value, manifest.settings);
  } catch (error) {
    warnings.push({
      code: 'settings_invalid',
      message: `项目级设置无效：${error instanceof Error ? error.message : String(error)}`,
    });
    settings = resolveSettings(global.value, undefined);
  }
  return {
    key: key ?? null,
    value: key ? usage(() => getSetting(settings, key)) : settings,
    scope: 'project',
    warnings,
  };
}

function setPathDeep(
  source: Record<string, unknown>,
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const parts = dotted.split('.');
  const out = structuredClone(source);
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const child = cursor[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return out;
}

export function runConfigSet(
  key: string,
  rawValue: string,
  options: ConfigOptions,
): ConfigResult {
  if (!key.trim()) throw new UsageError('设置项不能为空');

  const global = loadGlobalSettings();
  const warnings: Warning[] = global.warning ? [global.warning] : [];

  if (options.global) {
    if (global.warning) {
      throw new IoError(
        `全局设置文件损坏，先修复或删除：${globalSettingsPath()}（${global.warning.message}）`,
      );
    }
    const current = usage(() => getSetting(resolveSettings(global.value, undefined), key));
    const value = usage(() => coerceConfigValue(rawValue, current));
    const next = setPathDeep(global.value, key, value);
    usage(() => resolveSettings(next, undefined)); // 类型/未知键校验；失败则一个字节都不写
    saveGlobalSettings(next);
    return { key, value, scope: 'global', warnings };
  }

  const root = projectRoot(options);
  if (!root) throw new UsageError('不在 Noryth 项目内；改全局设置请加 --global');
  const manifest = readManifest(root);
  const merged = usage(() => resolveSettings(global.value, manifest.settings));
  const current = usage(() => getSetting(merged, key));
  const value = usage(() => coerceConfigValue(rawValue, current));
  const diff = setPathDeep(manifest.settings ?? {}, key, value);
  const validated = usage(() => resolveSettings(global.value, diff)); // 写入前校验合并结果
  writeManifest(root, { ...manifest, settings: diff });
  return { key, value: usage(() => getSetting(validated, key)), scope: 'project', warnings };
}
