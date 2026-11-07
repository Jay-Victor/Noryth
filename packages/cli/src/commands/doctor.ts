import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import * as git from '@noryth/git';
import { closeDatabase, findSchemaPath, openDatabase } from '@noryth/store';
import { findProjectRoot } from '../project-root.js';
import { openProject } from './project.js';

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * 环境自检。P0 不做任何模型调用，所以模型连通性显式标 skip，
 * 而不是假装检查过。
 */
export function runDoctor(dirArg?: string): DoctorResult {
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    status: nodeMajor >= 22 ? 'ok' : 'fail',
    detail: `v${process.versions.node}（要求 >= 22）`,
  });

  try {
    const db = openDatabase(':memory:');
    try {
      const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
      checks.push({ name: 'sqlite', status: 'ok', detail: version });
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    checks.push({
      name: 'sqlite',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    checks.push({ name: 'git', status: 'ok', detail: git.gitVersion() });
  } catch (error) {
    checks.push({
      name: 'git',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    checks.push({ name: 'schema', status: 'ok', detail: findSchemaPath() });
  } catch (error) {
    checks.push({
      name: 'schema',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const root = dirArg ? path.resolve(dirArg) : findProjectRoot(process.cwd());
  if (!root) {
    checks.push({ name: 'project', status: 'skip', detail: '当前目录不在项目内（用 --project 指定）' });
  } else {
    try {
      accessSync(root, constants.W_OK);
      const opened = openProject(root);
      try {
        checks.push({
          name: 'project',
          status: 'ok',
          detail: `${opened.status.project.name} · schema v${opened.status.project.schemaVersion}`,
        });
        checks.push({
          name: 'project-write',
          status: 'ok',
          detail: '目录可写',
        });
      } finally {
        opened.close();
      }
    } catch (error) {
      checks.push({
        name: 'project',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  checks.push({
    name: 'model',
    status: 'skip',
    detail: 'P0 不做模型调用；连通性自检在 P1 接入模型后启用',
  });

  return { checks, ok: checks.every((c) => c.status !== 'fail') };
}

export function formatDoctor(result: DoctorResult): string[] {
  const mark = (status: CheckStatus): string => (status === 'ok' ? '✓' : status === 'fail' ? '✗' : '–');
  const lines = result.checks.map(
    (c) => `  ${mark(c.status)} ${c.name.padEnd(14)} ${c.detail}`,
  );
  lines.push(result.ok ? '环境自检通过' : '环境自检失败');
  return lines;
}
