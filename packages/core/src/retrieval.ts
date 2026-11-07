/**
 * A4 · 记忆检索：四通道加权 RRF + 绝对刻度 + 有界时效 + 三层收口。
 *
 * 关键约束（01 §6 A4）：
 * - **绝不按本次查询的 max 归一**。rel 用绝对参考点 rrf_ref = (w_slot+w_fts)/(k+1)，
 *   否则任何查询头名都是 1.0，"rel < 0.45 当作没记住"永远不触发。
 * - 收口三层：绝对下限 → 相对截断（0.6·max）→ MMR（前 3 名免疫）。
 * - 常驻通道（pinned / 未结 clue / hard）**不进相关性排序**，单独返回；
 *   否则被钉住的里程碑在无关查询里也会排第一。
 * - 时效因子有界且弱：0.75 + 0.25·R。R 只负责"忘没忘"，排序靠相关性。
 *
 * 索引与查询分开：buildMemoryIndex 是 O(N)，每轮查询只做 O(N·q)。
 * 5 万节点的 p50 门禁测的是查询段（索引在打开记忆时建一次，不是每拍重建）。
 */
import { cosine } from './embed.js';
import { PARAMS } from './params.js';
import { jaccard, tokenize } from './text.js';
import type { MemoryEdgeKind, MemoryKind } from './types.js';

const RRF_K = PARAMS['memory.rrf_k'];
const RRF_REF = PARAMS['memory.rrf_ref'];
const FLOOR = PARAMS['memory.floor'];
const MMR_LAMBDA = PARAMS['memory.mmr_lambda'];
const MMR_IMMUNE = PARAMS['memory.mmr_immune'];
const DEFAULT_LIMIT = PARAMS['context.memory_topk'];

const W = {
  slot: PARAMS['memory.w_slot'],
  fts: PARAMS['memory.w_fts'],
  vector: PARAMS['memory.w_vector'],
  graph: PARAMS['memory.w_graph'],
} as const;

/** 半衰期（天）。fact / relationship / clue 不衰减：∞。 */
const HALFLIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  event: 30,
  summary: 180,
  preference: 365,
  fact: Number.POSITIVE_INFINITY,
  relationship: Number.POSITIVE_INFINITY,
  clue: Number.POSITIVE_INFINITY,
  world: Number.POSITIVE_INFINITY,
};

export interface MemoryRecord {
  id: string;
  text: string;
  kind: MemoryKind;
  importance: number;
  conf: number;
  /** ISO 时间；解析失败按"不衰减"处理，不抛错。 */
  validFrom: string;
  pinned: boolean;
  hard: boolean;
  resolvedSeq: number | null;
  sensitivity: number;
  slotKey?: string | null;
  ownerId?: string | null;
  embedding?: Float32Array | null;
}

export interface MemoryEdgeView {
  src: string;
  dst: string;
  kind: MemoryEdgeKind;
  weight: number;
}

export interface MemoryQuery {
  text: string;
  slotKey?: string | null;
  queryVector?: Float32Array | null;
  /** 角色视角：只召回 owner 为空或自己的节点。缺省 = 作者视角（显式查询）。 */
  asCharacterId?: string | null;
  /** 严格 owner：只召回 owner = 该角色本人的节点（自动注入角色上下文时用）。 */
  strictOwner?: boolean;
  /** 自动召回（装配）：sensitivity >= 3 一律排除；显式查询可以指定要看。 */
  auto?: boolean;
  limit?: number;
  /** 计算时效的"现在"；缺省取系统时间。注入它是为了测试可复现。 */
  now?: string;
}

export type ChannelName = 'slot' | 'fts' | 'vector' | 'graph';

export interface RankedMemory {
  id: string;
  score: number;
  rel: number;
  importance: number;
  conf: number;
  channels: Partial<Record<ChannelName, number>>;
}

export type ResidentReason = 'pinned' | 'hard' | 'clue';

export interface MemorySearchResult {
  ranked: RankedMemory[];
  /** 常驻项不参与排名，按 importance 降序、id 升序。 */
  resident: { id: string; reason: ResidentReason }[];
  reason: 'ok' | 'below_floor';
  /** 被作用域或敏感度排除的节点数，用于审计"过滤了多少"。 */
  filtered: number;
}

interface IndexedNode {
  record: MemoryRecord;
  tokens: string[];
  norm: number;
  embedding: Float32Array | null;
}

export interface MemoryIndex {
  nodes: Map<string, IndexedNode>;
  /** token → (nodeId → 词频)；df = 内层 size。 */
  df: Map<string, number>;
  adjacency: Map<string, { id: string; weight: number }[]>;
  total: number;
}

