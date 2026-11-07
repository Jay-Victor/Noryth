/**
 * 回退：快照 + 分支重放（01 §6 A6）。
 *
 * 1. 找 ≤ target 的最近快照；
 * 2. 新建分支 B'，parent = B，fork_seq = target；
 * 3. 快照按 8 域（以及场景/节拍等运行必需表）复制进 B'，所有主键重新分配、
 *    外键按映射改写；
 * 4. 重放 (snapshot.seq, target] 的事件到 B'；
 * 5. 在 B' 上写 restore 事件（记录 from_branch / from_seq）；
 * 6. 切换 project_state.active_branch_id；
 * 7. 返回逐域计数。
 *
 * 旧分支一行不删。回退不是销毁，是开一条新分支（I3）。
 */
import {
  RESTORE_DOMAINS,
  STATE_PACKAGE_FORMAT,
  STATE_PACKAGE_PATH,
  STATE_PACKAGE_VERSION,
  canonicalJson,
  domainImpact,
  emptyDomainCounts,
  sha256Hex,
  uniqueBranchName,
  validateRestoreTarget,
  type DomainCounts,
  type DomainImpact,
} from '@noryth/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Db } from './db.js';
import { ConstraintError, IoError, UsageError } from './errors.js';
import { newId } from './ids.js';
import { getActiveBranch, getProject } from './project.js';
import { SCHEMA_VERSION } from './schema.js';

const SNAPSHOT_VERSION = 1;

interface TableSpec {
  table: string;
  /** 单列主键时重新生成；复合主键不生成。 */
  idPrefix?: string;
  columns: string[];
  /** 外键列 → 目标表。 */
  refs?: Record<string, string>;
  /** JSON 列里出现的 entity id 数组。 */
  jsonEntityArrays?: string[];
  /** 需要遍历替换所有已知 id 的 JSON 列。 */
  json?: string[];
  /** 形如 `a|b|c` 的复合键列：按 `|` 拆分后逐段替换 id（lock.slot_key）。 */
  pipeRefs?: string[];
  /** 全局表（无 branch_id）：scope 不带占位符，导出/导入不按分支过滤。 */
  global?: boolean;
  /** 导入时若本地已有同主键行则保留本地定义（predicate_spec）。 */
  ignoreExisting?: boolean;
  /** 作用域 SQL（占位符 ? = branchId）。 */
  scope: string;
  orderBy: string;
}

const ENTITY_SCOPE = 'SELECT * FROM entity WHERE branch_id = ?';
const CHAPTER_SCOPE = 'chapter_id IN (SELECT id FROM chapter WHERE branch_id = ?)';

const TABLES: readonly TableSpec[] = [
  {
    // predicate_spec 是全局表：先导入它，fact 的外键才有落点。
    // 只导出 builtin=0 的自定义谓词；导入时已存在的定义优先（不回退语义）。
    table: 'predicate_spec',
    columns: ['predicate', 'cardinality', 'description', 'builtin'],
    scope: 'SELECT * FROM predicate_spec WHERE builtin = 0',
    orderBy: 'predicate',
    global: true,
    ignoreExisting: true,
  },
  {
    table: 'entity',
    idPrefix: 'e',
    columns: ['id', 'branch_id', 'kind', 'name', 'aliases', 'card', 'status', 'created_seq'],
    json: ['card'],
    scope: ENTITY_SCOPE,
    orderBy: 'rowid',
  },
  {
    table: 'agent_config',
    idPrefix: 'a',
    columns: [
      'id', 'branch_id', 'role_type', 'name', 'entity_id', 'model', 'temperature',
      'card', 'permissions', 'enabled',
    ],
    refs: { entity_id: 'entity' },
    json: ['card', 'permissions'],
    scope: 'SELECT * FROM agent_config WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'scene',
    idPrefix: 's',
    columns: [
      'id', 'branch_id', 'arc_id', 'idx', 'title', 'location_id', 'story_start',
      'story_end', 'timeline', 'present', 'goal', 'conflict_level', 'max_beats',
      'beats', 'state', 'exit_conditions', 'summary', 'opened_seq', 'closed_seq',
    ],
    refs: { location_id: 'entity' },
    jsonEntityArrays: ['present'],
    json: ['goal', 'exit_conditions'],
    scope: 'SELECT * FROM scene WHERE branch_id = ?',
    orderBy: 'idx',
  },
  {
    table: 'beat',
    idPrefix: 'b',
    columns: [
      'id', 'branch_id', 'scene_id', 'seq', 'agent_id', 'score', 'damped',
      'breakdown', 'mode', 'stale', 'stale_reason', 'created_at',
    ],
    refs: { scene_id: 'scene', agent_id: 'entity' },
    json: ['breakdown'],
    scope: 'SELECT * FROM beat WHERE branch_id = ?',
    orderBy: 'scene_id, seq',
  },
  {
    table: 'message',
    idPrefix: 'm',
    columns: [
      'id', 'branch_id', 'seq', 'scene_id', 'beat_id', 'agent_id', 'role_type',
      'prose', 'structured', 'audience', 'percept', 'content_hash', 'token_est',
      'created_at', 'supersedes_id',
    ],
    refs: { scene_id: 'scene', beat_id: 'beat', agent_id: 'entity', supersedes_id: 'message' },
    jsonEntityArrays: ['audience'],
    json: ['structured'],
    scope: 'SELECT * FROM message WHERE branch_id = ?',
    orderBy: 'seq',
  },
  {
    table: 'fact',
    idPrefix: 'f',
    columns: [
      'id', 'branch_id', 'subject_id', 'predicate', 'object_json', 'card', 'truth',
      'secrecy', 'valid_from', 'valid_to', 'source_seq', 'created_at',
    ],
    refs: { subject_id: 'entity' },
    json: ['object_json'],
    scope: 'SELECT * FROM fact WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'cognition',
    columns: [
      'branch_id', 'character_id', 'fact_id', 'attitude', 'certainty',
      'learned_seq', 'source_message_id', 'percept',
    ],
    refs: { character_id: 'entity', fact_id: 'fact', source_message_id: 'message' },
    scope: 'SELECT * FROM cognition WHERE branch_id = ?',
    orderBy: 'learned_seq, character_id, fact_id',
  },
  {
    table: 'relation',
    columns: ['branch_id', 'from_id', 'to_id', 'axis', 'value', 'updated_seq', 'reason'],
    refs: { from_id: 'entity', to_id: 'entity' },
    scope: 'SELECT * FROM relation WHERE branch_id = ?',
    orderBy: 'from_id, to_id, axis',
  },
  {
    table: 'chapter',
    idPrefix: 'ch',
    columns: [
      'id', 'branch_id', 'arc_id', 'idx', 'title', 'file_path', 'content_hash',
      'word_count', 'covered_until_seq', 'status', 'current_rev', 'updated_seq',
    ],
    scope: 'SELECT * FROM chapter WHERE branch_id = ?',
    orderBy: 'idx',
  },
  {
    table: 'revision',
    idPrefix: 'rv',
    columns: [
      'id', 'chapter_id', 'rev', 'parent_rev', 'content', 'content_hash', 'author',
      'reason', 'issue_ids', 'created_at',
    ],
    refs: { chapter_id: 'chapter' },
    json: ['issue_ids'],
    scope: `SELECT * FROM revision WHERE ${CHAPTER_SCOPE}`,
    orderBy: 'chapter_id, rev',
  },
  {
    table: 'chapter_scene',
    columns: ['chapter_id', 'scene_id', 'ord'],
    refs: { chapter_id: 'chapter', scene_id: 'scene' },
    scope: `SELECT * FROM chapter_scene WHERE ${CHAPTER_SCOPE}`,
    orderBy: 'chapter_id, ord',
  },
  {
    table: 'issue',
    idPrefix: 'is',
    columns: [
      'id', 'branch_id', 'chapter_id', 'rev', 'kind', 'severity', 'locator',
      'description', 'evidence', 'status', 'round', 'created_at',
    ],
    refs: { chapter_id: 'chapter' },
    json: ['evidence'],
    scope: 'SELECT * FROM issue WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'event_card',
    idPrefix: 'ec',
    columns: [
      'id', 'branch_id', 'title', 'trigger_json', 'min_level', 'weight',
      'one_shot', 'consumed_seq',
    ],
    json: ['trigger_json'],
    scope: 'SELECT * FROM event_card WHERE branch_id = ?',
    orderBy: 'id',
  },
  {
    table: 'lock',
    columns: ['branch_id', 'scope', 'slot_key', 'reason', 'locked_by', 'created_at'],
    pipeRefs: ['slot_key'],
    scope: 'SELECT * FROM lock WHERE branch_id = ?',
    orderBy: 'scope, slot_key',
  },
  {
    table: 'outbox',
    idPrefix: 'ob',
    columns: [
      'id', 'branch_id', 'chapter_id', 'rev', 'target_path', 'expected_hash',
      'applied_rev', 'status', 'attempts', 'last_error',
    ],
    refs: { chapter_id: 'chapter' },
    scope: 'SELECT * FROM outbox WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'job',
    idPrefix: 'j',
    columns: [
      'id', 'branch_id', 'kind', 'target_id', 'expected_seq', 'generation',
      'status', 'payload', 'created_at',
    ],
    json: ['payload'],
    scope: 'SELECT * FROM job WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'memory_node',
    idPrefix: 'mn',
    columns: [
      'id', 'branch_id', 'kind', 'text', 'importance', 'stability', 'conf',
      'valid_from', 'last_access', 'access_count', 'pinned', 'hard', 'sensitivity',
      'owner_id', 'slot_key', 'source_seq', 'resolved_seq', 'embedding',
      'embedding_model', 'embedding_dim',
    ],
    refs: { owner_id: 'entity' },
    pipeRefs: ['slot_key'],
    scope: 'SELECT * FROM memory_node WHERE branch_id = ?',
    orderBy: 'rowid',
  },
  {
    table: 'memory_edge',
    columns: ['src', 'dst', 'kind', 'weight'],
    refs: { src: 'memory_node', dst: 'memory_node' },
    scope: 'SELECT * FROM memory_edge WHERE src IN (SELECT id FROM memory_node WHERE branch_id = ?)',
    orderBy: 'src, dst, kind',
  },
];

