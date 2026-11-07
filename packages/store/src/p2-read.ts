/** P2 读路径：事实 / 锁 / 记忆 / 任务。只读，不写。 */
import { PARAMS, truthLabel, type Cardinality, type MemoryKind, type Truth } from '@noryth/core';
import type { Db } from './db.js';
import { UsageError } from './errors.js';

function activeBranch(db: Db): string {
  const row = db
    .prepare('SELECT active_branch_id AS id FROM project_state LIMIT 1')
    .get() as { id: string } | undefined;
  if (!row) throw new UsageError('项目没有活动分支');
  return row.id;
}

export interface EntityListItem {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  status: string;
  createdSeq: number | null;
}

export function listEntities(
  db: Db,
  options: { kind?: string; name?: string; branchId?: string } = {},
): EntityListItem[] {
  const branchId = options.branchId ?? activeBranch(db);
  const clauses = ['branch_id = ?'];
  const params: unknown[] = [branchId];
  if (options.kind) {
    clauses.push('kind = ?');
    params.push(options.kind);
  }
  if (options.name) {
    clauses.push(
      `(name = ? OR id = ? OR EXISTS (SELECT 1 FROM json_each(entity.aliases) WHERE json_each.value = ?))`,
    );
    params.push(options.name, options.name, options.name);
  }
  const rows = db
    .prepare(
      `SELECT id, kind, name, aliases, status, created_seq AS createdSeq
       FROM entity WHERE ${clauses.join(' AND ')} ORDER BY kind, name`,
    )
    .all(...params) as {
    id: string;
    kind: string;
    name: string;
    aliases: string;
    status: string;
    createdSeq: number | null;
  }[];
  return rows.map((row) => {
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(row.aliases) as unknown;
      if (Array.isArray(parsed)) aliases = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      aliases = [];
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      aliases,
      status: row.status,
      createdSeq: row.createdSeq,
    };
  });
}

export interface FactListItem {
  id: string;
  subject: string;
  predicate: string;
  objectText: string;
  truth: Truth;
  truthLabel: string;
  secrecy: number;
  slotKey: string;
  validFrom: string;
  validTo: string | null;
  sourceSeq: number | null;
}

function objectText(object: unknown): string {
  if (object === null) return 'null';
  if (typeof object === 'string') return object;
  if (typeof object === 'number' || typeof object === 'boolean') return String(object);
  if (Array.isArray(object)) return object.map(objectText).join('、');
  const record = object as Record<string, unknown>;
  if (typeof record.name === 'string') return record.name;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(object);
}

export function listFacts(
  db: Db,
  options: {
    subject?: string;
    predicate?: string;
    includeHistorical?: boolean;
    branchId?: string;
  } = {},
): FactListItem[] {
  const branchId = options.branchId ?? activeBranch(db);
  const clauses = ['f.branch_id = ?'];
  const params: unknown[] = [branchId];
  if (!options.includeHistorical) clauses.push('f.valid_to IS NULL');
  if (options.subject) {
    clauses.push('(e.id = ? OR e.name = ?)');
    params.push(options.subject, options.subject);
  }
  if (options.predicate) {
    clauses.push('f.predicate = ?');
    params.push(options.predicate);
  }
  const rows = db
    .prepare(
      `SELECT f.id, e.name AS subject, f.predicate, f.object_json, f.truth, f.secrecy,
              f.slot_key, f.valid_from, f.valid_to, f.source_seq
       FROM fact f JOIN entity e ON e.id = f.subject_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY f.valid_from DESC, e.name, f.predicate, f.id`,
    )
    .all(...params) as {
    id: string;
    subject: string;
    predicate: string;
    object_json: string;
    truth: number;
    secrecy: number;
    slot_key: string;
    valid_from: string;
    valid_to: string | null;
    source_seq: number | null;
  }[];
  return rows.map((row) => {
    const truth = Number(row.truth) as Truth;
    let object: unknown = null;
    try {
      object = JSON.parse(row.object_json) as unknown;
    } catch {
      object = row.object_json;
    }
    return {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      objectText: objectText(object),
      truth,
      truthLabel: truthLabel(truth),
      secrecy: row.secrecy,
      slotKey: row.slot_key,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      sourceSeq: row.source_seq,
    };
  });
}

