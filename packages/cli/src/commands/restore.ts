/** 回退与日志：restore --checkpoint | --seq | --from-commit，log 列检查点与提交。 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_LAYOUT, STATE_PACKAGE_PATH } from '@noryth/core';
import {
  UsageError,
  closeDatabase,
  decodeStatePackage,
  getActiveBranch,
  getProject,
  migrate,
  openDatabase,
  restoreBranch,
  restoreFromPackage,
  type RestoreResult,
} from '@noryth/store';
import * as git from '@noryth/git';
import { readManifest, writeManifest } from '../project-root.js';
import { openProject, openProjectForWrite, resolveRoot } from './project.js';

export interface RestoreOptions {
  dir?: string;
  checkpointId?: string;
  seq?: number;
  label?: string;
}

export function runRestore(options: RestoreOptions): RestoreResult {
  const opened = openProjectForWrite(options.dir);
  try {
    const branch = getActiveBranch(opened.db);
    if (!branch) throw new UsageError('项目没有活动分支');

    let target: number;
    if (options.seq !== undefined) {
      target = options.seq;
    } else if (options.checkpointId) {
      const row = opened.db
        .prepare('SELECT seq FROM checkpoint WHERE id = ? AND branch_id = ?')
        .get(options.checkpointId, branch.id) as { seq: number } | undefined;
      if (!row) throw new UsageError(`检查点不存在或不属于当前分支：${options.checkpointId}`);
      target = row.seq;
    } else {
      throw new UsageError('用法：noryth restore --checkpoint <id> | --seq <N>');
    }

    const result = restoreBranch(opened.db, {
      targetSeq: target,
      idempotencyKey: `restore-${target}-${branch.headSeq}`,
      label: options.label,
    });
    writeManifest(opened.root, { ...readManifest(opened.root), branch: result.branchName });
    return result;
  } finally {
    opened.close();
  }
}

export interface RestoreFromCommitOptions {
  dir?: string;
  sha: string;
  /** 同一提交需要恢复出多条实验分支时用；不同 label = 不同幂等键。 */
  label?: string;
}

/**
 * 从 Git 提交恢复完整状态（01 §7 / 04 §8）。
 *
 * 数据库可以不存在：丢库/换机器后 .noryth/project.db 不在仓库里，
 * 但 noryth.json 和 .noryth/state.json.zst 在提交里。这里先建库/迁移，
 * 再从包重建 project + 新分支；projectId 必须与 noryth.json 一致。
 */
