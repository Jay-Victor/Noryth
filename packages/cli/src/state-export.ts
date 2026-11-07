/**
 * 场景关闭时的 Git 落点：写完整状态包 + 提交。
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

export interface SceneCloseCommit {
  commit: string | null;
  packagePath: string | null;
  error: string | null;
}

/**
 * 写包 + 提交。任何一步失败都返回 error，不抛错：
 * 场景已经在 SQLite 里关闭，提交失败不应该把一次成功的演出变成失败。
 */
export function commitSceneClose(
  root: string,
  db: Db,
  sceneTitle: string,
  checkpointId: string,
): SceneCloseCommit {
  const branch = getActiveBranch(db);
  if (!branch) {
    return { commit: null, packagePath: null, error: '项目没有活动分支' };
  }
  try {
    const buffer = exportStatePackage(db, branch.id, branch.headSeq);
    const written = writeStatePackage(root, buffer);
    if (PARAMS['git.commit_on_scene_close'] !== true) {
      return { commit: null, packagePath: written.path, error: null };
    }
    if (!git.isRepo(root)) {
      return {
        commit: null,
        packagePath: written.path,
        error: '目录不是 Git 仓库：状态包已写入，但没有提交',
      };
    }
    const message = [
      `noryth: 场景关闭 ${sceneTitle}`,
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