export interface LockListItem {
  scope: string;
  slotKey: string;
  reason: string;
  lockedBy: string;
  createdAt: string;
}

export function listLocks(db: Db, branchId = activeBranch(db)): LockListItem[] {
  return (
    db
      .prepare(
        `SELECT scope, slot_key AS slotKey, reason, locked_by AS lockedBy, created_at AS createdAt
         FROM lock WHERE branch_id = ? ORDER BY scope, slot_key`,
      )
      .all(branchId) as LockListItem[]
  ).map((row) => ({ ...row }));
}

export interface PredicateItem {
  predicate: string;
  cardinality: Cardinality;
  description: string;
  builtin: boolean;
}

export function listPredicates(db: Db): PredicateItem[] {
  return (
    db
      .prepare(
        'SELECT predicate, cardinality, description, builtin FROM predicate_spec ORDER BY predicate',
      )
      .all() as { predicate: string; cardinality: Cardinality; description: string; builtin: number }[]
  ).map((row) => ({ ...row, builtin: row.builtin === 1 }));
}

export interface MemoryListItem {
  id: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  conf: number;
  pinned: boolean;
  hard: boolean;
  sensitivity: number;
  owner: string | null;
  slotKey: string | null;
  sourceSeq: number | null;
  resolvedSeq: number | null;
  embedded: boolean;
  validFrom: string;
}

