/** P2 CLI：记忆节点 / 检索 / 嵌入 / 后台任务。 */
import type {
  EmbeddingProvider,
  JobKind,
  JobStatus,
  MemoryKind,
  MemorySearchResult,
} from '@noryth/core';
import { PARAMS } from '@noryth/core';
import {
  CommandBus,
  UsageError,
  getActiveBranch,
  listClues,
  listJobs,
  listMemory,
  memoryTree,
  searchMemories,
  type ClueListItem,
  type JobListItem,
  type MemoryListItem,
  type MemoryTree,
} from '@noryth/store';
import { openProject, openProjectForWrite } from './project.js';

export interface MemoryAddOptions {
  dir?: string;
  kind: MemoryKind;
  text: string;
  importance?: number;
  pinned?: boolean;
  hard?: boolean;
  sensitivity?: number;
  owner?: string;
  slot?: string;
  sourceSeq?: number;
  resolvedSeq?: number;
}

export function runMemoryAdd(options: MemoryAddOptions): {
  id: string;
  kind: string;
  pinned: boolean;
  hard: boolean;
} {
  const opened = openProjectForWrite(options.dir);
  try {
    const bus = new CommandBus(opened.db);
    const result = bus.submit<{ id: string; kind: string; pinned: boolean; hard: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.add',
        idempotencyKey: `cli-memory-${getActiveBranch(opened.db)!.headSeq}-${options.text.slice(0, 12)}`,
        payload: {
          kind: options.kind,
          text: options.text,
          ...(options.importance !== undefined ? { importance: options.importance } : {}),
          ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
          ...(options.hard !== undefined ? { hard: options.hard } : {}),
          ...(options.sensitivity !== undefined ? { sensitivity: options.sensitivity } : {}),
          ...(options.owner !== undefined ? { ownerId: options.owner } : {}),
          ...(options.slot !== undefined ? { slotKey: options.slot } : {}),
          ...(options.sourceSeq !== undefined ? { sourceSeq: options.sourceSeq } : {}),
          ...(options.resolvedSeq !== undefined ? { resolvedSeq: options.resolvedSeq } : {}),
        },
      },
    );
    return result.result;
  } finally {
    opened.close();
  }
}

export function runMemoryList(
  dir: string | undefined,
  options: { kind?: MemoryKind; owner?: string; limit?: number } = {},
): MemoryListItem[] {
  const opened = openProject(dir);
  try {
    return listMemory(opened.db, options);
  } finally {
    opened.close();
  }
}

export async function runMemorySearch(
  dir: string | undefined,
  options: {
    text: string;
    slot?: string;
    as?: string;
    limit?: number;
    provider: EmbeddingProvider;
  },
): Promise<MemorySearchResult & { provider: string }> {
  const opened = openProject(dir);
  try {
    const [queryVector] = await options.provider.embed([options.text]);
    const result = searchMemories(opened.db, {
      text: options.text,
      slotKey: options.slot,
      asCharacterId: options.as,
      limit: options.limit,
      queryVector,
    });
    return { ...result, provider: options.provider.name };
  } finally {
    opened.close();
  }
}

export function runClueList(
  dir: string | undefined,
  options: { stale?: boolean } = {},
): ClueListItem[] {
  const opened = openProject(dir);
  try {
    return listClues(opened.db, { staleOnly: options.stale });
  } finally {
    opened.close();
  }
}

export function runMemoryTree(dir: string | undefined, nodeId: string): MemoryTree {
  const opened = openProject(dir);
  try {
    return memoryTree(opened.db, nodeId);
  } finally {
    opened.close();
  }
}

