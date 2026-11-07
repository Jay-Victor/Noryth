import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { resolveSettings, type Manifest, type Settings } from '@noryth/core';
import type { Warning } from './output.js';

export function globalSettingsPath(): string {
  return path.join(os.homedir(), '.noryth', 'settings.json');
}

export interface LoadedGlobal {
  value: Record<string, unknown>;
  warning?: Warning;
}

/**
 * 全局设置损坏时降级为默认值 + 一条警告，而不是拒绝启动
 * （04-ui.md §9.2 三条硬规则之三）。
 */
export function loadGlobalSettings(): LoadedGlobal {
  const file = globalSettingsPath();
  if (!existsSync(file)) return { value: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('顶层不是 JSON 对象');
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      value: {},
      warning: {
        code: 'settings_corrupt',
        message: `全局设置无法解析，已降级为默认值：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function saveGlobalSettings(value: Record<string, unknown>): void {
  const file = globalSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export interface MergedSettings {
  settings: Settings;
  warnings: Warning[];
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function loadMergedSettings(manifest: Manifest): MergedSettings {
  const global = loadGlobalSettings();
  const warnings: Warning[] = global.warning ? [global.warning] : [];
  try {
    return {
      settings: resolveSettings(global.value, manifest.settings),
      warnings,
    };
  } catch (error) {
    warnings.push({
      code: 'settings_invalid',
      message: `项目级设置无效，已忽略：${describeError(error)}`,
    });
    return { settings: resolveSettings(global.value, undefined), warnings };
  }
}
