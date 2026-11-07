#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { UsageError, NorythError } from '@noryth/store';
import { flagBool, flagInt, flagJson, flagList, flagNumber, flagString, parseArgv } from './args.js';
import { runBeatNext, runBeatRewind, runBeatWhy } from './commands/beat.js';
import { runConfigGet, runConfigSet } from './commands/config.js';
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { formatInitResult, normalizeInitName, runInit } from './commands/init.js';
import { formatRestore, runLog, runRestore, runRestoreFromCommit } from './commands/restore.js';
import { formatCommit, runCommit } from './commands/commit.js';
import { formatSceneList, runSceneClose, runSceneCreate, runSceneList, runSceneOpen } from './commands/scene.js';
import { formatView, runOpen, runStatus } from './commands/status.js';
import { formatSession, runTheater } from './commands/run.js';
import { exitCodeFor, failureEnvelope, printJson, successEnvelope, type Meta, type Warning } from './output.js';

const VERSION = '0.0.0';

const USAGE = `noryth <command> [args] [--project <dir>] [--json] [--yes] [--offline] [--verbose]

命令：
  init <dir>              建项目骨架（noryth.json / .noryth/ / chapters/ / skills/ / Git）
  open [dir]              打开项目并打印状态摘要
  status                  分支 / head_seq / 场景 / 字数 / 未结线索 / 预算
  doctor                  环境自检：Node / SQLite / Git / schema / 项目目录
  config get|set          读写设置（--global 切全局）

  scene list              列出场景
  scene create <标题>     建场（--cast 名字,名字 --exit <JSON> --cards <JSON> --max-beats N）
  scene open <id>         打开场景（planned/paused → open）
  scene close <id>        关闭场景（写 scene_close 检查点）

  run                     跑剧场（--scene <id> --beats N --seed N --mode auto|step --pick 名字 --offline）
  beat next               跑一拍
  beat why <拍号>         展开 beat.breakdown（为什么是它）
  beat rewind <拍号>      回退到该拍（开新分支，旧分支保留）
  restore                 回退（--checkpoint <id> | --seq N | --from-commit <sha>；危险命令，需确认或 --yes）
  commit                  手动落点（检查点 + 状态包 + Git 提交；--message <说明>）
  log                     检查点与 Git 提交列表

全局参数：
  --project <dir>   指定项目目录（缺省从当前目录向上找 noryth.json）
  --json            单行 JSON 信封，供脚本与 CI 消费
  --yes             跳过交互确认（仅 CI）
  --offline         禁止网络；剧场用 fixtures/beats 的确定性 provider
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

async function confirmDanger(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new UsageError(`${message}（非交互环境请加 --yes）`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') throw new UsageError('已取消');
}

function parseMode(raw: string | undefined): 'auto' | 'step' {
  if (raw === undefined) return 'auto';
  if (raw === 'auto' || raw === 'step') return raw;
  throw new UsageError(`--mode 只能是 auto 或 step：${raw}`);
}

async function main(): Promise<number> {
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
    const dir = flagString(args, 'project');

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
        const view = runOpen(dir ?? args.positionals[0]);
        const { warnings, ...data } = view;
        emit(json, data, formatView(view), warnings, {
          ...meta(),
          seq: view.branch.headSeq,
          branch: view.branch.name,
        });
        return 0;
      }
      case 'status': {
        const view = runStatus(dir ?? args.positionals[0]);
        const { warnings, ...data } = view;
        emit(json, data, formatView(view), warnings, {
          ...meta(),
          seq: view.branch.headSeq,
          branch: view.branch.name,
        });
        return 0;
      }
      case 'doctor': {
        const result = runDoctor(dir ?? args.positionals[0]);
        emit(json, result, formatDoctor(result), [], meta());
        return result.ok ? 0 : 1;
      }
      case 'config': {
        const sub = args.positionals[0];
        const key = args.positionals[1];
        const global = flagBool(args, 'global');
        const options = { global, dir };
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
      case 'scene': {
        const sub = args.positionals[0];
        if (sub === 'list') {
          const scenes = runSceneList(dir);
          emit(json, { scenes }, formatSceneList(scenes), [], meta());
          return 0;
        }
        if (sub === 'create') {
          const title = flagString(args, 'title') ?? args.positionals[1];
          if (!title) {
            throw new UsageError(
              '用法：noryth scene create <标题> --cast 名字,名字 [--goal ...] [--exit <JSON>]',
            );
          }
          const cards = flagJson(args, 'cards');
          if (cards !== undefined && !Array.isArray(cards)) {
            throw new UsageError('--cards 必须是 JSON 数组');
          }
          const result = runSceneCreate({
            dir,
            title,
            cast: flagList(args, 'cast') ?? [],
            present: flagList(args, 'present'),
            goal: flagString(args, 'goal'),
            situation: flagString(args, 'situation'),
            storyStart: flagString(args, 'story-start'),
            timeline: flagString(args, 'timeline'),
            location: flagString(args, 'location'),
            conflict: flagNumber(args, 'conflict'),
            maxBeats: flagInt(args, 'max-beats'),
            exit: flagJson(args, 'exit'),
            cards,
          });
          emit(
            json,
            result,
            [
              `已建场 ${result.sceneId} · ${result.title}（idx ${result.idx}）`,
              `  角色   ${result.cast.join('、')} · 旁白`,
              `  在场   ${result.present.join('、')}`,
              `  牌堆   ${result.cards} 张`,
            ],
            [],
            meta(),
          );
          return 0;
        }
        if (sub === 'open' || sub === 'close') {
          const sceneId = args.positionals[1] ?? flagString(args, 'scene');
          if (!sceneId) throw new UsageError(`用法：noryth scene ${sub} <id>`);
          if (sub === 'open') {
            runSceneOpen(dir, sceneId);
            emit(json, { sceneId, state: 'open' }, [`场景 ${sceneId} 已打开`], [], meta());
          } else {
            const result = runSceneClose(dir, sceneId);
            const lines = [`场景 ${sceneId} 已关闭（检查点已写）`];
            if (result.commit) {
              lines.push(`  Git      ${result.commit.slice(0, 7)} · .noryth/state.json.zst 已提交`);
            }
            emit(
              json,
              { ...result, state: 'closed' },
              lines,
              result.error ? [{ code: 'git_commit_failed', message: result.error }] : [],
              meta(),
            );
          }
          return 0;
        }
        throw new UsageError('用法：noryth scene list | create | open <id> | close <id>');
      }
      case 'run': {
        const mode = parseMode(flagString(args, 'mode'));
        const result = await runTheater({
          dir,
          scene: flagString(args, 'scene'),
          beats: flagInt(args, 'beats') ?? 40,
          seed: flagInt(args, 'seed') ?? 42,
          mode,
          pick: flagString(args, 'pick'),
          offline: flagBool(args, 'offline'),
        });
        emit(json, result, formatSession(result), result.warnings, {
          ...meta(),
          seq: result.beats,
        });
        return 0;
      }
      case 'beat': {
        const sub = args.positionals[0];
        if (sub === 'next') {
          if (!flagBool(args, 'offline')) {
            throw new UsageError('P1 只实现了离线 provider：请加 --offline');
          }
          const { OfflineModel } = await import('./offline-model.js');
          const result = await runBeatNext({
            dir,
            scene: flagString(args, 'scene'),
            seed: flagInt(args, 'seed') ?? 42,
            pick: flagString(args, 'pick'),
            model: OfflineModel.load(),
          });
          emit(json, result, formatSession(result), result.warnings, meta());
          return 0;
        }
        if (sub === 'why') {
          const seq = args.positionals[1] ? Number(args.positionals[1]) : flagInt(args, 'seq');
          if (seq === undefined || !Number.isInteger(seq) || seq < 1) {
            throw new UsageError('用法：noryth beat why <拍号>');
          }
          const why = runBeatWhy(dir, flagString(args, 'scene'), seq);
          const lines = [
            `第 ${why.beatSeq} 拍 · ${why.agentName} · ${why.mode} · score ${why.score.toFixed(3)} → 阻尼后 ${why.damped.toFixed(3)}`,
            `  台词   ${why.prose.split('\n')[0] ?? ''}`,
          ];
          const parts = why.breakdown.parts as Record<string, number> | null;
          if (parts) {
            lines.push(
              `  分值   goal ${parts.goal?.toFixed(3)} · addressed ${parts.addr?.toFixed(3)} · stake ${parts.stake?.toFixed(3)} · narrator ${parts.narr?.toFixed(3)} · initiative ${parts.init?.toFixed(3)}`,
            );
          }
          lines.push(`  抖动   ${String(why.breakdown.jitter ?? '')}`);
          const context = why.breakdown.context as { tokens?: number; budget?: number; level?: string } | undefined;
          if (context) {
            lines.push(`  上下文 ${context.tokens} / ${context.budget} tok · ${context.level}`);
          }
          lines.push(`  冲突   ${String(why.breakdown.conflict ?? '')}`);
          emit(json, why, lines, [], meta());
          return 0;
        }
        if (sub === 'rewind') {
          const seq = args.positionals[1] ? Number(args.positionals[1]) : flagInt(args, 'seq');
          if (seq === undefined || !Number.isInteger(seq) || seq < 1) {
            throw new UsageError('用法：noryth beat rewind <拍号>');
          }
          await confirmDanger(`回退到第 ${seq} 拍会开一条新分支（旧分支保留）`, flagBool(args, 'yes'));
          const result = runBeatRewind(dir, flagString(args, 'scene'), seq, flagString(args, 'label'));
          emit(json, result, formatRestore(result), [], {
            ...meta(),
            seq: result.headSeq,
            branch: result.branchName,
          });
          return 0;
        }
        throw new UsageError('用法：noryth beat next | why <seq> | rewind <seq>');
      }
      case 'commit': {
        const result = runCommit({ dir, message: flagString(args, 'message') });
        emit(
          json,
          result,
          formatCommit(result),
          result.error ? [{ code: 'git_commit_failed', message: result.error }] : [],
          meta(),
        );
        return 0;
      }
      case 'restore': {
        const fromCommit = flagString(args, 'from-commit');
        const checkpointId = flagString(args, 'checkpoint');
        const seq = flagInt(args, 'seq');
        if (fromCommit) {
          await confirmDanger(
            `从提交 ${fromCommit.slice(0, 7)} 恢复会新建一条分支（原分支与提交保留）`,
            flagBool(args, 'yes'),
          );
          const result = runRestoreFromCommit({
            dir,
            sha: fromCommit,
            label: flagString(args, 'label'),
          });
          emit(json, result, formatRestore(result), [], {
            ...meta(),
            seq: result.headSeq,
            branch: result.branchName,
          });
          return 0;
        }
        if (!checkpointId && seq === undefined) {
          throw new UsageError(
            '用法：noryth restore --checkpoint <id> | --seq N | --from-commit <sha>',
          );
        }
        await confirmDanger('回退会开一条新分支（旧分支保留）', flagBool(args, 'yes'));
        const result = runRestore({ dir, checkpointId, seq, label: flagString(args, 'label') });
        emit(json, result, formatRestore(result), [], {
          ...meta(),
          seq: result.headSeq,
          branch: result.branchName,
        });
        return 0;
      }
      case 'log': {
        const entries = runLog(dir, flagInt(args, 'limit') ?? 20);
        const lines =
          entries.length === 0
            ? ['（没有检查点或提交）']
            : entries.map((entry) =>
                entry.kind === 'checkpoint'
                  ? `  ck  seq ${String(entry.seq).padStart(5)}  ${entry.trigger.padEnd(11)}  ${entry.label}`
                  : `  git ${entry.id.slice(0, 7)}                         ${entry.label}`,
              );
        emit(json, { entries }, lines, [], meta());
        return 0;
      }
      default:
        throw new UsageError(`未知命令：${args.command}（--help 查看命令表）`);
    }
  } catch (error) {
    if (jsonHint) {
      printJson(failureEnvelope(error, Date.now() - started));
    } else {
      const name =
        error instanceof NorythError && error.constraint ? `[${error.constraint}] ` : '';
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
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, USAGE };