export function runMemoryDelete(dir: string | undefined, nodeId: string): { id: string } {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ id: string }>(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.delete',
        idempotencyKey: `cli-memory-del-${nodeId}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: { id: nodeId },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export interface MemoryEmbedOptions {
  dir?: string;
  ids?: string[];
  limit?: number;
  provider: EmbeddingProvider;
}

/** 给还没有向量的节点补嵌入；一次命令最多 50 条（事件 payload 不无限膨胀）。 */
export async function runMemoryEmbed(options: MemoryEmbedOptions): Promise<{
  updated: number;
  provider: string;
  scanned: number;
}> {
  const opened = openProjectForWrite(options.dir);
  try {
    const branchId = getActiveBranch(opened.db)!.id;
    let targets: { id: string; text: string }[];
    if (options.ids && options.ids.length > 0) {
      const rows = opened.db
        .prepare(
          `SELECT id, text FROM memory_node WHERE branch_id = ? AND id IN (${options.ids
            .map(() => '?')
            .join(',')}) ORDER BY id`,
        )
        .all(branchId, ...options.ids) as { id: string; text: string }[];
      for (const id of options.ids) {
        if (!rows.some((row) => row.id === id)) throw new UsageError(`记忆节点不存在：${id}`);
      }
      targets = rows;
    } else {
      targets = opened.db
        .prepare(
          `SELECT id, text FROM memory_node WHERE branch_id = ? AND embedding IS NULL
           ORDER BY importance DESC, id LIMIT ?`,
        )
        .all(branchId, Math.min(50, options.limit ?? 20)) as { id: string; text: string }[];
    }
    if (targets.length === 0) return { updated: 0, provider: options.provider.name, scanned: 0 };

    const vectors = await options.provider.embed(targets.map((row) => row.text));
    const bus = new CommandBus(opened.db);
    let updated = 0;
    for (let i = 0; i < targets.length; i += 50) {
      const slice = targets.slice(i, i + 50);
      const result = bus.submit<{ updated: number }>(
        { type: 'user', id: 'author' },
        {
          kind: 'memory.embed',
          idempotencyKey: `cli-embed-${getActiveBranch(opened.db)!.headSeq}`,
          payload: {
            updates: slice.map((row, j) => ({
              id: row.id,
              vector: [...vectors[i + j]!],
              model: options.provider.name,
            })),
          },
        },
      );
      updated += result.result.updated;
    }
    return { updated, provider: options.provider.name, scanned: targets.length };
  } finally {
    opened.close();
  }
}

export interface JobEnqueueOptions {
  dir?: string;
  kind: JobKind;
  targetId?: string;
  expectedSeq?: number;
  payload?: Record<string, unknown>;
}

export function runJobEnqueue(options: JobEnqueueOptions): {
  jobId: string;
  generation: number;
  expectedSeq: number;
} {
  const opened = openProjectForWrite(options.dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ jobId: string; generation: number; expectedSeq: number }>(
      { type: 'user', id: 'author' },
      {
        kind: 'job.enqueue',
        idempotencyKey: `cli-job-${options.kind}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          kind: options.kind,
          ...(options.targetId !== undefined ? { targetId: options.targetId } : {}),
          ...(options.expectedSeq !== undefined ? { expectedSeq: options.expectedSeq } : {}),
          ...(options.payload !== undefined ? { payload: options.payload } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export function runJobList(
  dir: string | undefined,
  options: { status?: string } = {},
): JobListItem[] {
  const opened = openProject(dir);
  try {
    return listJobs(opened.db, options);
  } finally {
    opened.close();
  }
}

export interface JobRunResult {
  jobId: string;
  kind: string;
  status: JobStatus;
  detail: string;
}

/**
 * 执行队列。P2 只实现 embed：摘要由场景关闭同步完成，extract/index 属于 P3。
 * 没有 runner 的任务被标记 failed（不是静默 done），队列不会假装成功。
 */
export async function runJobRun(
  dir: string | undefined,
  options: { limit: number; provider: EmbeddingProvider },
): Promise<JobRunResult[]> {
  const results: JobRunResult[] = [];
  for (let i = 0; i < options.limit; i += 1) {
    const queued = runJobList(dir, { status: 'queued' });
    if (queued.length === 0) break;
    const opened = openProjectForWrite(dir);
    let claimed: { id: string; kind: JobKind; targetId: string | null } | null = null;
    try {
      const bus = new CommandBus(opened.db);
      const result = bus.submit<{
        job: { id: string; kind: JobKind; targetId: string | null } | null;
      }>(
        { type: 'user', id: 'system' },
        {
          kind: 'job.claim',
          idempotencyKey: `cli-job-claim-${getActiveBranch(opened.db)!.headSeq}`,
          payload: {},
        },
      );
      claimed = result.result.job;
    } catch (error) {
      if (error instanceof UsageError && /队列为空/.test(error.message)) break;
      throw error;
    } finally {
      opened.close();
    }
    if (!claimed) break;

    let status: JobStatus = 'done';
    let detail = '';
    try {
      if (claimed.kind === 'embed') {
        const embedded = await runMemoryEmbed({
          dir,
          ids: claimed.targetId ? [claimed.targetId] : undefined,
          limit: 50,
          provider: options.provider,
        });
        detail = `嵌入 ${embedded.updated} 条（${embedded.provider}）`;
      } else {
        status = 'failed';
        detail = `P2 没有 ${claimed.kind} 作业执行器（摘要在场景关闭时同步完成；其余属于 P3）`;
      }
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    const finishOpened = openProjectForWrite(dir);
    try {
      const bus = new CommandBus(finishOpened.db);
      bus.submit(
        { type: 'user', id: 'system' },
        {
          kind: 'job.finish',
          idempotencyKey: `cli-job-finish-${claimed.id}-${getActiveBranch(finishOpened.db)!.headSeq}`,
          payload: { jobId: claimed.id, status, ...(detail ? { error: detail } : {}) },
        },
      );
    } finally {
      finishOpened.close();
    }
    results.push({ jobId: claimed.id, kind: claimed.kind, status, detail });
  }
  return results;
}

export const MEMORY_KINDS = [
  'event',
  'summary',
  'fact',
  'preference',
  'relationship',
  'clue',
  'world',
] as const;

export const JOB_KINDS = ['summarize', 'embed', 'extract', 'index'] as const;

export const VECTOR_DIM = PARAMS['memory.vector_dim'];