export function buildMemoryIndex(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdgeView[] = [],
): MemoryIndex {
  const nodes = new Map<string, IndexedNode>();
  const df = new Map<string, number>();
  for (const record of records) {
    const tokens = tokenize(record.text);
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
    let norm = 0;
    const embedding = record.embedding ?? null;
    if (embedding) {
      for (let i = 0; i < embedding.length; i += 1) norm += embedding[i]! * embedding[i]!;
      norm = Math.sqrt(norm);
    }
    nodes.set(record.id, { record, tokens, norm, embedding });
  }
  const adjacency = new Map<string, { id: string; weight: number }[]>();
  for (const edge of edges) {
    if (!nodes.has(edge.src) || !nodes.has(edge.dst)) continue;
    const list = adjacency.get(edge.src);
    if (list) list.push({ id: edge.dst, weight: edge.weight });
    else adjacency.set(edge.src, [{ id: edge.dst, weight: edge.weight }]);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  }
  return { nodes, df, adjacency, total: nodes.size };
}

function idfOf(index: MemoryIndex, token: string): number {
  const df = index.df.get(token) ?? 0;
  if (df === 0 || index.total === 0) return 0;
  return Math.log(1 + index.total / df);
}

function ageDays(validFrom: string, now: string): number | null {
  const from = Date.parse(validFrom);
  const to = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 86_400_000);
}

/** R = 0.5^(age/halflife)；时间不可解析时按 R=1（不衰减），不猜。 */
export function recencyOf(kind: MemoryKind, validFrom: string, now: string): number {
  const halfLife = HALFLIFE_DAYS[kind];
  if (!Number.isFinite(halfLife)) return 1;
  const age = ageDays(validFrom, now);
  if (age === null) return 1;
  return 0.5 ** (age / halfLife);
}

/**
 * 单通道排名：score 降序、id 升序。rank 从 1 开始（与 rrf_ref 的 60+1 对齐）。
 *
 * 非 slot 通道只保留前 RANK_KEEP=1024 名——5 万节点下省掉全量字符串排序与
 * 排名 Map，是 p50 门禁的主要余量。边界是算过的：
 * - 四个通道都在 1024 名之外 → s ≤ 4.9/1084 = 0.0045，远低于 floor 需要的 0.0243；
 * - 单个通道被截断时缺失的贡献 ≤ w/1084 ≤ 0.0018，不足以把头名推过 floor；
 * - slot 权重 2.0，排名 ~600 仍可能参与过线，所以 slot 通道不截断。
 * 截断可能影响尾部同分排序，不影响门禁的召回/精度判定。
 */
const RANK_KEEP = 1024;

