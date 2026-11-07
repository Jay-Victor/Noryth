import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * MinGit 封装的最小面（P0 只需要 init / add / commit / log / status）。
 * Windows 打包用 resources/git；开发期用系统 git。
 * 失败一律抛 GitError 并带 stderr —— "git 命令失败"不带原因是最难查的一类错误。
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly command: readonly string[],
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  cwd: string;
  allowFailure?: boolean;
}

export interface CommitInfo {
  sha: string;
  body: string;
}

function run(args: readonly string[], options: GitRunOptions): string {
  try {
    return execFileSync('git', [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
    if (options.allowFailure) return '';
    throw new GitError(
      `git ${args.join(' ')} 失败${err.message ? `：${err.message.split('\n')[0]}` : ''}`,
      stderr.trim(),
      args,
    );
  }
}

export function gitVersion(cwd = process.cwd()): string {
  return run(['--version'], { cwd });
}

export function isGitAvailable(cwd = process.cwd()): boolean {
  try {
    gitVersion(cwd);
    return true;
  } catch {
    return false;
  }
}

export function isRepo(cwd: string): boolean {
  return run(['rev-parse', '--is-inside-work-tree'], { cwd, allowFailure: true }) === 'true';
}

export function init(cwd: string): void {
  // 只认"这个目录自己的 .git"：在别人的仓库子目录里 init 时，不能把提交写进父仓库。
  if (existsSync(path.join(cwd, '.git'))) return;
  run(['init'], { cwd });
}

export function statusPorcelain(cwd: string): string {
  return run(['status', '--porcelain'], { cwd });
}

export function hasCommits(cwd: string): boolean {
  const count = run(['rev-list', '--count', 'HEAD'], { cwd, allowFailure: true });
  return Number(count || '0') > 0;
}

function identityArgs(cwd: string): string[] {
  const name = run(['config', 'user.name'], { cwd, allowFailure: true });
  const email = run(['config', 'user.email'], { cwd, allowFailure: true });
  const args: string[] = [];
  if (!name) args.push('-c', 'user.name=Noryth');
  if (!email) args.push('-c', 'user.email=noryth@localhost');
  return args;
}

/** 暂存全部改动并提交；返回 HEAD sha。没有改动时返回空串（不制造空提交）。 */
export function commitAll(cwd: string, message: string): string {
  run(['add', '-A'], { cwd });
  if (!statusPorcelain(cwd)) return '';
  run([...identityArgs(cwd), 'commit', '-m', message], { cwd });
  return run(['rev-parse', 'HEAD'], { cwd });
}

export function log(cwd: string, limit = 20): CommitInfo[] {
  if (!hasCommits(cwd)) return [];
  const raw = run(['log', `-${limit}`, '--format=%H%x00%B%x00%x1e'], { cwd });
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, body = ''] = chunk.split('\x00');
      return { sha: sha ?? '', body: body.trim() };
    });
}
