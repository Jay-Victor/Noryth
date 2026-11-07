/**
 * P1 读路径：把 SQLite 行投影成 core 的运行时快照。
 *
 * core 不 import store；这个文件是两者之间唯一的桥。
 * 所有"谁能感知什么"的判定都从 message.audience + cognition 读，
 * 不使用"同场即可感知"。
 */
import {
  PARAMS,
  assertKey,
  evalExit,
  factKey,
  relKey,
  type ActorRuntime,
  type BeatDigestEntry,
  type CharacterContextInput,
  type CognitionView,
  type ClueView,
  type DeckCard,
  type ExitExpr,
  type FactView,
  type NarratorContextInput,
  type RelationView,
  type SceneEvalState,
  type SceneRuntime,
  type TheaterRuntime,
  type BeatView,
} from '@noryth/core';
import type { Db } from './db.js';
import { UsageError } from './errors.js';
import { readCharacterMemories } from './memory-search.js';

const MAX_CANDIDATES = PARAMS['scheduler.max_candidates'];
const RECENT_MAX = PARAMS['context.recent_max_beats'];

interface SceneRow {
  id: string;
  state: SceneRuntime['state'];
  present: string;
  goal: string;
  conflict_level: number;
  max_beats: number;
  beats: number;
}

interface EntityRow {
  id: string;
  name: string;
  kind: string;
  card: string;
}