export function listMemory(
  db: Db,
  options: { kind?: MemoryKind; owner?: string; limit?: number; branchId?: string } = {},
): MemoryListItem[] {
  const branchId = options.branchId ?? activeBranch(db);
  const clauses = ['m.branch_id = ?'];
  const params: unknown[] = [branchId];
  if (options.kind) {
    clauses.push('m.kind = ?');
    params.push(options.kind);
  }
  if (options.owner) {
    clauses.push('(o.id = ? OR o.name = ?)');
    params.push(options.owner, options.owner);
  }
  params.push(Math.max(1, options.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.text, m.importance, m.conf, m.pinned, m.hard, m.sensitivity,
              o.name AS owner, m.slot_key AS slotKey, m.source_seq AS sourceSeq,
              m.resolved_seq AS resolvedSeq, m.embedding IS NOT NULL AS embedded,
              m.valid_from AS validFrom
       FROM memory_node m LEFT JOIN entity o ON o.id = m.owner_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.importance DESC, m.id LIMIT ?`,
    )
    .all(...params) as {
    id: string;
    kind: MemoryKind;
    text: string;
    importance: number;
    conf: number;
    pinned: number;
    hard: number;
    sensitivity: number;
    owner: string | null;
    slotKey: string | null;
    sourceSeq: number | null;
    resolvedSeq: number | null;
    embedded: number;
    validFrom: string;
  }[];
  return rows.map((row) => ({
    ...row,
    pinned: row.pinned === 1,
    hard: row.hard === 1,
    embedded: row.embedded === 1,
  }));
}

export interface MemoryTree {
  summary: MemoryListItem | null;
  children: { id: string; kind: string; text: string; importance: number }[];
}

export function memoryTree(db: Db, nodeId: string): MemoryTree {
  const row = db
    .prepare(
      `SELECT m.id, m.kind, m.text, m.importance, m.conf, m.pinned, m.hard, m.sensitivity,
              o.name AS owner, m.slot_key AS slotKey, m.source_seq AS sourceSeq,
              m.resolved_seq AS resolvedSeq, m.embedding IS NOT NULL AS embedded,
              m.valid_from AS validFrom
       FROM memory_node m LEFT JOIN entity o ON o.id = m.owner_id
       WHERE m.id = ? AND m.branch_id = (SELECT active_branch_id FROM project_state LIMIT 1)`,
    )
    .get(nodeId) as
    | {
        id: string;
        kind: MemoryKind;
        text: string;
        importance: number;
        conf: number;
        pinned: number;
        hard: number;
        sensitivity: number;
        owner: string | null;
        slotKey: string | null;
        sourceSeq: number | null;
        resolvedSeq: number | null;
        embedded: number;
        validFrom: string;
      }
    | undefined;
  if (!row) throw new UsageError(`记忆节点不存在：${nodeId}`);
  const summary: MemoryListItem = {
    ...row,
    pinned: row.pinned === 1,
    hard: row.hard === 1,
    embedded: row.embedded === 1,
  };
  const children = db
    .prepare(
      `SELECT c.id, c.kind, c.text, c.importance
       FROM memory_edge e JOIN memory_node c ON c.id = e.src
       WHERE e.dst = ? AND e.kind = 'DERIVED_FROM' ORDER BY c.source_seq, c.id`,
    )
    .all(nodeId) as { id: string; kind: string; text: string; importance: number }[];
  return { summary, children: children.map((child) => ({ ...child })) };
}

export interface ClueListItem {
  id: string;
  text: string;
  importance: number;
  sourceSeq: number | null;
  chaptersCovered: number;
  stale: boolean;
}

/**
 * 未回收线索。陈旧判定用 `clue_max_age_chapters`：
 * 统计 `chapter.covered_until_seq` 已经越过线索 source_seq 的章节数。
 * P2 还没有章节投影时恒为 0（不陈旧），P3 成章后自动生效。
 */
export function listClues(
  db: Db,
  options: { staleOnly?: boolean; branchId?: string } = {},
): ClueListItem[] {
  const branchId = options.branchId ?? activeBranch(db);
  const maxAge = PARAMS['consistency.clue_max_age_chapters'];
  const rows = db
    .prepare(
      `SELECT id, text, importance, source_seq AS sourceSeq
       FROM memory_node WHERE branch_id = ? AND kind = 'clue' AND resolved_seq IS NULL
         AND sensitivity < 3
       ORDER BY importance DESC, id`,
    )
    .all(branchId) as { id: string; text: string; importance: number; sourceSeq: number | null }[];
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM chapter WHERE branch_id = ? AND covered_until_seq IS NOT NULL
       AND covered_until_seq >= ?`,
  );
  return rows
    .map((row) => {
      const chaptersCovered =
        row.sourceSeq === null ? 0 : Number((count.get(branchId, row.sourceSeq) as { c: number }).c);
      return {
        ...row,
        chaptersCovered,
        stale: chaptersCovered > maxAge,
      };
    })
    .filter((row) => !options.staleOnly || row.stale);
}

export interface JobListItem {
  id: string;
  kind: string;
  targetId: string | null;
  expectedSeq: number;
  generation: number;
  status: string;
  createdAt: string;
}

export function listJobs(
  db: Db,
  options: { status?: string; branchId?: string } = {},
): JobListItem[] {
  const branchId = options.branchId ?? activeBranch(db);
  const rows = options.status
    ? (db
        .prepare(
          `SELECT id, kind, target_id AS targetId, expected_seq AS expectedSeq, generation,
                  status, created_at AS createdAt
           FROM job WHERE branch_id = ? AND status = ? ORDER BY created_at, rowid`,
        )
        .all(branchId, options.status) as JobListItem[])
    : (db
        .prepare(
          `SELECT id, kind, target_id AS targetId, expected_seq AS expectedSeq, generation,
                  status, created_at AS createdAt
           FROM job WHERE branch_id = ? ORDER BY created_at, rowid`,
        )
        .all(branchId) as JobListItem[]);
  return rows.map((row) => ({ ...row }));
}
