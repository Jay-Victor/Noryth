#!/usr/bin/env node
import { UsageError, NorythError } from '@noryth/store';
import { flagBool, flagString, parseArgv } from './args.js';
import { runConfigGet, runConfigSet } from './commands/config.js';
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { formatInitResult, normalizeInitName, runInit } from './commands/init.js';
import { formatView, runOpen, runStatus } from './commands/status.js';
import { exitCodeFor, failureEnvelope, printJson, successEnvelope, type Meta, type Warning } from './output.js';

const VERSION = '0.0.0';

const USAGE = `noryth <command> [args] [--project <dir>] [--json] [--yes] [--offline] [--verbose]

命令：
  init <dir>              建项目骨架（noryth.json / .noryth/ / chapters/ / skills/ / Git）
  open [dir]              打开项目并打印状态摘要
  status                  分支 / head_seq / 场景 / 字数 / 未结线索 / 预算
  doctor                  环境自检：Node / SQLite / Git / schema / 项目目录
  config get [key]        读取设置（--global 只读全局）
  config set <key> <值>   写入设置（默认写项目级差异）

全局参数：
  --project <dir>   指定项目目录（缺省从当前目录向上找 noryth.json）
  --json            单行 JSON 信封，供脚本与 CI 消费
  --yes             跳过交互确认（仅 CI）
  --offline         禁止网络（P0 不含任何网络调用）
  --verbose         错误时打印堆栈
`;

function emit(
  json: boolean,
  data: unknown,
  human: string[],
  warnings: Warning[],
  meta: Meta,
): void {
  if (json) {
    printJson(successEnvelope(data, warnings, meta));
    return;
  }
  for (const line of human) process.stdout.write(`${line}\n`);
  for (const warning of warnings) process.stdout.write(`! ${warning.message}\n`);
}

function main(): number {
  const started = Date.now();
  const jsonHint = process.argv.includes('--json');
  let verbose = process.argv.includes('--verbose');

  try {
    const args = parseArgv(process.argv.slice(2));
    const json = flagBool(args, 'json');
    verbose = flagBool(args, 'verbose');

    if (flagBool(args, 'version')) {
      process.stdout.write(`noryth ${VERSION}\n`);
      return 0;
    }
    if (flagBool(args, 'help') || args.command === null) {
      process.stdout.write(USAGE);
      return 0;
    }

    const meta = (): Meta => ({ ms: Date.now() - started });

    switch (args.command) {
      case 'init': {
        const target = args.positionals[0];
        if (!target) throw new UsageError('用法：noryth init <dir> [--name <名称>]');
        const result = runInit({ dir: target, name: normalizeInitName(flagString(args, 'name')) });
        const { warnings, ...data } = result;
        emit(json, data, formatInitResult(result), warnings, {
          ...meta(),
          seq: result.headSeq,
          branch: result.branch,
        });
        return 0;
      }
      case 'open': {
        const view = runOpen(flagString(args, 'project') ?? args.positionals[0]);
        const { warnings, ...data } = view;
        emit(json, data, formatView(view), warnings, {
          ...meta(),
          seq: view.branch.headSeq,
          branch: view.branch.name,
        });
        return 0;
      }
      case 'status': {
        const view = runStatus(flagString(args, 'project') ?? args.positionals[0]);
        const { warnings, ...data } = view;
        emit(json, data, formatView(view), warnings, {
          ...meta(),
          seq: view.branch.headSeq,
          branch: view.branch.name,
        });
        return 0;
      }
      case 'doctor': {
        const result = runDoctor(flagString(args, 'project') ?? args.positionals[0]);
        emit(json, result, formatDoctor(result), [], meta());
        return result.ok ? 0 : 1;
      }
      case 'config': {
        const sub = args.positionals[0];
        const key = args.positionals[1];
        const global = flagBool(args, 'global');
        const options = { global, dir: flagString(args, 'project') };
        if (sub === 'get') {
          const result = runConfigGet(key, options);
          const { warnings, ...data } = result;
          const human =
            result.key === null
              ? [JSON.stringify(result.value, null, 2)]
              : [`${result.key} = ${JSON.stringify(result.value)}`];
          emit(json, data, human, warnings, meta());
          return 0;
        }
        if (sub === 'set') {
          if (!key) throw new UsageError('用法：noryth config set <key> <值> [--global]');
          const raw = args.positionals[2];
          if (raw === undefined) throw new UsageError('用法：noryth config set <key> <值> [--global]');
          const result = runConfigSet(key, raw, options);
          const { warnings, ...data } = result;
          emit(
            json,
            data,
            [`${result.key} = ${JSON.stringify(result.value)}（${result.scope === 'global' ? '全局' : '项目'}）`],
            warnings,
            meta(),
          );
          return 0;
        }
        throw new UsageError('用法：noryth config get [key] | config set <key> <值> [--global]');
      }
      default:
        throw new UsageError(`未知命令：${args.command}（--help 查看命令表）`);
    }
  } catch (error) {
    if (jsonHint) {
      printJson(failureEnvelope(error, Date.now() - started));
    } else {
      const name = error instanceof NorythError && error.constraint
        ? `[${error.constraint}] `
        : '';
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`noryth: ${name}${message}\n`);
      if (verbose && error instanceof Error && error.stack) {
        process.stderr.write(`${error.stack}\n`);
      }
    }
    return exitCodeFor(error);
  }
}

if (require.main === module) {
  process.exitCode = main();
}

export { main, USAGE };