export interface SnapshotPayload {
  version: number;
  branchId: string;
  seq: number;
  tables: Record<string, Record<string, unknown>[]>;
}

function serializeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __blob: value.toString('base64') };
  return value;
}

function deserializeValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { __blob?: unknown }).__blob === 'string'
  ) {
    return Buffer.from((value as { __blob: string }).__blob, 'base64');
  }
  return value;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 把 8 个域 + 运行必需表读成一份快照（同事务内调用，保证一致）。 */
export function captureTables(
  db: Db,
  branchId: string,
): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const spec of TABLES) {
    const rows = db
      .prepare(`${spec.scope} ORDER BY ${spec.orderBy}`)
      .all(...(spec.global ? [] : [branchId])) as Record<string, unknown>[];
    tables[spec.table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of spec.columns) out[column] = serializeValue(row[column]);
      return out;
    });
  }
  return tables;
}

export function captureSnapshot(
  db: Db,
  branchId: string,
  seq: number,
  now = new Date().toISOString(),
): { id: string; seq: number; bytes: number } {
  const tables = captureTables(db, branchId);
  const payload: SnapshotPayload = { version: SNAPSHOT_VERSION, branchId, seq, tables };
  const json = JSON.stringify(payload);
  const id = newId('snap');
  db.prepare(
    `INSERT INTO snapshot(id, branch_id, seq, blob, codec, bytes, created_at)
     VALUES (?, ?, ?, ?, 'json', ?, ?)`,
  ).run(id, branchId, seq, Buffer.from(json, 'utf8'), Buffer.byteLength(json, 'utf8'), now);
  return { id, seq, bytes: Buffer.byteLength(json, 'utf8') };
}

