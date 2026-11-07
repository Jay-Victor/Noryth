import { canonicalJson, type Branch, type CheckpointTrigger, type Project } from '@noryth/core';
import type { Db } from './db.js';
import { newId } from './ids.js';
import { SCHEMA_VERSION } from './schema.js';

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  now?: string;
  id?: string;
}

export interface CreatedProject {
  projectId: string;
  branchId: string;
}

/**
 * 建项目 + main 分支 + 活动指针 + 一条 project.created 审计事件。
 * 一个事务：半建成的项目比没有项目更难排查。
 */
export function createProject(db: Db, input: CreateProjectInput): CreatedProject {
  const now = input.now ?? new Date().toISOString();
  const projectId = input.id ?? newId('p');
  const branchId = newId('b');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO project(id, name, root_path, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, input.name, input.rootPath, SCHEMA_VERSION, now, now);
    db.prepare(
      `INSERT INTO branch(id, project_id, parent_id, fork_seq, head_seq, name, reason, created_at)
       VALUES (?, ?, NULL, 0, 0, 'main', '初始', ?)`,
    ).run(branchId, projectId, now);
    db.prepare(
      `INSERT INTO project_state(project_id, active_branch_id, active_scene_id, head_seq)
       VALUES (?, ?, NULL, 0)`,
    ).run(projectId, branchId);
    db.prepare(
      `INSERT INTO event(project_id, branch_id, kind, actor_type, actor_id, payload, idempotency_key, created_at)
       VALUES (?, ?, 'project.created', 'system', NULL, ?, NULL, ?)`,
    ).run(projectId, branchId, canonicalJson({ name: input.name }), now);
  });
  tx.immediate();
  return { projectId, branchId };
}

export function getProject(db: Db): Project | null {
  const row = db
    .prepare(
      `SELECT id, name, root_path, schema_version, created_at, updated_at
       FROM project ORDER BY created_at LIMIT 1`,
    )
    .get() as
    | {
        id: string;
        name: string;
        root_path: string;
        schema_version: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getActiveBranch(db: Db): Branch | null {
  const row = db
    .prepare(
      `SELECT b.id, b.project_id, b.parent_id, b.fork_seq, b.head_seq, b.name, b.reason, b.created_at
       FROM project_state ps JOIN branch b ON b.id = ps.active_branch_id
       LIMIT 1`,
    )
    .get() as
    | {
        id: string;
        project_id: string;
        parent_id: string | null;
        fork_seq: number;
        head_seq: number;
        name: string;
        reason: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    forkSeq: row.fork_seq,
    headSeq: row.head_seq,
    name: row.name,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export interface CreateCheckpointInput {
  branchId: string;
  seq: number;
  label: string;
  trigger: CheckpointTrigger;
  now?: string;
}

export function createCheckpoint(db: Db, input: CreateCheckpointInput): string {
  const id = newId('ck');
  db.prepare(
    `INSERT INTO checkpoint(id, branch_id, seq, label, trigger, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.branchId, input.seq, input.label, input.trigger, input.now ?? new Date().toISOString());
  return id;
}

/** 只在 init 的 git 提交失败时用于回滚；不对外提供"删检查点"命令。 */
export function deleteCheckpoint(db: Db, id: string): void {
  db.prepare('DELETE FROM checkpoint WHERE id = ?').run(id);
}