export function runRestoreFromCommit(options: RestoreFromCommitOptions): RestoreResult {
  const root = resolveRoot(options.dir);
  const manifest = readManifest(root);
  if (!git.hasCommits(root)) {
    throw new UsageError('项目没有任何 Git 提交，无法从提交恢复');
  }
  if (!git.hasCommit(root, options.sha)) {
    throw new UsageError(`提交不存在或不可达：${options.sha}`);
  }

  let commitManifestRaw: Buffer;
  try {
    commitManifestRaw = git.showFile(root, options.sha, PROJECT_LAYOUT.manifest);
  } catch {
    throw new UsageError(`提交 ${options.sha} 不含 ${PROJECT_LAYOUT.manifest}`);
  }
  let commitManifest: { projectId?: string };
  try {
    commitManifest = JSON.parse(commitManifestRaw.toString('utf8')) as { projectId?: string };
  } catch (error) {
    throw new UsageError(
      `提交 ${options.sha} 的 ${PROJECT_LAYOUT.manifest} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (commitManifest.projectId !== manifest.projectId) {
    throw new UsageError(
      `提交的 projectId（${String(commitManifest.projectId)}）与当前项目（${manifest.projectId}）不一致`,
    );
  }

  let packageBuffer: Buffer;
  try {
    packageBuffer = git.showFile(root, options.sha, STATE_PACKAGE_PATH);
  } catch {
    throw new UsageError(
      `提交 ${options.sha} 不含 ${STATE_PACKAGE_PATH}；P1 之前的提交或没有在场景关闭时提交的项目无法从 Git 恢复`,
    );
  }
  const pkg = decodeStatePackage(packageBuffer);
  if (pkg.projectId !== manifest.projectId) {
    throw new UsageError(
      `状态包属于项目 ${pkg.projectId}，当前项目是 ${manifest.projectId}；拒绝混用`,
    );
  }

  const dbPath = path.join(root, PROJECT_LAYOUT.database);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    const project = getProject(db);
    if (project && project.id !== manifest.projectId) {
      throw new UsageError(
        `数据库属于项目 ${project.id}，当前项目是 ${manifest.projectId}；拒绝混用`,
      );
    }
    const result = restoreFromPackage(db, pkg, {
      rootPath: root,
      fromCommit: options.sha,
      idempotencyKey: `restore-commit-${options.sha}${options.label ? `-${options.label}` : ''}`,
    });
    writeManifest(root, { ...manifest, branch: result.branchName });
    return result;
  } finally {
    closeDatabase(db);
  }
}

export interface LogEntry {
  kind: 'checkpoint' | 'commit';
  id: string;
  seq: number | null;
  label: string;
  trigger: string;
  at: string;
}

export function runLog(dir: string | undefined, limit = 20): LogEntry[] {
  const opened = openProject(dir);
  try {
    const branch = getActiveBranch(opened.db);
    if (!branch) throw new UsageError('项目没有活动分支');
    const checkpoints = opened.db
      .prepare(
        `SELECT id, seq, label, trigger, created_at AS at
         FROM checkpoint WHERE branch_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(branch.id, limit) as {
      id: string;
      seq: number;
      label: string;
      trigger: string;
      at: string;
    }[];
    const entries: LogEntry[] = checkpoints.map((row) => ({
      kind: 'checkpoint',
      id: row.id,
      seq: row.seq,
      label: row.label,
      trigger: row.trigger,
      at: row.at,
    }));
    if (git.isRepo(opened.root)) {
      for (const commit of git.log(opened.root, limit)) {
        const match = /Noryth-Checkpoint:\s*(\S+)/.exec(commit.body);
        entries.push({
          kind: 'commit',
          id: commit.sha,
          seq: null,
          label: match ? `绑定检查点 ${match[1]}` : commit.body.split('\n')[0] ?? '',
          trigger: 'git',
          at: '',
        });
      }
    }
    return entries.sort((a, b) => (b.seq ?? -1) - (a.seq ?? -1));
  } finally {
    opened.close();
  }
}

export function formatRestore(result: RestoreResult): string[] {
  const replay = result.replay ? '（幂等重放）' : '';
  const lines = result.fromCommit
    ? [
        `已从提交 ${result.fromCommit.slice(0, 7)} 恢复${replay} · ${result.replay ? '分支' : '新分支'} ${result.branchName}`,
        `  包内 seq ${result.packageSeq ?? result.targetSeq} · 新 head ${result.headSeq} · 快照 seq ${result.snapshotSeq}`,
      ]
    : [
        `已回退到 seq ${result.targetSeq}${replay} · ${result.replay ? '分支' : '新分支'} ${result.branchName}`,
        `  旧分支   ${result.fromBranchId}（保留，随时可切回）`,
        `  快照     seq ${result.snapshotSeq} · 重放 ${result.replayedEvents} 个事件`,
        `  新 head  ${result.headSeq}`,
        '  影响（回退会失去）',
      ];
  if (!result.fromCommit) {
    for (const row of result.impact) {
      if (row.lost === 0) continue;
      lines.push(`    ${row.label}  ${row.lost}`);
    }
  }
  lines.push(
    `  8 域计数  消息 ${result.counts.messages} · 事实 ${result.counts.facts} · 认知 ${result.counts.cognition} · 关系 ${result.counts.relations}`,
  );
  lines.push(
    `            正文 ${result.counts.chapters} · 卡牌 ${result.counts.cards} · 摘要 ${result.counts.summaries} · 向量 ${result.counts.vectors}`,
  );
  lines.push(
    result.fromCommit
      ? '  原分支与提交未删除；恢复只重建本地状态。'
      : '  回退只恢复本地状态；已发送的模型请求与已产生的费用不会退回。',
  );
  return lines;
}