/** 检查点 + 快照必须成对出现：只有检查点没有快照，回退就得从头重放。 */
export function createCheckpointWithSnapshot(
  db: Db,
  input: {
    branchId: string;
    seq: number;
    label: string;
    trigger: 'auto' | 'manual' | 'scene_close' | 'git_commit' | 'restore';
    now?: string;
  },
): { checkpointId: string; snapshotId: string | null } {
  const now = input.now ?? new Date().toISOString();
  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM checkpoint WHERE branch_id = ? AND seq = ?')
      .get(input.branchId, input.seq);
    if (existing) return { checkpointId: (existing as { id: string }).id, snapshotId: null };
    const checkpointId = newId('ck');
    db.prepare(
      `INSERT INTO checkpoint(id, branch_id, seq, label, trigger, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(checkpointId, input.branchId, input.seq, input.label, input.trigger, now);
    const snapshot = captureSnapshot(db, input.branchId, input.seq, now);
    return { checkpointId, snapshotId: snapshot.id };
  });
  return tx.immediate();
}

export function lastSnapshotSeq(db: Db, branchId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM snapshot WHERE branch_id = ?')
    .get(branchId) as { seq: number };
  return row.seq;
}

class Remap {
  private readonly maps = new Map<string, Map<string, string>>();
  private readonly prefixes = new Map<string, string>();

  constructor(specs: readonly TableSpec[]) {
    for (const spec of specs) {
      if (spec.idPrefix) this.prefixes.set(spec.table, spec.idPrefix);
    }
  }

  get(table: string, oldId: unknown): string {
    if (typeof oldId !== 'string' || oldId.length === 0) return String(oldId);
    const map = this.maps.get(table);
    const mapped = map?.get(oldId);
    if (mapped) return mapped;
    // 未映射的引用（'narrator'、作者 id 等）原样保留。
    return oldId;
  }

  ensure(table: string, oldId: string): string {
    const existing = this.maps.get(table)?.get(oldId);
    if (existing) return existing;
    const prefix = this.prefixes.get(table);
    if (!prefix) throw new Error(`表 ${table} 没有主键前缀，不能生成新 id`);
    const fresh = newId(prefix);
    this.set(table, oldId, fresh);
    return fresh;
  }

  set(table: string, oldId: string, fresh: string): void {
    let map = this.maps.get(table);
    if (!map) {
      map = new Map();
      this.maps.set(table, map);
    }
    map.set(oldId, fresh);
  }

  /** 任意 JSON 字符串里出现过的已知 id 都替换。 */
  any(value: string): string {
    for (const map of this.maps.values()) {
      const hit = map.get(value);
      if (hit) return hit;
    }
    return value;
  }
}

function remapJson(value: unknown, remap: Remap): unknown {
  if (typeof value === 'string') return remap.any(value);
  if (Array.isArray(value)) return value.map((item) => remapJson(item, remap));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 键也要改写：scene.goal.cast 是 { entityId: weights } 的映射。
      out[remap.any(key)] = remapJson(item, remap);
    }
    return out;
  }
  return value;
}

function columnValue(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  // 事件 payload 用 camelCase 行对象，快照用 DB 的 snake_case 列名。
  const camel = column.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return camel in row ? row[camel] : undefined;
}

function refreshedRow(
  spec: TableSpec,
  row: Record<string, unknown>,
  branchId: string,
  remap: Remap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of spec.columns) {
    if (column === 'branch_id') {
      out[column] = branchId;
      continue;
    }
    if (column === 'id' && spec.idPrefix) {
      out[column] = remap.ensure(spec.table, String(columnValue(row, column)));
      continue;
    }
    const ref = spec.refs?.[column];
    if (ref) {
      const value = columnValue(row, column);
      out[column] = value === null || value === undefined ? value : remap.get(ref, value);
      continue;
    }
    const value = deserializeValue(columnValue(row, column));
    if (spec.pipeRefs?.includes(column) && typeof value === 'string') {
      out[column] = value
        .split('|')
        .map((part) => remap.any(part))
        .join('|');
      continue;
    }
    if (spec.jsonEntityArrays?.includes(column) && typeof value === 'string') {
      const parsed = parseJson<unknown[]>(value, []);
      out[column] = canonicalJson(parsed.map((id) => remap.any(String(id))));
      continue;
    }
    if (spec.json?.includes(column) && typeof value === 'string') {
      const parsed = parseJson<unknown>(value, null);
      out[column] = parsed === null ? value : canonicalJson(remapJson(parsed, remap));
      continue;
    }
    out[column] = value;
  }
  return out;
}

function insertRow(db: Db, spec: TableSpec, row: Record<string, unknown>): void {
  // 事件 payload 可能省略有默认值的列（例如 beat.stale）；省略而不是写 NULL，
  // 否则 NOT NULL DEFAULT 0 的列会被 NULL 顶掉。
  const columns = spec.columns.filter((column) => row[column] !== undefined);
  const placeholders = columns.map(() => '?').join(', ');
  const verb = spec.idPrefix
    ? 'INSERT'
    : spec.ignoreExisting
      ? 'INSERT OR IGNORE'
      : 'INSERT OR REPLACE';
  db.prepare(`${verb} INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...columns.map((column) => row[column] ?? null),
  );
}

function specOf(table: string): TableSpec {
  const spec = TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`快照缺少表 ${table}`);
  return spec;
}

/** 把快照内容写入新分支。返回 scene 的旧→新映射，供活动指针使用。 */
function copySnapshot(
  db: Db,
  payload: SnapshotPayload | null,
  branchId: string,
  remap: Remap,
): Map<string, string> {
  const sceneMap = new Map<string, string>();
  if (!payload) return sceneMap;
  for (const spec of TABLES) {
    const rows = payload.tables[spec.table] ?? [];
    for (const row of rows) {
      const refreshed = refreshedRow(spec, row, branchId, remap);
      insertRow(db, spec, refreshed);
      if (spec.table === 'scene') {
        sceneMap.set(String(row.id), String(refreshed.id));
      }
    }
  }
  return sceneMap;
}

interface EventRow {
  seq: number;
  kind: string;
  payload: string;
}