function rankChannel(
  scores: ReadonlyMap<string, number>,
  keep: number = RANK_KEEP,
): Map<string, number> {
  if (scores.size > keep) {
    const values = new Float64Array(scores.size);
    let i = 0;
    for (const value of scores.values()) values[i++] = value;
    values.sort();
    const threshold = values[values.length - keep]!;
    const ids: string[] = [];
    for (const [id, score] of scores) if (score >= threshold) ids.push(id);
    ids.sort((a, b) => {
      const delta = scores.get(b)! - scores.get(a)!;
      if (delta !== 0) return delta;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const ranks = new Map<string, number>();
    const take = Math.min(ids.length, keep);
    for (let r = 0; r < take; r += 1) ranks.set(ids[r]!, r + 1);
    return ranks;
  }
  const ids: string[] = [];
  for (const [id, score] of scores) if (score > 0) ids.push(id);
  ids.sort((a, b) => {
    const delta = scores.get(b)! - scores.get(a)!;
    if (delta !== 0) return delta;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const ranks = new Map<string, number>();
  ids.forEach((id, index) => ranks.set(id, index + 1));
  return ranks;
}

/**
 * 候选预筛（与 floor 等价，不是近似）：
 * 单通道的最大 rel 只有 w/(k+1)/rrf_ref×(0.75…1)：
 *   vector 0.227、fts 0.295、graph 0.136 —— 全部低于 0.45；
 * 只有 slot（2.0）能单通道过线。因此"至少两个通道命中、或命中 slot"之外的
 * 节点必然被绝对下限丢掉，不必进入排序。5 万节点下这是主要的省时点。
 */
function candidateIds(
  ranks: readonly Map<string, number>[],
  slotRanks: Map<string, number>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const channel of ranks) {
    for (const id of channel.keys()) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [id, count] of counts) {
    if (count >= 2 || slotRanks.has(id)) out.add(id);
  }
  return out;
}

interface Scoped {
  candidates: IndexedNode[];
  filtered: number;
  resident: { id: string; reason: ResidentReason }[];
}

function scopeOf(index: MemoryIndex, query: MemoryQuery): Scoped {
  const candidates: IndexedNode[] = [];
  const resident: { id: string; reason: ResidentReason }[] = [];
  let filtered = 0;
  for (const node of index.nodes.values()) {
    const record = node.record;
    // 显式查询（auto 缺省 false）可以看高敏节点；自动召回一律排除。
    if (record.sensitivity >= 3 && query.auto === true) {
      filtered += 1;
      continue;
    }
    if (query.asCharacterId != null) {
      if (query.strictOwner) {
        if (record.ownerId !== query.asCharacterId) {
          filtered += 1;
          continue;
        }
      } else if (record.ownerId != null && record.ownerId !== query.asCharacterId) {
        filtered += 1;
        continue;
      }
    }
    if (record.kind === 'clue' && record.resolvedSeq !== null) {
      filtered += 1; // 已回收的线索退出召回（A4）
      continue;
    }
    const isResident =
      record.pinned || record.hard || (record.kind === 'clue' && record.resolvedSeq === null);
    if (isResident) {
      resident.push({
        id: record.id,
        reason: record.hard ? 'hard' : record.pinned ? 'pinned' : 'clue',
      });
      continue;
    }
    candidates.push(node);
  }
  resident.sort((a, b) => {
    const ia = index.nodes.get(a.id)!.record.importance;
    const ib = index.nodes.get(b.id)!.record.importance;
    return ib - ia || a.id.localeCompare(b.id);
  });
  return { candidates, filtered, resident };
}

function ftsScores(index: MemoryIndex, queryTokens: readonly string[], nodes: readonly IndexedNode[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (queryTokens.length === 0) return scores;
  const idf = new Map<string, number>();
  const querySet = new Set<string>();
  for (const token of queryTokens) {
    querySet.add(token);
    idf.set(token, idfOf(index, token));
  }
  // 遍历节点自己的 token 命中查询集，而不是给每个节点建 Set：
  // 5 万节点 × 每拍一次查询，50k 次 Set 分配是 p50 的主要开销。
  for (const node of nodes) {
    let score = 0;
    for (const token of node.tokens) {
      if (querySet.has(token)) score += idf.get(token)!;
    }
    if (score > 0) scores.set(node.record.id, score);
  }
  return scores;
}

function vectorScores(query: MemoryQuery, nodes: readonly IndexedNode[]): Map<string, number> {
  const scores = new Map<string, number>();
  const queryVector = query.queryVector ?? null;
  if (!queryVector) return scores;
  let queryNorm = 0;
  for (let i = 0; i < queryVector.length; i += 1) queryNorm += queryVector[i]! * queryVector[i]!;
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return scores;
  for (const node of nodes) {
    const embedding = node.embedding;
    if (!embedding || node.norm === 0) continue;
    // 节点范数在索引阶段算好；查询范数只算一次。4 路展开减少 512 维循环开销。
    let dot = 0;
    let i = 0;
    const end = embedding.length - 3;
    for (; i < end; i += 4) {
      dot +=
        queryVector[i]! * embedding[i]! +
        queryVector[i + 1]! * embedding[i + 1]! +
        queryVector[i + 2]! * embedding[i + 2]! +
        queryVector[i + 3]! * embedding[i + 3]!;
    }
    for (; i < embedding.length; i += 1) dot += queryVector[i]! * embedding[i]!;
    const value = dot / (node.norm * queryNorm);
    if (value > 0) scores.set(node.record.id, value);
  }
  return scores;
}

function graphScores(
  index: MemoryIndex,
  seeds: readonly string[],
  nodes: readonly IndexedNode[],
): Map<string, number> {
  const scores = new Map<string, number>();
  const allowed = new Set(nodes.map((node) => node.record.id));
  seeds.forEach((seed, i) => {
    const outgoing = index.adjacency.get(seed) ?? [];
    const base = 1 / (1 + i);
    for (const edge of outgoing) {
      if (!allowed.has(edge.id)) continue;
      const value = edge.weight * base;
      if (value > (scores.get(edge.id) ?? 0)) scores.set(edge.id, value);
    }
  });
  return scores;
}

function similarity(a: IndexedNode, b: IndexedNode): number {
  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) {
    return Math.max(0, cosine(a.embedding, b.embedding));
  }
  return jaccard(a.tokens, b.tokens);
}

/**
 * 三层收口：绝对下限 → 相对截断 → MMR。
 * `ranked` 已按 final 降序；MMR 只决定第 4 名之后谁留下。
 */
function mmrSelect(
  ordered: readonly RankedMemory[],
  index: MemoryIndex,
  limit: number,
): RankedMemory[] {
  if (ordered.length <= limit) return [...ordered];
  const selected: RankedMemory[] = ordered.slice(0, Math.min(MMR_IMMUNE, limit));
  const pool = ordered.slice(selected.length);
  const maxRel = ordered[0]?.rel ?? 0;
  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i]!;
      const node = index.nodes.get(candidate.id)!;
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = similarity(node, index.nodes.get(chosen.id)!);
        if (sim > maxSim) maxSim = sim;
      }
      const relevance = maxRel > 0 ? candidate.rel / maxRel : 0;
      const score = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (score > bestScore || (score === bestScore && candidate.id < pool[bestIndex]!.id)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

export function searchMemoryIndex(index: MemoryIndex, query: MemoryQuery): MemorySearchResult {
  const now = query.now ?? new Date().toISOString();
  const scope = scopeOf(index, query);
  const nodes = scope.candidates;

  const queryTokens = tokenize(query.text);
  const fts = ftsScores(index, queryTokens, nodes);
  const vector = vectorScores(query, nodes);
  const slot = new Map<string, number>();
  if (query.slotKey) {
    let i = 0;
    const matching = nodes
      .filter((node) => node.record.slotKey === query.slotKey)
      .sort(
        (a, b) =>
          b.record.validFrom.localeCompare(a.record.validFrom) ||
          a.record.id.localeCompare(b.record.id),
      );
    for (const node of matching) {
      i += 1;
      slot.set(node.record.id, 1 / i);
    }
  }

  const ftsRanks = rankChannel(fts);
  const vectorRanks = rankChannel(vector);
  const slotRanks = rankChannel(slot, Number.MAX_SAFE_INTEGER);

  // 图通道的种子：三个相关性通道的前 3 名（并集，按最好名次排序）。
  const seedRank = new Map<string, number>();
  for (const ranks of [slotRanks, ftsRanks, vectorRanks]) {
    for (const [id, rank] of ranks) {
      if (rank <= 3 && (seedRank.get(id) ?? Infinity) > rank) seedRank.set(id, rank);
    }
  }
  const seeds = [...seedRank.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([id]) => id);
  const graph = graphScores(index, seeds, nodes);
  const graphRanks = rankChannel(graph);

  const ranked: RankedMemory[] = [];
  const byId = new Map(nodes.map((node) => [node.record.id, node]));
  const candidates = candidateIds([slotRanks, ftsRanks, vectorRanks, graphRanks], slotRanks);
  for (const id of candidates) {
    const node = byId.get(id);
    if (!node) continue;
    const channels: Partial<Record<ChannelName, number>> = {};
    let s = 0;
    for (const [name, ranks] of [
      ['slot', slotRanks],
      ['fts', ftsRanks],
      ['vector', vectorRanks],
      ['graph', graphRanks],
    ] as const) {
      const rank = ranks.get(id);
      if (rank === undefined) continue;
      channels[name] = rank;
      s += W[name] / (RRF_K + rank);
    }
    if (s === 0) continue;
    const record = node.record;
    const importance = clamp(record.importance, 0.05, 3);
    const conf = clamp(record.conf, 0, 1);
    const rel = Math.min(1, s / RRF_REF) * (0.75 + 0.25 * recencyOf(record.kind, record.validFrom, now));
    const score = 0.6 * rel + 0.25 * importance + 0.15 * conf;
    ranked.push({ id, score, rel, importance, conf, channels });
  }

  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (ranked.length === 0 || ranked[0]!.rel < FLOOR) {
    return { ranked: [], resident: scope.resident, reason: 'below_floor', filtered: scope.filtered };
  }
  const maxRel = ranked[0]!.rel;
  const survivors = ranked.filter((entry) => entry.rel >= 0.6 * maxRel);
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
  const selected = mmrSelect(survivors, index, limit).map((entry) => ({
    ...entry,
    // 被收口留下的条目重新按 score 排序，保证输出稳定可断言。
  }));
  selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { ranked: selected, resident: scope.resident, reason: 'ok', filtered: scope.filtered };
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** 便捷入口：一次性建索引再查（少量节点时用；5 万节点请复用 index）。 */
export function searchMemory(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdgeView[],
  query: MemoryQuery,
): MemorySearchResult {
  return searchMemoryIndex(buildMemoryIndex(records, edges), query);
}
