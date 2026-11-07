/**
 * 记忆检索的读路径：SQLite → core 的 MemoryRecord（不把 SQL 放进 core）。
 *
 * 自动注入角色上下文时用 strictOwner：只认 owner = 该角色本人的节点。
 * 场景关闭时生成的 event/summary 节点 owner 为空，属于作者/规划材料，
 * 不会因为"检索到了"就漏进角色提示词（先过滤，后拼装）。
 */
import {
  PARAMS,
  buildMemoryIndex,
  decodeVector,
  hashEmbed,
  searchMemoryIndex,
  type MemoryEdgeKind,
  type MemoryEdgeView,
  type MemoryKind,
  type MemoryRecord,
  type MemorySearchResult,
  type MemoryView,
} from '@noryth/core';
import type { Db } from './db.js';
import { UsageError } from './errors.js';

const VECTOR_DIM = PARAMS['memory.vector_dim'];
const CHARACTER_MEMORY_TOPK = PARAMS['context.memory_topk'];

interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  importance: number;
  conf: number;
  valid_from: string;
  pinned: number;
  hard: number;
  resolved_seq: number | null;
  sensitivity: number;
  slot_key: string | null;
  owner_id: string | null;
  embedding: Buffer | null;
  embedding_dim: number | null;
}

export function loadMemoryRecords(db: Db, branchId: string): MemoryRecord[] {
  const rows = db
    .prepare(
      `SELECT id, kind, text, importance, conf, valid_from, pinned, hard, resolved_seq,
              sensitivity, slot_key, owner_id, embedding, embedding_dim
       FROM memory_node WHERE branch_id = ? ORDER BY id`,
    )
    .all(branchId) as MemoryRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as MemoryKind,
    text: row.text,
    importance: row.importance,
    conf: row.conf,
    validFrom: row.valid_from,
    pinned: row.pinned === 1,
    hard: row.hard === 1,
    resolvedSeq: row.resolved_seq,
    sensitivity: row.sensitivity,
    slotKey: row.slot_key,
    ownerId: row.owner_id,
    embedding:
      row.embedding && row.embedding_dim === VECTOR_DIM
        ? decodeVector(new Uint8Array(row.embedding), VECTOR_DIM)
        : null,
  }));
}

export function loadMemoryEdges(db: Db, branchId: string): MemoryEdgeView[] {
  const rows = db
    .prepare(
      `SELECT e.src, e.dst, e.kind, e.weight
       FROM memory_edge e
       JOIN memory_node m ON m.id = e.src
       WHERE m.branch_id = ? ORDER BY e.src, e.dst, e.kind`,
    )
    .all(branchId) as { src: string; dst: string; kind: string; weight: number }[];
  return rows.map((row) => ({
    src: row.src,
    dst: row.dst,
    kind: row.kind as MemoryEdgeKind,
    weight: row.weight,
  }));
}

export interface MemorySearchInput {
  branchId?: string;
  text: string;
  slotKey?: string;
  asCharacterId?: string;
  strictOwner?: boolean;
  auto?: boolean;
  limit?: number;
  queryVector?: Float32Array;
  now?: string;
}

function activeBranchId(db: Db): string {
  const row = db
    .prepare('SELECT active_branch_id AS id FROM project_state LIMIT 1')
    .get() as { id: string } | undefined;
  if (!row) throw new UsageError('项目没有活动分支');
  return row.id;
}

export function searchMemories(db: Db, input: MemorySearchInput): MemorySearchResult {
  const branchId = input.branchId ?? activeBranchId(db);
  const records = loadMemoryRecords(db, branchId);
  const edges = loadMemoryEdges(db, branchId);
  return searchMemoryIndex(buildMemoryIndex(records, edges), {
    text: input.text,
    slotKey: input.slotKey ?? null,
    queryVector: input.queryVector ?? hashEmbed(input.text),
    asCharacterId: input.asCharacterId ?? null,
    strictOwner: input.strictOwner ?? false,
    auto: input.auto ?? false,
    limit: input.limit ?? CHARACTER_MEMORY_TOPK,
    now: input.now,
  });
}

/**
 * 角色自动召回：只给 owner = 本人 的记忆。没有 owner 的节点是作者材料，
 * 不能让"检索到了"变成"它知道了"。
 */
export function readCharacterMemories(
  db: Db,
  sceneId: string,
  characterId: string,
  limit = CHARACTER_MEMORY_TOPK,
): MemoryView[] {
  const scene = db
    .prepare(
      `SELECT s.title, s.goal, s.branch_id AS branchId
       FROM scene s WHERE s.id = ?`,
    )
    .get(sceneId) as { title: string; goal: string; branchId: string } | undefined;
  if (!scene) return [];
  const recent = db
    .prepare(
      `SELECT prose FROM message WHERE scene_id = ? AND role_type IN ('character','narrator')
       ORDER BY seq DESC LIMIT 2`,
    )
    .all(sceneId) as { prose: string }[];
  let goal = scene.goal;
  try {
    const parsed = JSON.parse(scene.goal) as { text?: unknown };
    if (typeof parsed.text === 'string') goal = parsed.text;
  } catch {
    /* goal 不是 JSON：原文参与查询即可 */
  }
  const query = [scene.title, goal, ...recent.map((row) => row.prose)].join(' ');
  const result = searchMemories(db, {
    branchId: scene.branchId,
    text: query,
    asCharacterId: characterId,
    strictOwner: true,
    auto: true,
    limit,
  });
  return result.ranked.map((entry) => {
    const row = db
      .prepare('SELECT id, text, kind FROM memory_node WHERE id = ?')
      .get(entry.id) as { id: string; text: string; kind: string };
    return { id: row.id, text: row.text, kind: row.kind };
  });
}