function replayEvent(
  db: Db,
  event: EventRow,
  branchId: string,
  remap: Remap,
  sceneMap: Map<string, string>,
): void {
  const payload = parseJson<Record<string, unknown>>(event.payload, {});
  switch (event.kind) {
    case 'project.created':
      return;
    case 'system.warned':
      return;
    case 'scene.created': {
      const tables = ['entity', 'agent_config', 'scene', 'event_card'] as const;
      const keys = ['entities', 'agents', 'scene', 'cards'] as const;
      for (let i = 0; i < tables.length; i += 1) {
        const spec = specOf(tables[i]!);
        const value = payload[keys[i]!];
        const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : value ? [value as Record<string, unknown>] : [];
        for (const row of rows) {
          const refreshed = refreshedRow(spec, row, branchId, remap);
          insertRow(db, spec, refreshed);
          if (spec.table === 'scene') sceneMap.set(String(row.id), String(refreshed.id));
        }
      }
      return;
    }
    case 'scene.state.changed': {
      const sceneId = remap.get('scene', payload.sceneId);
      db.prepare('UPDATE scene SET state = ?, opened_seq = ?, closed_seq = ? WHERE id = ?').run(
        payload.to as string,
        (payload.openedSeq as number | null) ?? null,
        (payload.closedSeq as number | null) ?? null,
        sceneId,
      );
      const memory = payload.memory as
        | {
            children?: Record<string, unknown>[];
            summary?: Record<string, unknown>;
            edges?: { src: string; dst: string; kind: string; weight: number }[];
            downweight?: { id: string; importance: number }[];
          }
        | null
        | undefined;
      if (memory?.summary) {
        const nodeSpec = specOf('memory_node');
        const insert = (row: Record<string, unknown>): void => {
          insertRow(db, nodeSpec, refreshedRow(nodeSpec, row, branchId, remap));
        };
        for (const child of memory.children ?? []) insert(child);
        insert(memory.summary);
        const edgeSpec = specOf('memory_edge');
        for (const edge of memory.edges ?? []) {
          insertRow(
            db,
            edgeSpec,
            refreshedRow(edgeSpec, edge as unknown as Record<string, unknown>, branchId, remap),
          );
        }
        const weight = db.prepare('UPDATE memory_node SET importance = ? WHERE id = ?');
        for (const row of memory.downweight ?? []) {
          weight.run(row.importance, remap.get('memory_node', row.id));
        }
        db.prepare('UPDATE scene SET summary = ? WHERE id = ?').run(
          String(memory.summary.text),
          sceneId,
        );
      }
      return;
    }
    case 'beat.committed': {
      const beatSpec = specOf('beat');
      const messageSpec = specOf('message');
      const beat = refreshedRow(beatSpec, payload.beat as Record<string, unknown>, branchId, remap);
      insertRow(db, beatSpec, beat);
      const message = refreshedRow(
        messageSpec,
        payload.message as Record<string, unknown>,
        branchId,
        remap,
      );
      insertRow(db, messageSpec, message);
      const cognitionSpec = specOf('cognition');
      for (const row of (payload.cognition as Record<string, unknown>[] | undefined) ?? []) {
        const refreshed = refreshedRow(cognitionSpec, row, branchId, remap);
        refreshed.source_message_id = message.id;
        insertRow(db, cognitionSpec, refreshed);
      }
      const relationSpec = specOf('relation');
      for (const row of (payload.relations as Record<string, unknown>[] | undefined) ?? []) {
        insertRow(db, relationSpec, refreshedRow(relationSpec, row, branchId, remap));
      }
      const update = payload.sceneUpdate as { beats?: number; conflictLevel?: number } | undefined;
      if (update) {
        db.prepare('UPDATE scene SET beats = ?, conflict_level = ? WHERE id = ?').run(
          update.beats ?? 0,
          update.conflictLevel ?? 0,
          remap.get('scene', (payload.beat as Record<string, unknown>).sceneId),
        );
      }
      const card = payload.card as { id?: string } | null;
      if (card?.id) {
        db.prepare('UPDATE event_card SET consumed_seq = ? WHERE id = ? AND one_shot = 1').run(
          event.seq,
          remap.get('event_card', card.id),
        );
      }
      return;
    }
    case 'message.appended': {
      const messagePayload = payload.message as Record<string, unknown> | undefined;
      if (!messagePayload) {
        throw new Error(`事件 ${event.seq}（message.appended）缺少完整 message payload，无法重放`);
      }
      const spec = specOf('message');
      insertRow(db, spec, refreshedRow(spec, messagePayload, branchId, remap));
      return;
    }
    case 'relation.set': {
      const spec = specOf('relation');
      insertRow(db, spec, refreshedRow(spec, payload.relation as Record<string, unknown>, branchId, remap));
      return;
    }
    case 'fact.asserted': {
      const fact = payload.fact as Record<string, unknown> | undefined;
      if (fact) {
        const spec = specOf('fact');
        insertRow(db, spec, refreshedRow(spec, fact, branchId, remap));
      }
      const supersededId = payload.supersededId as string | null | undefined;
      if (supersededId) {
        db.prepare('UPDATE fact SET valid_to = ? WHERE id = ? AND branch_id = ?').run(
          payload.supersededValidTo as string,
          remap.get('fact', supersededId),
          branchId,
        );
      }
      return;
    }
    case 'fact.closed': {
      for (const row of (payload.rows as { id: string; validTo: string }[] | undefined) ?? []) {
        db.prepare('UPDATE fact SET valid_to = ? WHERE id = ? AND branch_id = ?').run(
          row.validTo,
          remap.get('fact', row.id),
          branchId,
        );
      }
      return;
    }
    case 'cognition.granted': {
      const spec = specOf('cognition');
      insertRow(
        db,
        spec,
        refreshedRow(
          spec,
          {
            branchId,
            characterId: payload.characterId,
            factId: payload.factId,
            attitude: payload.attitude,
            certainty: payload.certainty,
            learnedSeq: payload.learnedSeq,
            sourceMessageId: null,
            percept: payload.percept,
          },
          branchId,
          remap,
        ),
      );
      return;
    }
    case 'lock.set': {
      const spec = specOf('lock');
      insertRow(
        db,
        spec,
        refreshedRow(spec, payload.lock as Record<string, unknown>, branchId, remap),
      );
      return;
    }
    case 'lock.released': {
      const lock = payload.lock as { scope: string; slotKey: string };
      const slotKey = lock.slotKey
        .split('|')
        .map((part) => remap.any(part))
        .join('|');
      db.prepare('DELETE FROM lock WHERE branch_id = ? AND scope = ? AND slot_key = ?').run(
        branchId,
        lock.scope,
        slotKey,
      );
      return;
    }
    case 'entity.added': {
      const spec = specOf('entity');
      insertRow(
        db,
        spec,
        refreshedRow(spec, payload.entity as Record<string, unknown>, branchId, remap),
      );
      return;
    }
    case 'predicate.defined': {
      const spec = specOf('predicate_spec');
      insertRow(
        db,
        spec,
        refreshedRow(spec, payload.spec as Record<string, unknown>, branchId, remap),
      );
      return;
    }
    case 'memory.added': {
      const node = payload.node as Record<string, unknown>;
      const spec = specOf('memory_node');
      const row = {
        ...node,
        embedding:
          typeof node.embeddingB64 === 'string'
            ? Buffer.from(node.embeddingB64, 'base64')
            : null,
      };
      insertRow(db, spec, refreshedRow(spec, row, branchId, remap));
      return;
    }
    case 'memory.linked': {
      const spec = specOf('memory_edge');
      insertRow(
        db,
        spec,
        refreshedRow(spec, payload.edge as Record<string, unknown>, branchId, remap),
      );
      return;
    }
    case 'memory.deleted': {
      db.prepare('DELETE FROM memory_node WHERE id = ? AND branch_id = ?').run(
        remap.get('memory_node', payload.id),
        branchId,
      );
      return;
    }
    case 'memory.embedded': {
      const stmt = db.prepare(
        'UPDATE memory_node SET embedding = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?',
      );
      for (const update of (payload.updates as
        | { id: string; vectorB64: string; model: string }[]
        | undefined) ?? []) {
        const vector = Buffer.from(update.vectorB64, 'base64');
        stmt.run(vector, update.model, vector.length / 4, remap.get('memory_node', update.id));
      }
      return;
    }
    case 'job.enqueued': {
      const spec = specOf('job');
      insertRow(
        db,
        spec,
        refreshedRow(spec, payload.job as Record<string, unknown>, branchId, remap),
      );
      return;
    }
    case 'job.claimed': {
      db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(
        remap.get('job', payload.jobId),
      );
      for (const id of (payload.discarded as string[] | undefined) ?? []) {
        db.prepare("UPDATE job SET status = 'discarded' WHERE id = ?").run(remap.get('job', id));
      }
      return;
    }
    case 'job.finished': {
      db.prepare('UPDATE job SET status = ?, payload = ? WHERE id = ?').run(
        payload.status as string,
        payload.payload as string,
        remap.get('job', payload.jobId),
      );
      return;
    }
    default:
      throw new Error(`回退重放不支持事件类型：${event.kind}（seq ${event.seq}）`);
  }
}

export interface RestoreInput {
  targetSeq: number;
  idempotencyKey: string;
  actorId?: string | null;
  label?: string;
}

export interface RestoreResult {
  fromBranchId: string;
  fromSeq: number;
  branchId: string;
  branchName: string;
  targetSeq: number;
  headSeq: number;
  snapshotSeq: number;
  replayedEvents: number;
  activeSceneId: string | null;
  counts: DomainCounts;
  impact: DomainImpact[];
  replay: boolean;
  /** 从 Git 提交恢复时填写（commit sha）。 */
  fromCommit?: string;
  /** 状态包内的源 seq；新分支的坐标从 headSeq 重新开始。 */
  packageSeq?: number;
}

interface RestoreReceiptRow {
  request_hash: string;
  result_json: string;
}

