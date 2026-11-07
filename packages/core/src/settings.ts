import { z } from 'zod';

/**
 * 设置项 schema（04-ui.md §9.2）。
 *
 * 两条硬规则在类型层强制：
 * 1. 密钥只有引用，没有值：keyRef 必须是 "os:<name>" 或空（未配置）。
 * 2. 项目级只写差异：noryth.json.settings 是 partial，读取时与全局 deep-merge。
 * 算法超参不在这里——它们在 docs/params.yaml，不暴露给用户。
 */

export const AGENT_ROLES = [
  'character',
  'narrator',
  'planner',
  'writer',
  'reviser',
  'critic',
] as const;

export const ModelRefSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string(),
  keyRef: z.string().regex(/^$|^os:[a-z0-9][a-z0-9._-]*$/, 'keyRef 必须是 os:<name>，永不存明文'),
});

export const SettingsSchema = z.strictObject({
  locale: z.enum(['zh-CN', 'en-US']),
  theme: z.enum(['dark', 'light', 'system']),
  editor: z.strictObject({
    fontFamily: z.string(),
    fontSize: z.number().int().min(8).max(48),
    lineWidth: z.number().int().min(320).max(2000),
  }),
  autosaveMs: z.number().int().min(0).max(60_000),
  stepPauseMs: z.number().int().min(0).max(10_000),
  openLastProject: z.boolean(),
  models: z.strictObject({
    director: ModelRefSchema,
    character: ModelRefSchema,
    utility: ModelRefSchema,
  }),
  generation: z.strictObject({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(200_000),
    timeoutMs: z.number().int().min(1000).max(600_000),
    retries: z.number().int().min(0).max(5),
  }),
  budget: z.strictObject({
    perProjectCny: z.number().min(0),
    warnAt: z.number().min(0).max(1),
    stopAt: z.number().min(0).max(1),
  }),
  agents: z.record(
    z.enum(AGENT_ROLES),
    z.strictObject({
      enabled: z.boolean(),
      model: ModelRefSchema.optional(),
      promptOverride: z.string().optional(),
    }),
  ),
  permissions: z.strictObject({
    criticToReviser: z.boolean(),
    autoApplyRevision: z.boolean(),
  }),
  skills: z.strictObject({
    enabled: z.array(z.string()),
    maxActive: z.number().int().min(0).max(10),
  }),
  diagnostic: z.strictObject({
    includeProse: z.boolean(),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;

const unconfigured = (provider: string): ModelRef => ({ provider, model: '', keyRef: '' });

const defaultAgent = { enabled: true };

export const DEFAULT_SETTINGS: Settings = {
  locale: 'zh-CN',
  theme: 'dark',
  editor: { fontFamily: 'Source Han Serif SC, serif', fontSize: 15, lineWidth: 760 },
  autosaveMs: 2000,
  stepPauseMs: 0,
  openLastProject: true,
  models: {
    director: unconfigured('openai'),
    character: unconfigured('openai'),
    utility: unconfigured('openai'),
  },
  generation: { temperature: 0.8, maxTokens: 1200, timeoutMs: 60_000, retries: 1 },
  budget: { perProjectCny: 0, warnAt: 0.8, stopAt: 1 },
  agents: {
    character: { ...defaultAgent },
    narrator: { ...defaultAgent },
    planner: { ...defaultAgent },
    writer: { ...defaultAgent },
    reviser: { ...defaultAgent },
    critic: { ...defaultAgent },
  },
  permissions: { criticToReviser: false, autoApplyRevision: false },
  skills: { enabled: [], maxActive: 3 },
  diagnostic: { includeProse: false },
};

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value;
  }
  return out;
}

/**
 * 合并顺序：默认值 ← 全局设置 ← 项目级差异。
 * 校验的是最终结果，所以任何一层写了未知键都会在这里被 strictObject 拒绝。
 */
export function resolveSettings(global?: unknown, project?: unknown): Settings {
  const layers: Plain[] = [DEFAULT_SETTINGS as unknown as Plain];
  if (global !== undefined) {
    if (!isPlainObject(global)) throw new Error('全局设置必须是 JSON 对象');
    layers.push(global);
  }
  if (project !== undefined) {
    if (!isPlainObject(project)) throw new Error('项目级设置必须是 JSON 对象');
    layers.push(project);
  }
  const merged = layers.reduce((acc, layer) => deepMerge(acc, layer), {});
  return SettingsSchema.parse(merged);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getSetting(settings: unknown, path: string): unknown {
  let cur: unknown = settings;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) {
      throw new Error(`未知设置项：${path}`);
    }
    cur = cur[part];
  }
  return cur;
}

export function setSetting(settings: Settings, path: string, value: unknown): Settings {
  const parts = path.split('.');
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`非法设置项：${path}`);
  }
  const next = clone(settings) as unknown as Plain;
  let cur: Plain = next;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const child = cur[key];
    if (!isPlainObject(child)) {
      throw new Error(`未知设置项：${path}`);
    }
    cur = child;
  }
  const last = parts[parts.length - 1]!;
  if (!(last in cur)) {
    throw new Error(`未知设置项：${path}`);
  }
  cur[last] = value;
  return SettingsSchema.parse(next);
}

/** 命令行的值都是字符串；按当前值的类型做最小 coercion，避免 "false" 变成真值。 */
export function coerceConfigValue(raw: string, current: unknown): unknown {
  if (typeof current === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`需要布尔值（true/false）：${raw}`);
  }
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`需要数字：${raw}`);
    return n;
  }
  if (Array.isArray(current) || isPlainObject(current)) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`需要 JSON：${raw}`);
    }
  }
  return raw;
}

/** 给出可配置的键（用于 config 列表与错误提示）；agents.* 不展开。 */
export function settingsKeys(settings: Settings): string[] {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    out.push(prefix);
  };
  walk(settings, '');
  return out.sort();
}
