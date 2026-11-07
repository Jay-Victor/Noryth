import { UsageError } from '@noryth/store';

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  'project',
  'name',
  'scene',
  'beats',
  'seed',
  'mode',
  'pick',
  'title',
  'cast',
  'present',
  'goal',
  'situation',
  'story-start',
  'timeline',
  'location',
  'conflict',
  'max-beats',
  'exit',
  'cards',
  'checkpoint',
  'from-commit',
  'seq',
  'limit',
  'label',
  'message',
]);
const BOOL_FLAGS = new Set(['json', 'yes', 'offline', 'verbose', 'global', 'help', 'version']);

/** 手写解析器：命令面很小，引一个参数库只会多一层版本风险。 */
export function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '-h') {
      flags.help = true;
      i += 1;
      continue;
    }
    if (arg === '-v') {
      flags.version = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
      if (!key) throw new UsageError(`无法解析的参数：${arg}`);
      if (eq !== -1) {
        if (!BOOL_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
          throw new UsageError(`未知参数：--${key}`);
        }
        flags[key] = arg.slice(eq + 1);
        i += 1;
        continue;
      }
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
        i += 1;
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError(`--${key} 需要一个值`);
        }
        flags[key] = value;
        i += 2;
        continue;
      }
      throw new UsageError(`未知参数：--${key}`);
    }
    if (command === null) {
      command = arg;
    } else {
      positionals.push(arg);
    }
    i += 1;
  }

  return { command, positionals, flags };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true;
}

export function flagNumber(args: ParsedArgs, key: string): number | undefined {
  const raw = flagString(args, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${key} 需要数字：${raw}`);
  return value;
}

export function flagInt(args: ParsedArgs, key: string): number | undefined {
  const value = flagNumber(args, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new UsageError(`--${key} 需要整数：${value}`);
  return value;
}

export function flagList(args: ParsedArgs, key: string): string[] | undefined {
  const raw = flagString(args, key);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function flagJson(args: ParsedArgs, key: string): unknown {
  const raw = flagString(args, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `--${key} 必须是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
