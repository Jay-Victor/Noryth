/** 手动落点：检查点 + 状态包 + Git 提交，不要求场景先关闭。 */
import {
  UsageError,
  createCheckpointWithSnapshot,
  getActiveBranch,
} from '@noryth/store';
import { openProjectForWrite } from './project.js';
import { commitState, type StateCommit } from '../state-export.js';

export interface CommitOptions {
  dir?: string;
  message?: string;
}

export interface CommitResult extends StateCommit {
  checkpointId: string;
  headSeq: number;
}

export function runCommit(options: CommitOptions = {}): CommitResult {
  const opened = openProjectForWrite(options.dir);
  try {
    const branch = getActiveBranch(opened.db);
    if (!branch) throw new UsageError('项目没有活动分支');
    const label = options.message ? `手动提交 · ${options.message}` : '手动提交';
    const checkpoint = createCheckpointWithSnapshot(opened.db, {
      branchId: branch.id,
      seq: branch.headSeq,
      label,
      trigger: 'manual',
    });
    const committed = commitState(
      opened.root,
      opened.db,
      label,
      checkpoint.checkpointId,
      false,
    );
    return {
      ...committed,
      checkpointId: checkpoint.checkpointId,
      headSeq: branch.headSeq,
    };
  } finally {
    opened.close();
  }
}

export function formatCommit(result: CommitResult): string[] {
  const lines = [
    `已写检查点 ${result.checkpointId} · seq ${result.headSeq}`,
  ];
  if (result.commit) {
    lines.push(`  Git      ${result.commit.slice(0, 7)} · .noryth/state.json.zst 已提交`);
  } else if (result.error) {
    lines.push(`  Git      未提交：${result.error}`);
  } else {
    lines.push('  Git      状态包已写入；本次没有提交');
  }
  return lines;
}
