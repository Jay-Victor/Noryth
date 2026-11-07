/**
 * 状态包落点：写完整状态包 + Git 提交。
 *
 * 数据库被 .gitignore 排除，Git 里只有章节文件（P3 起）和这份状态包。
 * 所以提交必须带 `Noryth-Checkpoint: <id>`，让"提交 ↔ 检查点"双向可查；
 * `restore --from-commit` 读的就是这个提交里的 .noryth/state.json.zst。
 */
import { PARAMS, PROJECT_LAYOUT, STATE_PACKAGE_PATH } from '@noryth/core';
import {
  SCHEMA_VERSION,
  exportStatePackage,
  getActiveBranch,
  writeStatePackage,
  type Db,
} from '@noryth/store';
import * as git from '@noryth/git';

export interface StateCommit {
  commit: string | null;
  packagePath: string | null;
  error: string | null;
}

/**
 * 写包 + 提交。任何一步失败都返回 error，不抛错：
 * 状态已经在 SQLite 里落好，Git 失败不该把一次成功的演出变成失败。
 *
 * `respectParam=false` 用于用户显式执行的 `noryth commit`：
 * `git.commit_on_scene_close` 只控制自动提交，不该拦住手动提交。
 */
export function commitState(
  root: string,
  db: Db,
  subject: string,
  checkpointId: string,
  respectParam = true,
): StateCommit {
  const branch = getActiveBranch(db);
  if (!branch) {
    return { commit: null, packagePath: null, error: '项目没有活动分支' };
  }
  try {
    const buffer = exportStatePackage(db, branch.id, branch.headSeq);
    const written = writeStatePackage(root, buffer);
    if (respectParam && PARAMS['git.commit_on_scene_close'] !== true) {
      return { commit: null, packagePath: written.path, error: null };
    }
    if (!git.isRepo(root)) {
      return {
        commit: null,
        packagePath: written.path,
        error: '目录不是 Git 仓库：状态包已写入，但没有提交',
      };
    }
    const cleanSubject = subject.replace(/\s+/g, ' ').trim() || '状态提交';
    const message = [
      `noryth: ${cleanSubject}`,
      '',
      `Noryth-Checkpoint: ${checkpointId}`,
      `Noryth-Branch: ${branch.name}`,
      `Noryth-Schema: ${SCHEMA_VERSION}`,
      `Noryth-Event: ${branch.headSeq}`,
    ].join('\n');
    const sha = git.commitPaths(root, message, [
      PROJECT_LAYOUT.manifest,
      STATE_PACKAGE_PATH,
      PROJECT_LAYOUT.chapters,
    ]);
    return {
      commit: sha || null,
      packagePath: written.path,
      error: null,
    };
  } catch (error) {
    return {
      commit: null,
      packagePath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 场景关闭的自动落点：受 `git.commit_on_scene_close` 控制。 */
export function commitSceneClose(
  root: string,
  db: Db,
  sceneTitle: string,
  checkpointId: string,
): StateCommit {
  return commitState(root, db, `场景关闭 ${sceneTitle}`, checkpointId);
}