/** 把活动指针切回某条分支：head 取分支当前值，场景取该分支当前的 open 场景。 */
function reactivateBranch(
  db: Db,
  projectId: string,
  branchId: string,
): { headSeq: number; activeSceneId: string | null } | null {
  const branch = db
    .prepare('SELECT head_seq FROM branch WHERE id = ?')
    .get(branchId) as { head_seq: number } | undefined;
  if (!branch) return null;
  const scene = db
    .prepare("SELECT id FROM scene WHERE branch_id = ? AND state = 'open' ORDER BY idx DESC LIMIT 1")
    .get(branchId) as { id: string } | undefined;
  const activeSceneId = scene?.id ?? null;
  db.prepare(
    `UPDATE project_state SET active_branch_id = ?, active_scene_id = ?, head_seq = ?
     WHERE project_id = ?`,
  ).run(branchId, activeSceneId, branch.head_seq, projectId);
  return { headSeq: branch.head_seq, activeSceneId };
}

/**
 * 回退命令。它不经过 CommandBus，因为 bus 的语义是"往当前分支追加"，
 * 而回退要切换分支；但它仍然走幂等收据 + 单事务，并写 restore 事件。
 */
export function restoreBranch(db: Db, input: RestoreInput): RestoreResult {
  const project = getProject(db);
  const active = getActiveBranch(db);
  if (!project || !active) throw new UsageError('项目未初始化：project / branch 缺失');
  const key = input.idempotencyKey.trim();
  if (!key) throw new UsageError('restore 的 idempotencyKey 不能为空');
  const requestHash = sha256Hex(canonicalJson({ kind: 'restore', targetSeq: input.targetSeq }));

  const replay = (row: RestoreReceiptRow): RestoreResult => {
    if (row.request_hash !== requestHash) {
      throw new ConstraintError('同一幂等键被用于不同回退请求', 'ck_idempotency_conflict');
    }
    const result = { ...(JSON.parse(row.result_json) as RestoreResult), replay: true };
    // 幂等重放不新建分支，但命令的意图是"回到这条分支"：指针要跟回来，
    // 否则 manifest 与 project_state.active_branch_id 会指向两条不同的分支。
    const active = reactivateBranch(db, project.id, result.branchId);
    return active ? { ...result, ...active } : result;
  };
  const existing = db
    .prepare('SELECT request_hash, result_json FROM receipt WHERE project_id = ? AND idempotency_key = ?')
    .get(project.id, key) as RestoreReceiptRow | undefined;
  if (existing) return replay(existing);

  validateRestoreTarget(input.targetSeq, active.headSeq);
  // 回退/状态包建立的分支只有一条 restore.created 起点事件：早于它最早的
  // 快照，重放只会得到空分支。正常分支的 project.created 在 seq 1，仍允许
  // 从 0 重放（历史行为不变）。
  const firstEvent = db
    .prepare('SELECT kind, seq FROM event WHERE branch_id = ? ORDER BY seq LIMIT 1')
    .get(active.id) as { kind: string; seq: number } | undefined;
  if (firstEvent?.kind === 'restore.created') {
    const floorRow = db
      .prepare('SELECT MIN(seq) AS seq FROM snapshot WHERE branch_id = ?')
      .get(active.id) as { seq: number | null } | undefined;
    const floor = Number(floorRow?.seq ?? firstEvent.seq);
    if (input.targetSeq < floor) {
      throw new UsageError(
        `该分支由回退/状态包建立，最早只能回到 seq ${floor}`,
      );
    }
  }
  const impact = restoreImpact(db, active.id, input.targetSeq);

  const tx = db.transaction((): RestoreResult => {
    const again = db
      .prepare('SELECT request_hash, result_json FROM receipt WHERE project_id = ? AND idempotency_key = ?')
      .get(project.id, key) as RestoreReceiptRow | undefined;
    if (again) return replay(again);

    const snapshot = db
      .prepare(
        `SELECT seq, blob FROM snapshot WHERE branch_id = ? AND seq <= ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(active.id, input.targetSeq) as { seq: number; blob: Buffer } | undefined;
    const snapshotSeq = snapshot?.seq ?? 0;
    const payload = snapshot
      ? (JSON.parse(snapshot.blob.toString('utf8')) as SnapshotPayload)
      : null;

    const names = (db.prepare('SELECT name FROM branch WHERE project_id = ?').all(project.id) as {
      name: string;
    }[]).map((r) => r.name);
    const branchId = newId('b');
    const branchName = uniqueBranchName(names, active.name);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO branch(id, project_id, parent_id, fork_seq, head_seq, name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      branchId,
      project.id,
      active.id,
      input.targetSeq,
      input.targetSeq,
      branchName,
      input.label ?? `回退到 seq ${input.targetSeq}`,
      now,
    );

    const remap = new Remap(TABLES);
    const sceneMap = copySnapshot(db, payload, branchId, remap);

    const events = db
      .prepare(
        `SELECT seq, kind, payload FROM event
         WHERE branch_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
      )
      .all(active.id, snapshotSeq, input.targetSeq) as EventRow[];
    for (const event of events) {
      replayEvent(db, event, branchId, remap, sceneMap);
    }

    // 新分支在回退点也要有一份自己的快照：否则下一次回退到这条分支的
    // restore 检查点时会找不到快照，而它的事件日志从 E 开始（> target），
    // 重放为空 → 得到一个空分支。这是 A6 里最隐蔽的一类"少退一个域"。
    captureSnapshot(db, branchId, input.targetSeq, now);

    // 新分支的第一个事件：restore.created。head 从这里重新开始计。
    const eventInfo = db
      .prepare(
        `INSERT INTO event(project_id, branch_id, kind, actor_type, actor_id, payload,
           idempotency_key, created_at)
         VALUES (?, ?, 'restore.created', 'user', ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        branchId,
        input.actorId ?? 'author',
        canonicalJson({
          fromBranch: active.id,
          fromSeq: active.headSeq,
          targetSeq: input.targetSeq,
          snapshotSeq,
        }),
        key,
        now,
      );
    const headSeq = Number(eventInfo.lastInsertRowid);
    db.prepare('UPDATE branch SET head_seq = ? WHERE id = ?').run(headSeq, branchId);
    db.prepare(
      `INSERT INTO checkpoint(id, branch_id, seq, label, trigger, created_at)
       VALUES (?, ?, ?, ?, 'restore', ?)`,
    ).run(newId('ck'), branchId, input.targetSeq, input.label ?? `回退点 seq ${input.targetSeq}`, now);

    const pointer = db
      .prepare('SELECT active_scene_id FROM project_state WHERE project_id = ?')
      .get(project.id) as { active_scene_id: string | null } | undefined;
    const oldActiveScene = pointer?.active_scene_id ?? null;
    const candidate = oldActiveScene === null ? null : sceneMap.get(oldActiveScene) ?? null;
    const newActiveScene =
      candidate !== null &&
      db.prepare('SELECT 1 FROM scene WHERE id = ? AND branch_id = ?').get(candidate, branchId)
        ? candidate
        : null;
    db.prepare(
      `UPDATE project_state SET active_branch_id = ?, active_scene_id = ?, head_seq = ?
       WHERE project_id = ?`,
    ).run(branchId, newActiveScene, headSeq, project.id);

    const counts = domainCounts(db, branchId);
    const result: RestoreResult = {
      fromBranchId: active.id,
      fromSeq: active.headSeq,
      branchId,
      branchName,
      targetSeq: input.targetSeq,
      headSeq,
      snapshotSeq,
      replayedEvents: events.length,
      activeSceneId: newActiveScene,
      counts,
      impact,
      replay: false,
    };
    db.prepare(
      `INSERT INTO receipt(project_id, idempotency_key, command, request_hash, result_json,
         result_seq, created_at)
       VALUES (?, ?, 'restore', ?, ?, ?, ?)`,
    ).run(project.id, key, requestHash, canonicalJson(result), headSeq, now);
    return result;
  });

  return tx.immediate();
}

// ══════════════════════════════════════════════════════════════════════════
// Git 状态包：场景关闭时导出，restore --from-commit 读取
// ══════════════════════════════════════════════════════════════════════════

export interface StatePackageBranch {
  id: string;
  name: string;
  parentId: string | null;
  forkSeq: number;
  headSeq: number;
  reason: string;
  createdAt: string;
}

export interface StatePackage {
  format: string;
  version: number;
  /** 数据库 schema 版本；与当前程序不一致时拒绝导入。 */
  schemaVersion: number;
  codec: 'zstd+json' | 'json';
  projectId: string;
  projectName: string;
  projectCreatedAt: string;
  createdAt: string;
  seq: number;
  activeSceneId: string | null;
  branch: StatePackageBranch;
  tables: Record<string, Record<string, unknown>[]>;
}

interface BranchMetaRow {
  id: string;
  name: string;
  parent_id: string | null;
  fork_seq: number;
  head_seq: number;
  reason: string;
  created_at: string;
}

/**
 * 导出完整领域状态（8 域 + 运行必需表），zstd 压缩。
 * 文件写在 .noryth/state.json.zst，随场景关闭的 Git 提交进版本库；
 * 数据库本身被 .gitignore 排除，所以这是丢库/换机器后的唯一恢复源。
 */
export function exportStatePackage(
  db: Db,
  branchId: string,
  seq: number,
  now = new Date().toISOString(),
): Buffer {
  const project = getProject(db);
  if (!project) throw new IoError('项目未初始化：project 缺失，无法导出状态包');
  const branch = db
    .prepare(
      `SELECT id, name, parent_id, fork_seq, head_seq, reason, created_at
       FROM branch WHERE id = ?`,
    )
    .get(branchId) as BranchMetaRow | undefined;
  if (!branch) throw new UsageError(`分支不存在：${branchId}`);
  const pointer = db
    .prepare('SELECT active_scene_id FROM project_state WHERE project_id = ?')
    .get(project.id) as { active_scene_id: string | null } | undefined;
  const pkg: StatePackage = {
    format: STATE_PACKAGE_FORMAT,
    version: STATE_PACKAGE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    codec: 'zstd+json',
    projectId: project.id,
    projectName: project.name,
    projectCreatedAt: project.createdAt,
    createdAt: now,
    seq,
    activeSceneId: pointer?.active_scene_id ?? null,
    branch: {
      id: branch.id,
      name: branch.name,
      parentId: branch.parent_id,
      forkSeq: branch.fork_seq,
      headSeq: branch.head_seq,
      reason: branch.reason,
      createdAt: branch.created_at,
    },
    tables: captureTables(db, branchId),
  };
  if (typeof zstdCompressSync !== 'function') {
    throw new IoError('当前 Node 不支持 zstd（需要 Node >=22.15）');
  }
  return zstdCompressSync(Buffer.from(JSON.stringify(pkg), 'utf8'));
}

export function writeStatePackage(
  root: string,
  buffer: Buffer,
): { path: string; bytes: number } {
  const file = path.join(root, STATE_PACKAGE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buffer);
  return { path: file, bytes: buffer.byteLength };
}

/** 解压 + 校验。zstd 帧以 28 B5 2F FD 开头；也接受未压缩 JSON。 */
export function decodeStatePackage(buffer: Buffer): StatePackage {
  if (buffer.length === 0) throw new IoError('状态包为空');
  let json = buffer;
  const isZstd =
    buffer.length >= 4 &&
    buffer[0] === 0x28 &&
    buffer[1] === 0xb5 &&
    buffer[2] === 0x2f &&
    buffer[3] === 0xfd;
  if (isZstd) {
    try {
      json = zstdDecompressSync(buffer);
    } catch (error) {
      throw new IoError(
        `状态包 zstd 解压失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch (error) {
    throw new IoError(
      `状态包不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pkg = parsed as Partial<StatePackage>;
  if (pkg.format !== STATE_PACKAGE_FORMAT) {
    throw new IoError(`不是 Noryth 状态包（format=${String(pkg.format)}）`);
  }
  if (pkg.version !== STATE_PACKAGE_VERSION) {
    throw new IoError(`状态包版本 ${String(pkg.version)} 不支持（本程序支持 ${STATE_PACKAGE_VERSION}）`);
  }
  if (pkg.schemaVersion !== SCHEMA_VERSION) {
    throw new IoError(
      `状态包 schema 版本 ${String(pkg.schemaVersion)} 与本程序（${SCHEMA_VERSION}）不一致`,
    );
  }
  if (typeof pkg.projectId !== 'string' || pkg.projectId.length === 0) {
    throw new IoError('状态包缺少 projectId');
  }
  if (typeof pkg.seq !== 'number' || !Number.isInteger(pkg.seq) || pkg.seq < 0) {
    throw new IoError(`状态包 seq 不合法：${String(pkg.seq)}`);
  }
  if (
    !pkg.branch ||
    typeof pkg.branch.id !== 'string' ||
    pkg.branch.id.length === 0 ||
    typeof pkg.branch.name !== 'string' ||
    pkg.branch.name.length === 0
  ) {
    throw new IoError('状态包缺少 branch 元数据');
  }
  if (!pkg.tables || typeof pkg.tables !== 'object' || Array.isArray(pkg.tables)) {
    throw new IoError('状态包缺少 tables');
  }
  return pkg as StatePackage;
}

export interface PackageRestoreInput {
  /** 当前项目根；空库恢复时写进 project.root_path。 */
  rootPath: string;
  fromCommit: string;
  idempotencyKey: string;
  actorId?: string | null;
}

/**
 * 从状态包恢复：新分支 + 新坐标。
 *
 * 包内 seq 是源库的事件坐标；新分支的 head 必须重新起算：
 *   restoreSeq = max(新库当前 max(event.seq)+1, 包 seq+1, 包内最大 message.seq+1)
 * 这样复制来的 message.seq（按事件序号排序）一定小于之后新拍的 seq，
 * 叙事顺序不会被打乱；同时 restoreSeq 也一定大于 fork_seq。
 */
export function restoreFromPackage(
  db: Db,
  pkg: StatePackage,
  input: PackageRestoreInput,
): RestoreResult {
  const key = input.idempotencyKey.trim();
  if (!key) throw new UsageError('restore --from-commit 的 idempotencyKey 不能为空');
  const requestHash = sha256Hex(
    canonicalJson({
      kind: 'restore.from_commit',
      commit: input.fromCommit,
      packageSeq: pkg.seq,
    }),
  );
  const readReceipt = (): RestoreReceiptRow | undefined =>
    db
      .prepare(
        'SELECT request_hash, result_json FROM receipt WHERE project_id = ? AND idempotency_key = ?',
      )
      .get(pkg.projectId, key) as RestoreReceiptRow | undefined;
  const replay = (row: RestoreReceiptRow): RestoreResult => {
    if (row.request_hash !== requestHash) {
      throw new ConstraintError('同一幂等键被用于不同提交的状态包', 'ck_idempotency_conflict');
    }
    const result = { ...(JSON.parse(row.result_json) as RestoreResult), replay: true };
    // 同 restoreBranch：重放也要把活动指针切回这条分支，保持 manifest 与库一致。
    const active = reactivateBranch(db, pkg.projectId, result.branchId);
    return active ? { ...result, ...active } : result;
  };
  const existing = readReceipt();
  if (existing) return replay(existing);

  const current = getProject(db);
  if (current && current.id !== pkg.projectId) {
    throw new IoError(
      `状态包属于项目 ${pkg.projectId}，当前项目是 ${current.id}；拒绝把两个项目混在一起`,
    );
  }

  const tx = db.transaction((): RestoreResult => {
    const again = readReceipt();
    if (again) return replay(again);
    const now = new Date().toISOString();

    if (!getProject(db)) {
      db.prepare(
        `INSERT INTO project(id, name, root_path, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        pkg.projectId,
        pkg.projectName || '恢复的项目',
        input.rootPath,
        SCHEMA_VERSION,
        pkg.projectCreatedAt || now,
        now,
      );
    }

    const parent = db
      .prepare('SELECT id FROM branch WHERE id = ? AND project_id = ?')
      .get(pkg.branch.id, pkg.projectId) as { id: string } | undefined;
    const names = (
      db.prepare('SELECT name FROM branch WHERE project_id = ?').all(pkg.projectId) as {
        name: string;
      }[]
    ).map((row) => row.name);
    const branchId = newId('b');
    const branchName = uniqueBranchName(names, pkg.branch.name);
    const forkSeq = parent ? pkg.seq : 0;
    db.prepare(
      `INSERT INTO branch(id, project_id, parent_id, fork_seq, head_seq, name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      branchId,
      pkg.projectId,
      parent?.id ?? null,
      forkSeq,
      pkg.seq,
      branchName,
      `从提交 ${input.fromCommit.slice(0, 7)} 恢复`,
      now,
    );

    const remap = new Remap(TABLES);
    const sceneMap = copySnapshot(
      db,
      {
        version: pkg.version,
        branchId: pkg.branch.id,
        seq: pkg.seq,
        tables: pkg.tables,
      },
      branchId,
      remap,
    );

    // 复制来的 beat 没有本分支的事件，eventSeq 归零；否则 beat rewind 会指向
    // 一个不存在的坐标。复制来的拍只能通过 restore --checkpoint 整体回退。
    db.prepare(
      "UPDATE beat SET breakdown = json_set(breakdown, '$.eventSeq', 0) WHERE branch_id = ?",
    ).run(branchId);

    const maxEvent = Number(
      (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as { n: number }).n,
    );
    let maxMessageSeq = 0;
    for (const row of pkg.tables.message ?? []) {
      const seq = Number(row.seq);
      if (Number.isFinite(seq) && seq > maxMessageSeq) maxMessageSeq = seq;
    }
    const restoreSeq = Math.max(maxEvent + 1, pkg.seq + 1, maxMessageSeq + 1);

    db.prepare(
      `INSERT INTO event(seq, project_id, branch_id, kind, actor_type, actor_id, payload,
         idempotency_key, created_at)
       VALUES (?, ?, ?, 'restore.created', 'user', ?, ?, ?, ?)`,
    ).run(
      restoreSeq,
      pkg.projectId,
      branchId,
      input.actorId ?? 'author',
      canonicalJson({
        fromCommit: input.fromCommit,
        fromSeq: pkg.seq,
        targetSeq: pkg.seq,
        packageSeq: pkg.seq,
      }),
      key,
      now,
    );
    db.prepare('UPDATE branch SET head_seq = ? WHERE id = ?').run(restoreSeq, branchId);
    captureSnapshot(db, branchId, restoreSeq, now);
    db.prepare(
      `INSERT INTO checkpoint(id, branch_id, seq, label, trigger, created_at)
       VALUES (?, ?, ?, ?, 'restore', ?)`,
    ).run(
      newId('ck'),
      branchId,
      restoreSeq,
      `从提交 ${input.fromCommit.slice(0, 7)} 恢复`,
      now,
    );

    const candidate = pkg.activeSceneId ? sceneMap.get(pkg.activeSceneId) ?? null : null;
    const activeSceneId =
      candidate !== null &&
      db
        .prepare("SELECT 1 FROM scene WHERE id = ? AND branch_id = ? AND state = 'open'")
        .get(candidate, branchId)
        ? candidate
        : null;
    db.prepare(
      `INSERT INTO project_state(project_id, active_branch_id, active_scene_id, head_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         active_branch_id = excluded.active_branch_id,
         active_scene_id = excluded.active_scene_id,
         head_seq = excluded.head_seq`,
    ).run(pkg.projectId, branchId, activeSceneId, restoreSeq);

    const counts = domainCounts(db, branchId);
    const result: RestoreResult = {
      fromBranchId: parent?.id ?? pkg.branch.id,
      fromSeq: pkg.seq,
      branchId,
      branchName,
      targetSeq: pkg.seq,
      headSeq: restoreSeq,
      snapshotSeq: restoreSeq,
      replayedEvents: 0,
      activeSceneId,
      counts,
      impact: [],
      replay: false,
      fromCommit: input.fromCommit,
      packageSeq: pkg.seq,
    };
    db.prepare(
      `INSERT INTO receipt(project_id, idempotency_key, command, request_hash, result_json,
         result_seq, created_at)
       VALUES (?, ?, 'restore.from_commit', ?, ?, ?, ?)`,
    ).run(pkg.projectId, key, requestHash, canonicalJson(result), restoreSeq, now);
    return result;
  });

  return tx.immediate();
}

/** 8 域计数（回退验收只看这 8 个）。 */
export function domainCounts(db: Db, branchId: string): DomainCounts {
  const counts = emptyDomainCounts();
  const one = (sql: string, ...params: unknown[]): number =>
    Number((db.prepare(sql).get(...params) as { c: number }).c);
  counts.messages = one('SELECT COUNT(*) AS c FROM message WHERE branch_id = ?', branchId);
  counts.facts = one('SELECT COUNT(*) AS c FROM fact WHERE branch_id = ?', branchId);
  counts.cognition = one('SELECT COUNT(*) AS c FROM cognition WHERE branch_id = ?', branchId);
  counts.relations = one('SELECT COUNT(*) AS c FROM relation WHERE branch_id = ?', branchId);
  counts.chapters = one('SELECT COUNT(*) AS c FROM chapter WHERE branch_id = ?', branchId);
  counts.cards = one('SELECT COUNT(*) AS c FROM event_card WHERE branch_id = ?', branchId);
  counts.summaries = one(
    "SELECT COUNT(*) AS c FROM memory_node WHERE branch_id = ? AND kind = 'summary'",
    branchId,
  );
  counts.vectors = one(
    'SELECT COUNT(*) AS c FROM memory_node WHERE branch_id = ? AND embedding IS NOT NULL',
    branchId,
  );
  return counts;
}

/** 回退会"失去"多少：按 seq > target 的写入量计（UI 的 ↳ 影响 行）。 */
export function restoreImpact(db: Db, branchId: string, targetSeq: number): DomainImpact[] {
  const counts = emptyDomainCounts();
  const one = (sql: string): number =>
    Number((db.prepare(sql).get(branchId, targetSeq) as { c: number }).c);
  counts.messages = one('SELECT COUNT(*) AS c FROM message WHERE branch_id = ? AND seq > ?');
  counts.facts = one(
    'SELECT COUNT(*) AS c FROM fact WHERE branch_id = ? AND COALESCE(source_seq, 0) > ?',
  );
  counts.cognition = one('SELECT COUNT(*) AS c FROM cognition WHERE branch_id = ? AND learned_seq > ?');
  counts.relations = one('SELECT COUNT(*) AS c FROM relation WHERE branch_id = ? AND updated_seq > ?');
  counts.chapters = one(
    'SELECT COUNT(*) AS c FROM chapter WHERE branch_id = ? AND COALESCE(updated_seq, 0) > ?',
  );
  counts.cards = one(
    'SELECT COUNT(*) AS c FROM event_card WHERE branch_id = ? AND COALESCE(consumed_seq, 0) > ?',
  );
  counts.summaries = one(
    "SELECT COUNT(*) AS c FROM memory_node WHERE branch_id = ? AND kind = 'summary' AND COALESCE(source_seq, 0) > ?",
  );
  counts.vectors = one(
    'SELECT COUNT(*) AS c FROM memory_node WHERE branch_id = ? AND embedding IS NOT NULL AND COALESCE(source_seq, 0) > ?',
  );
  return domainImpact(counts, emptyDomainCounts());
}

/** 逐域指纹：只含稳定字段（名字、文本、数值），不含主键。 */
export function domainFingerprint(db: Db, branchId: string): Record<string, unknown[]> {
  const messages = db
    .prepare(
      `SELECT m.seq, m.role_type, m.percept, m.prose,
              json_extract(m.structured, '$.line') AS line,
              m.audience, COALESCE(e.name, m.agent_id) AS agent_name
       FROM message m LEFT JOIN entity e ON e.id = m.agent_id
       WHERE m.branch_id = ? ORDER BY m.seq`,
    )
    .all(branchId) as {
    seq: number;
    role_type: string;
    percept: string;
    prose: string;
    line: string | null;
    audience: string;
    agent_name: string;
  }[];
  const entityNames = new Map<string, string>();
  for (const row of db
    .prepare('SELECT id, name FROM entity WHERE branch_id = ?')
    .all(branchId) as { id: string; name: string }[]) {
    entityNames.set(row.id, row.name);
  }

  const facts = (
    db
      .prepare(
        `SELECT e.name AS subject, f.predicate, f.object_json, f.truth, f.secrecy,
                f.valid_from, f.valid_to
         FROM fact f JOIN entity e ON e.id = f.subject_id
         WHERE f.branch_id = ? ORDER BY e.name, f.predicate, f.object_json`,
      )
      .all(branchId) as {
      subject: string;
      predicate: string;
      object_json: string;
      truth: number;
      secrecy: number;
      valid_from: string;
      valid_to: string | null;
    }[]
  ).map((row) => ({ ...row }));

  const cognition = (
    db
      .prepare(
        `SELECT e.name AS character, f.subject_id, f.predicate, f.object_json,
                c.attitude, c.certainty, c.learned_seq, c.percept
         FROM cognition c
         JOIN entity e ON e.id = c.character_id
         JOIN fact f ON f.id = c.fact_id
         WHERE c.branch_id = ? ORDER BY e.name, f.predicate, f.object_json`,
      )
      .all(branchId) as {
      character: string;
      subject_id: string;
      predicate: string;
      object_json: string;
      attitude: string;
      certainty: number;
      learned_seq: number;
      percept: string;
    }[]
  ).map((row) => ({
    ...row,
    subject: entityNames.get(row.subject_id) ?? row.subject_id,
    subject_id: undefined,
  }));

  const relations = db
    .prepare(
      `SELECT ef.name AS from_name, et.name AS to_name, r.axis,
              ROUND(r.value, 6) AS value, r.reason
       FROM relation r
       JOIN entity ef ON ef.id = r.from_id
       JOIN entity et ON et.id = r.to_id
       WHERE r.branch_id = ? ORDER BY from_name, to_name, axis`,
    )
    .all(branchId);

  const chapters = db
    .prepare(
      `SELECT ch.idx, ch.title, ch.current_rev, ch.status,
              (SELECT COUNT(*) FROM revision r WHERE r.chapter_id = ch.id) AS revisions,
              (SELECT COALESCE(MAX(r.rev), 0) FROM revision r WHERE r.chapter_id = ch.id) AS max_rev
       FROM chapter ch WHERE ch.branch_id = ? ORDER BY ch.idx`,
    )
    .all(branchId);

  const cards = db
    .prepare(
      `SELECT title, min_level, weight, one_shot, (consumed_seq IS NOT NULL) AS consumed
       FROM event_card WHERE branch_id = ? ORDER BY title`,
    )
    .all(branchId);

  const summaries = db
    .prepare(
      `SELECT text, importance, pinned, hard, resolved_seq
       FROM memory_node WHERE branch_id = ? AND kind = 'summary' ORDER BY text`,
    )
    .all(branchId);

  const vectors = db
    .prepare(
      `SELECT e.name AS owner, m.embedding_dim, m.embedding_model, length(m.embedding) AS bytes
       FROM memory_node m LEFT JOIN entity e ON e.id = m.owner_id
       WHERE m.branch_id = ? AND m.embedding IS NOT NULL ORDER BY e.name, m.embedding_dim`,
    )
    .all(branchId);

  return {
    messages: messages.map((row) => ({
      ...row,
      audience: parseJson<string[]>(row.audience, []).map((id) => entityNames.get(id) ?? id),
    })),
    facts,
    cognition,
    relations,
    chapters,
    cards,
    summaries,
    vectors,
  };
}

export { RESTORE_DOMAINS };
