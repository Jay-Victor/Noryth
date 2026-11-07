import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  INIT_ENTRIES,
  MANIFEST_SCHEMA_VERSION,
  PROJECT_GITIGNORE,
  PROJECT_LAYOUT,
  type Manifest,
} from '@noryth/core';
import * as git from '@noryth/git';
import {
  IoError,
  UsageError,
  closeDatabase,
  createCheckpoint,
  createProject,
  deleteCheckpoint,
  getActiveBranch,
  getProject,
  migrate,
  openDatabase,
} from '@noryth/store';
import type { Warning } from '../output.js';
import { assertManifestVersion, readManifest, writeManifest } from '../project-root.js';

export interface InitInput {
  dir: string;
  name?: string;
}

export interface InitResult {
  projectId: string;
  name: string;
  rootPath: string;
  branch: string;
  headSeq: number;
  created: boolean;
  files: string[];
  commit: string | null;
  checkpointId: string | null;
  warnings: Warning[];
}

const ALLOWED_EXISTING = new Set(['.git', '.gitignore', '.noryth', 'chapters', 'skills']);

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix;
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        /* 清理由失败的 init 可能遇到 Windows 句柄未释放，交给下次 open 报错 */
      }
    }
  }
}

/**
 * noryth init
 * 1) 新目录 → 建骨架 + DB + 首次提交
 * 2) 已有项目 → 校验并补齐缺失的骨架，绝不覆盖 noryth.json（用户可能改了 settings）
 * 3) 半初始化（DB 有 project 但 manifest 丢了）→ 从 DB 恢复 manifest
 */
export function runInit(input: InitInput): InitResult {
  const root = path.resolve(input.dir);
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new IoError(`目标不是目录：${root}`);
  }
  ensureDir(root);

  const manifestFile = path.join(root, PROJECT_LAYOUT.manifest);
  let manifest: Manifest | null = null;
  if (existsSync(manifestFile)) {
    manifest = readManifest(root);
    assertManifestVersion(manifest);
  } else {
    const foreign = readdirSync(root).filter((entry) => !ALLOWED_EXISTING.has(entry));
    if (foreign.length > 0) {
      throw new IoError(
        `目录非空且不是 Noryth 项目（先清空或换一个目录）：${foreign.slice(0, 5).join(', ')}`,
      );
    }
  }

  for (const dir of [PROJECT_LAYOUT.stateDir, PROJECT_LAYOUT.chapters, PROJECT_LAYOUT.skills]) {
    ensureDir(path.join(root, dir));
  }

  const dbPath = path.join(root, PROJECT_LAYOUT.database);
  const db = openDatabase(dbPath);
  const warnings: Warning[] = [];
  const requestedName = input.name?.trim();
  if (manifest && requestedName && requestedName !== manifest.name) {
    warnings.push({
      code: 'name_ignored',
      message: `项目已存在，--name "${requestedName}" 未生效（现有名称：${manifest.name}）`,
    });
  }
  let created = false;
  let wroteManifest = false;
  let checkpointId: string | null = null;
  let commit: string | null = null;

  try {
    const migration = migrate(db);
    if (migration.applied) {
      warnings.push({ code: 'schema_created', message: `已建库（schema v${migration.to}）` });
    }

    let project = getProject(db);
    if (!project) {
      if (manifest) {
        throw new IoError(
          `noryth.json 存在但数据库是空的：${dbPath}（项目文件被替换或损坏）`,
        );
      }
      createProject(db, {
        name: input.name?.trim() || path.basename(root) || '未命名项目',
        rootPath: root,
      });
      project = getProject(db);
      created = true;
    }
    if (!project) throw new IoError('建项目失败：数据库中仍没有 project 行');

    if (manifest && manifest.projectId !== project.id) {
      throw new IoError(
        `noryth.json 的 projectId（${manifest.projectId}）与数据库（${project.id}）不一致`,
      );
    }
    if (!manifest) {
      manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        projectId: project.id,
        name: project.name,
        createdAt: project.createdAt,
        branch: 'main',
      };
      writeManifest(root, manifest);
      wroteManifest = true;
      if (!created) {
        warnings.push({
          code: 'manifest_recovered',
          message: '从数据库恢复了 noryth.json',
        });
      }
    }

    const gitignorePath = path.join(root, PROJECT_LAYOUT.gitignore);
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, PROJECT_GITIGNORE, 'utf8');
    }

    const branch = getActiveBranch(db);
    if (!branch) throw new IoError('项目缺少活动分支');

    git.init(root);
    if (!git.hasCommits(root)) {
      checkpointId = createCheckpoint(db, {
        branchId: branch.id,
        seq: branch.headSeq,
        label: '初始化',
        trigger: 'git_commit',
      });
      const message = [
        `noryth init: ${manifest.name}`,
        '',
        `Noryth-Checkpoint: ${checkpointId}`,
        `Noryth-Branch: ${branch.name}`,
        `Noryth-Schema: ${manifest.schemaVersion}`,
      ].join('\n');
      try {
        commit = git.commitAll(root, message);
      } catch (error) {
        deleteCheckpoint(db, checkpointId);
        checkpointId = null;
        throw new IoError(
          `Git 首次提交失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!commit) {
        deleteCheckpoint(db, checkpointId);
        checkpointId = null;
        warnings.push({ code: 'git_no_commit', message: '没有可提交的内容，未创建提交' });
      }
    } else {
      warnings.push({
        code: 'git_repo_exists',
        message: 'Git 已有提交，未创建新提交',
      });
      if (git.statusPorcelain(root)) {
        warnings.push({
          code: 'git_dirty',
          message: '工作区有未提交改动，已原样保留',
        });
      }
    }

    const files = INIT_ENTRIES.filter((entry) => existsSync(path.join(root, entry)));
    return {
      projectId: project.id,
      name: manifest.name,
      rootPath: root,
      branch: branch.name,
      headSeq: branch.headSeq,
      created,
      files: [...files],
      commit,
      checkpointId,
      warnings,
    };
  } catch (error) {
    if (created) {
      closeDatabase(db);
      removeDbFiles(dbPath);
      if (wroteManifest) {
        try {
          unlinkSync(manifestFile);
        } catch {
          /* 删除失败时保留 manifest，下一次 init 会明确报"数据库为空" */
        }
      }
    }
    throw error;
  } finally {
    closeDatabase(db);
  }
}

export function formatInitResult(result: InitResult): string[] {
  const lines: string[] = [];
  if (result.created) {
    lines.push(`已创建项目「${result.name}」`);
  } else {
    lines.push(`项目「${result.name}」已存在，校验通过（未改动内容）`);
  }
  lines.push(`  路径      ${result.rootPath}`);
  lines.push(`  项目 ID   ${result.projectId}`);
  lines.push(`  分支      ${result.branch} · head ${result.headSeq}`);
  if (result.commit) lines.push(`  首次提交  ${result.commit.slice(0, 7)}`);
  if (result.checkpointId) lines.push(`  检查点    ${result.checkpointId}`);
  lines.push('  文件清单');
  for (const file of result.files) lines.push(`    ${file}`);
  return lines;
}

export function normalizeInitName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  if (!trimmed) throw new UsageError('--name 不能为空');
  return trimmed;
}
