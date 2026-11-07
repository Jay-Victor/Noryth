import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  env?: NodeJS.ProcessEnv;
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
      env: options.env,
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

/**
 * 只提交指定路径（场景关闭：noryth.json + 状态包 + chapters）。
 *
 * 不能直接用 `git commit -- <paths>`：Git 的 pathspec 提交只认"HEAD 里已经
 * 存在的文件"，状态包是每场新写入的新文件，会被静默漏掉。这里用一个临时
 * index（从 HEAD 读树 → add 指定路径 → write-tree → commit-tree），
 * 既能把新文件带进提交，也不会把用户索引里暂存的无关文件一起提交。
 * 提交后对指定路径执行 `git reset HEAD --` 同步真实索引，工作区不动。
 */
export function commitPaths(
  cwd: string,
  message: string,
  paths: readonly string[],
): string {
  const existing = paths.filter((item) => existsSync(path.join(cwd, item)));
  if (existing.length === 0) return '';

  const indexDir = mkdtempSync(path.join(tmpdir(), 'noryth-index-'));
  const indexFile = path.join(indexDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    if (hasCommits(cwd)) {
      run(['read-tree', 'HEAD'], { cwd, env });
    } else {
      run(['read-tree', '--empty'], { cwd, env });
    }
    run(['add', '--', ...existing], { cwd, env });

    // 与 HEAD 比较；没有差异就不制造空提交。
    if (hasCommits(cwd)) {
      try {
        execFileSync('git', ['diff-index', '--cached', '--quiet', 'HEAD'], {
          cwd,
          env,
          stdio: 'ignore',
          windowsHide: true,
        });
        return '';
      } catch {
        /* 有差异 */
      }
    }

    const tree = run(['write-tree'], { cwd, env });
    const args = [...identityArgs(cwd), 'commit-tree', tree, '-m', message];
    if (hasCommits(cwd)) args.push('-p', 'HEAD');
    const sha = run(args, { cwd, env });
    run(['update-ref', 'HEAD', sha], { cwd });
    // 真实索引跟着 HEAD 走；用户此前暂存的无关文件保持原样。
    // 空目录（chapters 还没内容）不在 HEAD 里，reset 会报 pathspec，跳过。
    const refresh = existing.filter(
      (item) => run(['ls-tree', '-r', '--name-only', 'HEAD', '--', item], { cwd }).length > 0,
    );
    if (refresh.length > 0) run(['reset', 'HEAD', '--', ...refresh], { cwd });
    return sha;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
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

/** 提交是否存在（支持短 sha / 分支名 / HEAD）。 */
export function hasCommit(cwd: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取某个提交里的文件（二进制安全）。`restore --from-commit` 用它在
 * 工作区之外读 noryth.json / .noryth/state.json.zst，避免被未提交改动污染。
 */
export function showFile(cwd: string, sha: string, file: string): Buffer {
  return execFileSync('git', ['show', `${sha}:${file}`], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** 提交里是否存在某文件。 */
export function hasFile(cwd: string, sha: string, file: string): boolean {
  try {
    showFile(cwd, sha, file);
    return true;
  } catch {
    return false;
  }
}