export interface LoadedTheater {
  runtime: TheaterRuntime;
  /** 触发谓词满足的事件卡；不满足的留在牌堆（03 §5.1）。 */
  eligibleCards: ReadonlySet<string>;
  /** 卡 id → 标题（导演事件与 CLI 输出用）。 */
  cardTitles: Readonly<Record<string, string>>;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function loadTheater(db: Db, sceneId: string): LoadedTheater {
  const branch = db
    .prepare(
      `SELECT b.id FROM branch b JOIN project_state ps ON ps.active_branch_id = b.id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!branch) throw new UsageError('项目没有活动分支');

  const scene = db
    .prepare(
      `SELECT id, state, present, goal, conflict_level, max_beats, beats
       FROM scene WHERE id = ? AND branch_id = ?`,
    )
    .get(sceneId, branch.id) as SceneRow | undefined;
  if (!scene) throw new UsageError(`场景不存在或不属于当前分支：${sceneId}`);

  const sceneGoal = parseJson<{ cast?: Record<string, Record<string, unknown>> }>(scene.goal, {});
  const goalCast = sceneGoal.cast ?? {};

  const present = parseJson<string[]>(scene.present, []);
  if (present.length > MAX_CANDIDATES) {
    throw new UsageError(`在场者超过评分上限 ${MAX_CANDIDATES}`);
  }

  const entities = new Map<string, EntityRow>();
  for (const id of present) {
    const row = db
      .prepare('SELECT id, name, kind, card FROM entity WHERE id = ? AND branch_id = ?')
      .get(id, branch.id) as EntityRow | undefined;
    if (row) entities.set(id, row);
  }

  const agents = db
    .prepare(
      `SELECT id, role_type, name, entity_id, card, permissions
       FROM agent_config WHERE branch_id = ? AND enabled = 1`,
    )
    .all(branch.id) as {
    id: string;
    role_type: string;
    name: string;
    entity_id: string | null;
    card: string;
    permissions: string;
  }[];

  const stats = new Map<string, { count: number; last: number }>();
  for (const row of db
    .prepare('SELECT agent_id, COUNT(*) AS c, MAX(seq) AS last FROM beat WHERE scene_id = ? GROUP BY agent_id')
    .all(scene.id) as { agent_id: string; c: number; last: number }[]) {
    stats.set(row.agent_id, { count: row.c, last: row.last });
  }

  const recentBeats = db
    .prepare('SELECT agent_id, seq, breakdown FROM beat WHERE scene_id = ? ORDER BY seq DESC LIMIT 40')
    .all(scene.id) as { agent_id: string; seq: number; breakdown: string }[];

  const actors: ActorRuntime[] = [];
  for (const agent of agents) {
    const isNarrator = agent.role_type === 'narrator';
    let id: string;
    let name: string;
    if (isNarrator) {
      id = 'narrator';
      name = agent.name;
    } else {
      if (!agent.entity_id) continue;
      const entity = entities.get(agent.entity_id);
      if (!entity) continue; // 不在场
      id = entity.id;
      name = entity.name;
    }
    const permissions = parseJson<Record<string, unknown>>(agent.permissions, {});
    const weights = (agent.entity_id ? goalCast[agent.entity_id] : undefined) ?? permissions;
    const stat = stats.get(id) ?? { count: 0, last: 0 };
    const streak = streakOf(recentBeats, id);
    actors.push({
      id,
      name,
      isNarrator,
      goalRel: numberOr(weights.goalRel, 0.5),
      initiative: numberOr(weights.initiative, 0.5),
      secretThreat: weights.secretThreat === true,
      ownership: numberOr(weights.ownership, 0),
      speakCount: stat.count,
      since: stat.last === 0 ? 99 : scene.beats - stat.last,
      streak: stat.last === 0 ? 0 : streak,
    });
  }

  if (!actors.some((a) => a.isNarrator)) {
    throw new UsageError('本分支缺少旁白 agent：用 noryth scene create 建场');
  }
  if (actors.length > MAX_CANDIDATES + 1) {
    throw new UsageError(`候选超过 ${MAX_CANDIDATES + 1}（含旁白）`);
  }

  const narratorStat = stats.get('narrator');
  const beatsSinceNarrator = narratorStat ? scene.beats - narratorStat.last : scene.beats;
  const consecutiveDialogue = recentBeats.findIndex((b) => b.agent_id === 'narrator');
  const dialogueTail = consecutiveDialogue === -1 ? recentBeats.length : consecutiveDialogue;

  const lastBeat = recentBeats[0];
  const lastBreakdown = lastBeat ? parseJson<Record<string, unknown>>(lastBeat.breakdown, {}) : {};
  const addressedTo =
    lastBeat && lastBeat.agent_id !== 'narrator'
      ? (lastBreakdown.addressedTo as string[] | undefined) ?? []
      : [];

  const conflictHistory = recentBeats
    .slice(0, PARAMS['scene.flat_conflict_window'])
    .map((b) => numberOr(parseJson<Record<string, unknown>>(b.breakdown, {}).conflict, scene.conflict_level))
    .reverse();

  const deck = readDeck(db, branch.id);
  const cardTitles: Record<string, string> = {};
  for (const row of db
    .prepare('SELECT id, title FROM event_card WHERE branch_id = ?')
    .all(branch.id) as { id: string; title: string }[]) {
    cardTitles[row.id] = row.title;
  }
  const evalState = readSceneEvalState(db, scene.id);
  const eligibleCards = new Set<string>();
  for (const card of deck) {
    if (card.consumed) continue;
    const trigger = db
      .prepare('SELECT trigger_json FROM event_card WHERE id = ?')
      .get(card.id) as { trigger_json: string } | undefined;
    if (!trigger) continue;
    const expr = parseJson<ExitExpr | null>(trigger.trigger_json, null);
    if (expr === null) {
      eligibleCards.add(card.id);
      continue;
    }
    try {
      if (evalExit(expr, evalState)) eligibleCards.add(card.id);
    } catch (error) {
      throw new UsageError(
        `事件卡 ${card.id} 的 trigger 不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    runtime: {
      scene: {
        id: scene.id,
        state: scene.state,
        present,
        conflictLevel: scene.conflict_level,
        maxBeats: scene.max_beats,
        beats: scene.beats,
      },
      actors,
      beatsSinceNarrator,
      consecutiveDialogue: dialogueTail,
      addressedTo,
      conflictHistory,
      deck,
    },
    eligibleCards,
    cardTitles,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function streakOf(
  beats: readonly { agent_id: string; seq: number }[],
  agentId: string,
): number {
  let streak = 0;
  for (const beat of beats) {
    if (beat.agent_id !== agentId) break;
    streak += 1;
  }
  return streak;
}

export function readDeck(db: Db, branchId: string): DeckCard[] {
  const rows = db
    .prepare(
      `SELECT id, min_level, one_shot, consumed_seq
       FROM event_card WHERE branch_id = ?
       ORDER BY weight DESC, title, id`,
    )
    .all(branchId) as {
    id: string;
    min_level: number;
    one_shot: number;
    consumed_seq: number | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    minLevel: row.min_level,
    oneShot: row.one_shot === 1,
    consumed: row.consumed_seq !== null,
  }));
}

/** 场景卡：地点、时间、在场者、目标、冲突等级（01 §6 A2 scene 段）。 */
export function readSceneCard(db: Db, sceneId: string): {
  card: CharacterContextInput['scene'];
  sceneId: string;
  present: string[];
} {
  const row = db
    .prepare(
      `SELECT s.id, s.branch_id, s.title, s.story_start, s.timeline, s.present,
              s.goal, s.conflict_level, s.summary, e.name AS location_name
       FROM scene s LEFT JOIN entity e ON e.id = s.location_id
       WHERE s.id = ?`,
    )
    .get(sceneId) as
    | {
        id: string;
        branch_id: string;
        title: string;
        story_start: string;
        timeline: string;
        present: string;
        goal: string;
        conflict_level: number;
        summary: string | null;
        location_name: string | null;
      }
    | undefined;
  if (!row) throw new UsageError(`场景不存在：${sceneId}`);
  const present = parseJson<string[]>(row.present, []);
  const presentNames: string[] = [];
  for (const id of present) {
    const entity = db.prepare('SELECT name FROM entity WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (entity) presentNames.push(entity.name);
  }
  const goal = parseJson<Record<string, unknown>>(row.goal, {});
  return {
    sceneId: row.id,
    present,
    card: {
      title: row.title,
      location: row.location_name ?? '（未指定）',
      storyStart: row.story_start,
      timeline: row.timeline,
      presentNames,
      goal: typeof goal.text === 'string' ? goal.text : row.goal,
      conflictLevel: row.conflict_level,
      situation: row.summary ?? '',
    },
  };
}

export function readAgentCard(db: Db, agentId: string): CharacterContextInput['agent'] {
  if (agentId === 'narrator') {
    const row = db
      .prepare("SELECT name, card FROM agent_config WHERE role_type = 'narrator' LIMIT 1")
      .get() as { name: string; card: string } | undefined;
    return {
      name: row?.name ?? '旁白',
      identity: '叙述者',
      personality: '冷静、克制，只呈现画面',
      speechStyle: '书面叙述',
      values: '让读者看见',
      want: '把这一拍写成画面',
    };
  }
  const row = db
    .prepare(
      `SELECT e.name, e.card, a.card AS agent_card
       FROM entity e LEFT JOIN agent_config a ON a.entity_id = e.id
       WHERE e.id = ?`,
    )
    .get(agentId) as { name: string; card: string; agent_card: string | null } | undefined;
  if (!row) throw new UsageError(`角色不存在：${agentId}`);
  const card = parseJson<Record<string, unknown>>(
    row.card !== '{}' ? row.card : row.agent_card ?? '{}',
    {},
  );
  return {
    name: row.name,
    identity: str(card.identity),
    personality: str(card.personality),
    speechStyle: str(card.speech_style ?? card.speechStyle),
    values: str(card.values),
    want: str(card.want),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function projectName(db: Db): string {
  const row = db.prepare('SELECT name FROM project LIMIT 1').get() as
    | { name: string }
    | undefined;
  return row?.name ?? '未命名项目';
}

/** 该角色感知到的最近拍：受众过滤 + 自己的发言；旁白/导演不进角色上下文。 */
export function readRecentForCharacter(
  db: Db,
  sceneId: string,
  characterId: string,
  limit = RECENT_MAX,
): BeatView[] {
  const rows = db
    .prepare(
      `SELECT seq, agent_id, role_type, prose, audience, percept, structured
       FROM message WHERE scene_id = ? ORDER BY seq DESC LIMIT 80`,
    )
    .all(sceneId) as {
    seq: number;
    agent_id: string;
    role_type: string;
    prose: string;
    audience: string;
    percept: string;
    structured: string;
  }[];
  const out: BeatView[] = [];
  for (const row of rows) {
    if (row.role_type === 'director' || row.role_type === 'system') continue;
    if (row.percept === 'director' || row.percept === 'system') continue;
    const audience = parseJson<string[]>(row.audience, []);
    const own = row.agent_id === characterId;
    const perceived =
      (row.percept === 'public' || row.percept === 'whisper') && audience.includes(characterId);
    if (!own && !perceived) continue;
    const structured = parseJson<Record<string, unknown>>(row.structured, {});
    const speaker =
      row.role_type === 'narrator'
        ? '旁白'
        : (db.prepare('SELECT name FROM entity WHERE id = ?').get(row.agent_id) as
            | { name: string }
            | undefined)?.name ?? row.agent_id;
    const prose =
      row.prose.length > 0
        ? row.prose
        : typeof structured.line === 'string'
          ? structured.line
          : '';
    if (prose.length === 0) continue;
    out.push({ seq: row.seq, speaker, roleType: row.role_type, prose });
    if (out.length >= limit) break;
  }
  return out.reverse();
}

/** 旁白的最近拍：上一拍摘要即可；旁白不需要读心（03 §2.2）。 */
export function readRecentForNarrator(db: Db, sceneId: string, limit = 2): BeatView[] {
  const rows = db
    .prepare(
      `SELECT seq, agent_id, role_type, prose FROM message
       WHERE scene_id = ? AND role_type IN ('character','narrator')
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(sceneId, limit) as {
    seq: number;
    agent_id: string;
    role_type: string;
    prose: string;
  }[];
  return rows
    .map((row) => ({
      seq: row.seq,
      speaker:
        row.role_type === 'narrator'
          ? '旁白'
          : (db.prepare('SELECT name FROM entity WHERE id = ?').get(row.agent_id) as
              | { name: string }
              | undefined)?.name ?? row.agent_id,
      roleType: row.role_type,
      prose: row.prose,
    }))
    .reverse();
}

export function readFacts(db: Db, branchId: string): FactView[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.subject_id, e.name AS subject_name, f.predicate, f.object_json,
              f.truth, f.secrecy, f.source_seq
       FROM fact f JOIN entity e ON e.id = f.subject_id
       WHERE f.branch_id = ? AND f.valid_to IS NULL
       ORDER BY COALESCE(f.source_seq, 0) DESC, f.id`,
    )
    .all(branchId) as {
    id: string;
    subject_id: string;
    subject_name: string;
    predicate: string;
    object_json: string;
    truth: number;
    secrecy: number;
    source_seq: number | null;
  }[];
  return rows.map((row) => {
    const object = parseJson<unknown>(row.object_json, null);
    return {
      id: row.id,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      predicate: row.predicate,
      objectText: objectText(object),
      truth: row.truth,
      secrecy: row.secrecy,
      source: row.source_seq !== null ? `事件 ${row.source_seq}` : '设定',
      marker: objectText(object),
      observable: row.secrecy <= 1,
    };
  });
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

export function readCognition(db: Db, branchId: string, characterId?: string): CognitionView[] {
  const rows = (
    characterId
      ? db
          .prepare(
            `SELECT character_id, fact_id, attitude, certainty, percept
             FROM cognition WHERE branch_id = ? AND character_id = ?`,
          )
          .all(branchId, characterId)
      : db
          .prepare(
            `SELECT character_id, fact_id, attitude, certainty, percept
             FROM cognition WHERE branch_id = ?`,
          )
          .all(branchId)
  ) as {
    character_id: string;
    fact_id: string;
    attitude: string;
    certainty: number;
    percept: string;
  }[];
  return rows.map((row) => ({
    characterId: row.character_id,
    factId: row.fact_id,
    attitude: row.attitude,
    certainty: row.certainty,
    percept: row.percept,
  }));
}

export function readRelations(
  db: Db,
  branchId: string,
  fromId: string,
  toIds: readonly string[],
): RelationView[] {
  if (toIds.length === 0) return [];
  const placeholders = toIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.name AS to_name, r.axis, r.value, r.reason
       FROM relation r JOIN entity e ON e.id = r.to_id
       WHERE r.branch_id = ? AND r.from_id = ? AND r.to_id IN (${placeholders})
       ORDER BY e.name, r.axis`,
    )
    .all(branchId, fromId, ...toIds) as {
    to_name: string;
    axis: string;
    value: number;
    reason: string | null;
  }[];
  return rows.map((row) => ({
    toName: row.to_name,
    axis: row.axis,
    value: row.value,
    reason: row.reason ?? undefined,
  }));
}

export function readClues(db: Db, branchId: string): ClueView[] {
  const rows = db
    .prepare(
      `SELECT id, text, source_seq FROM memory_node
       WHERE branch_id = ? AND kind = 'clue' AND resolved_seq IS NULL AND sensitivity < 3
       ORDER BY importance DESC, id`,
    )
    .all(branchId) as { id: string; text: string; source_seq: number | null }[];
  return rows.map((row) => ({ id: row.id, text: row.text }));
}

export function readCharacterContext(
  db: Db,
  sceneId: string,
  characterId: string,
  budget?: number,
): CharacterContextInput {
  const scene = readSceneCard(db, sceneId);
  const branchId = (
    db.prepare('SELECT branch_id FROM scene WHERE id = ?').get(sceneId) as {
      branch_id: string;
    }
  ).branch_id;
  return {
    characterId,
    agent: readAgentCard(db, characterId),
    scene: scene.card,
    novelTitle: projectName(db),
    recent: readRecentForCharacter(db, sceneId, characterId),
    facts: readFacts(db, branchId),
    cognition: readCognition(db, branchId),
    relations: readRelations(
      db,
      branchId,
      characterId,
      scene.present.filter((id) => id !== characterId),
    ),
    clues: readClues(db, branchId),
    memories: readCharacterMemories(db, sceneId, characterId),
    budget,
  };
}

export function readNarratorContext(
  db: Db,
  sceneId: string,
  budget?: number,
): NarratorContextInput {
  const scene = readSceneCard(db, sceneId);
  const branchId = (
    db.prepare('SELECT branch_id FROM scene WHERE id = ?').get(sceneId) as {
      branch_id: string;
    }
  ).branch_id;
  return {
    agent: readAgentCard(db, 'narrator'),
    scene: scene.card,
    novelTitle: projectName(db),
    recent: readRecentForNarrator(db, sceneId),
    facts: readFacts(db, branchId),
    cognition: readCognition(db, branchId),
    present: scene.present,
    clues: readClues(db, branchId),
    budget,
  };
}

/** 收束求值状态：事实与关系都按"名字"建键，跨分支稳定（A5）。 */
export function readSceneEvalState(db: Db, sceneId: string): SceneEvalState {
  const scene = db
    .prepare('SELECT id, branch_id, beats FROM scene WHERE id = ?')
    .get(sceneId) as { id: string; branch_id: string; beats: number } | undefined;
  if (!scene) throw new UsageError(`场景不存在：${sceneId}`);
  const facts = new Map<string, unknown>();
  for (const row of db
    .prepare(
      `SELECT e.name AS subject, f.predicate, f.object_json
       FROM fact f JOIN entity e ON e.id = f.subject_id
       WHERE f.branch_id = ? AND f.valid_to IS NULL`,
    )
    .all(scene.branch_id) as { subject: string; predicate: string; object_json: string }[]) {
    facts.set(factKey(row.subject, row.predicate), parseJson(row.object_json, null));
  }
  const rels = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT ef.name AS from_name, et.name AS to_name, r.axis, r.value
       FROM relation r
       JOIN entity ef ON ef.id = r.from_id
       JOIN entity et ON et.id = r.to_id
       WHERE r.branch_id = ?`,
    )
    .all(scene.branch_id) as {
    from_name: string;
    to_name: string;
    axis: string;
    value: number;
  }[]) {
    rels.set(relKey(row.from_name, row.to_name, row.axis), row.value);
  }
  return { facts, rels, beats: scene.beats };
}

/** asserts 匹配索引：entity id 与名字两种键都建，宽容模型输出的两种写法。 */
export function readClaimIndex(
  db: Db,
  branchId: string,
): Map<string, { factId: string; truth: number }> {
  const rows = db
    .prepare(
      `SELECT f.id, f.subject_id, e.name AS subject_name, f.predicate, f.object_json, f.truth
       FROM fact f JOIN entity e ON e.id = f.subject_id
       WHERE f.branch_id = ? AND f.valid_to IS NULL`,
    )
    .all(branchId) as {
    id: string;
    subject_id: string;
    subject_name: string;
    predicate: string;
    object_json: string;
    truth: number;
  }[];
  const index = new Map<string, { factId: string; truth: number }>();
  for (const row of rows) {
    const object = parseJson<unknown>(row.object_json, null);
    index.set(assertKey(row.subject_id, row.predicate, object), { factId: row.id, truth: row.truth });
    index.set(assertKey(row.subject_name, row.predicate, object), { factId: row.id, truth: row.truth });
  }
  return index;
}

export function readKnownFactIds(db: Db, branchId: string, characterId: string): Set<string> {
  const rows = db
    .prepare('SELECT fact_id FROM cognition WHERE branch_id = ? AND character_id = ?')
    .all(branchId, characterId) as { fact_id: string }[];
  return new Set(rows.map((row) => row.fact_id));
}

export function readBeatHistory(
  db: Db,
  sceneId: string,
  fromSeq = 1,
): BeatDigestEntry[] {
  const rows = db
    .prepare(
      `SELECT b.seq, COALESCE(e.name, b.agent_id) AS agent, b.mode
       FROM beat b LEFT JOIN entity e ON e.id = b.agent_id
       WHERE b.scene_id = ? AND b.seq >= ? ORDER BY b.seq`,
    )
    .all(sceneId, fromSeq) as { seq: number; agent: string; mode: string }[];
  return rows.map((row) => ({
    seq: row.seq,
    agent: row.agent,
    mode: row.mode as BeatDigestEntry['mode'],
  }));
}

export interface SceneListItem {
  id: string;
  idx: number;
  title: string;
  state: string;
  beats: number;
  maxBeats: number;
  conflictLevel: number;
  timeline: string;
}

export function listScenes(db: Db): SceneListItem[] {
  const branch = db
    .prepare('SELECT active_branch_id AS id FROM project_state LIMIT 1')
    .get() as { id: string } | undefined;
  if (!branch) throw new UsageError('项目没有活动分支');
  return (db
    .prepare(
      `SELECT id, idx, title, state, beats, max_beats AS maxBeats,
              conflict_level AS conflictLevel, timeline
       FROM scene WHERE branch_id = ? ORDER BY idx`,
    )
    .all(branch.id) as SceneListItem[]).map((row) => ({ ...row }));
}

/**
 * 解析要跑的场景：显式 id > 活动指针 > 最近一个未关闭场景。
 * 全部没有时直接报错，不自动建场——场景卡是作者的决定，不是系统的。
 */
export function resolveSceneId(db: Db, requested?: string): string {
  const branch = db
    .prepare('SELECT active_branch_id AS id FROM project_state LIMIT 1')
    .get() as { id: string } | undefined;
  if (!branch) throw new UsageError('项目没有活动分支');

  if (requested) {
    const row = db
      .prepare('SELECT id FROM scene WHERE id = ? AND branch_id = ?')
      .get(requested, branch.id) as { id: string } | undefined;
    if (!row) throw new UsageError(`场景不存在或不属于当前分支：${requested}`);
    return row.id;
  }

  const pointer = db
    .prepare('SELECT active_scene_id FROM project_state LIMIT 1')
    .get() as { active_scene_id: string | null } | undefined;
  if (pointer?.active_scene_id) {
    const row = db
      .prepare("SELECT id FROM scene WHERE id = ? AND state IN ('planned','open','paused','closing')")
      .get(pointer.active_scene_id) as { id: string } | undefined;
    if (row) return row.id;
  }
  const latest = db
    .prepare(
      `SELECT id FROM scene WHERE branch_id = ? AND state IN ('planned','open','paused','closing')
       ORDER BY idx DESC LIMIT 1`,
    )
    .get(branch.id) as { id: string } | undefined;
  if (!latest) {
    throw new UsageError('没有可运行的场景：先 noryth scene create（场景卡由作者决定）');
  }
  return latest.id;
}
