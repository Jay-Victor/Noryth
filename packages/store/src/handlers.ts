/**
 * P1 命令：建场 / 开合场景 / 提交一拍 / 写关系 / 系统告警。
 *
 * 所有写入仍然只有一条路（01 §4）：CommandBus → 幂等收据 → 提案 → 事务。
 * 模型不在这里出现：CLI 把模型输出校验成提案，再由这些 handler 落库。
 */
import {
  PARAMS,
  adjustRelation,
  canonicalJson,
  estTokens,
  evalExit,
  knowledgeViolations,
  sceneSummaryText,
  settingConflictOf,
  sha256Hex,
  slotKeyOf,
  CharacterOutputSchema,
  type BeatMode,
  type Cardinality,
  type ExitExpr,
  type RelationAxis,
  type SceneState,
} from '@noryth/core';
import { z } from 'zod';
import type { Proposal, CommandHandler, CommandContext } from './commands.js';
import { UsageError, ConstraintError } from './errors.js';
import { newId } from './ids.js';
import { readClaimIndex, readKnownFactIds } from './state.js';

const RELATION_AXES = ['trust', 'affection', 'fear', 'debt', 'power'] as const;
const ATTITUDES = ['knows', 'believes', 'suspects', 'doubts', 'falsely_believes'] as const;
const PERCEPTS = ['witness', 'told', 'reported', 'inferred', 'discovered'] as const;
const MESSAGE_PERCEPTS = [
  'public',
  'whisper',
  'soliloquy',
  'narrator_reader',
  'director',
  'system',
] as const;
const BEAT_MODES = ['auto', 'user_pick', 'forced_narrator', 'user_acted', 'arbitrated'] as const;

const MAX_BEATS_DEFAULT = PARAMS['scene.max_beats'];
const MAX_BEATS_LIMIT = 400; // docs/02-schema.sql: CHECK (max_beats BETWEEN 1 AND 400)
const MAX_LEVEL = PARAMS['scene.max_level'];

export interface EntityRow {
  id: string;
  branchId: string;
  kind: string;
  name: string;
  aliases: string;
  card: string;
  status: string;
  createdSeq: number | null;
}

export interface AgentRow {
  id: string;
  branchId: string;
  roleType: string;
  name: string;
  entityId: string | null;
  model: string;
  temperature: number;
  card: string;
  permissions: string;
  enabled: 0 | 1;
}

export interface SceneRow {
  id: string;
  branchId: string;
  arcId: string | null;
  idx: number;
  title: string;
  locationId: string | null;
  storyStart: string;
  storyEnd: string | null;
  timeline: string;
  present: string;
  goal: string;
  conflictLevel: number;
  maxBeats: number;
  beats: number;
  state: SceneState;
  exitConditions: string;
  summary: string | null;
  openedSeq: number | null;
  closedSeq: number | null;
}

export interface CardRow {
  id: string;
  branchId: string;
  title: string;
  triggerJson: string;
  minLevel: number;
  weight: number;
  oneShot: 0 | 1;
  consumedSeq: number | null;
}

export interface BeatRow {
  id: string;
  branchId: string;
  sceneId: string;
  seq: number;
  agentId: string;
  score: number;
  damped: number | null;
  breakdown: string;
  mode: BeatMode;
  createdAt: string;
}

export interface CognitionRow {
  branchId: string;
  characterId: string;
  factId: string;
  attitude: string;
  certainty: number;
  learnedSeq: number;
  sourceMessageId: string | null;
  percept: string;
}

export interface RelationRow {
  branchId: string;
  fromId: string;
  toId: string;
  axis: RelationAxis;
  value: number;
  updatedSeq: number;
  reason: string | null;
}

function resolveEntity(
  ctx: CommandContext,
  ref: string,
): { id: string; name: string; kind: string } | null {
  const byId = ctx.db
    .prepare('SELECT id, name, kind FROM entity WHERE id = ? AND branch_id = ?')
    .get(ref, ctx.branchId) as { id: string; name: string; kind: string } | undefined;
  if (byId) return byId;
  const byName = ctx.db
    .prepare(
      `SELECT id, name, kind FROM entity WHERE name = ? AND branch_id = ?
       ORDER BY CASE kind WHEN 'character' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(ref, ctx.branchId) as { id: string; name: string; kind: string } | undefined;
  return byName ?? null;
}

function requireScene(ctx: CommandContext, sceneId: string): SceneRow {
  const row = ctx.db
    .prepare(
      `SELECT id, branch_id AS branchId, arc_id AS arcId, idx, title,
              location_id AS locationId, story_start AS storyStart, story_end AS storyEnd,
              timeline, present, goal, conflict_level AS conflictLevel,
              max_beats AS maxBeats, beats, state, exit_conditions AS exitConditions,
              summary, opened_seq AS openedSeq, closed_seq AS closedSeq
       FROM scene WHERE id = ? AND branch_id = ?`,
    )
    .get(sceneId, ctx.branchId) as SceneRow | undefined;
  if (!row) throw new UsageError(`场景不存在或不属于当前分支：${sceneId}`);
  return row;
}

function assertExitExpr(expr: unknown): ExitExpr {
  // 用空状态求值一遍：未知算子会抛错，形状错误也会在这里暴露。
  try {
    evalExit(expr as ExitExpr, { facts: new Map(), rels: new Map(), beats: 0 });
  } catch (error) {
    throw new UsageError(
      `exit_conditions 不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return expr as ExitExpr;
}

/**
 * 第 2 类冲突（设定冲突）：claim 落在被锁定的 fact 槽位上，且值不同。
 * 主语写 id 或名字都接受；未知主语 / 未登记谓词视为"新 claim"，不改世界状态。
 */
function claimSettingConflicts(
  ctx: CommandContext,
  asserts: readonly { subject: string; predicate: string; object: unknown }[],
): string[] {
  const locks = ctx.db
    .prepare("SELECT scope, slot_key AS slotKey FROM lock WHERE branch_id = ? AND scope = 'fact'")
    .all(ctx.branchId) as { scope: string; slotKey: string }[];
  if (locks.length === 0) return [];
  const out: string[] = [];
  for (const claim of asserts) {
    const subject = resolveEntity(ctx, claim.subject);
    if (!subject) continue;
    const spec = ctx.db
      .prepare('SELECT cardinality FROM predicate_spec WHERE predicate = ?')
      .get(claim.predicate) as { cardinality: Cardinality } | undefined;
    if (!spec) continue;
    const slotKey = slotKeyOf(subject.id, claim.predicate, claim.object, spec.cardinality);
    const active = ctx.db
      .prepare(
        'SELECT object_json AS objectJson FROM fact WHERE branch_id = ? AND slot_key = ? AND valid_to IS NULL',
      )
      .get(ctx.branchId, slotKey) as { objectJson: string } | undefined;
    const conflict = settingConflictOf(
      claim,
      subject.id,
      spec.cardinality,
      active?.objectJson ?? null,
      locks,
    );
    if (conflict) out.push(conflict.message);
  }
  return out;
}

const CastInput = z.strictObject({
  name: z.string().trim().min(1),
  goalRel: z.number().min(0).max(1).default(0.5),
  initiative: z.number().min(0).max(1).default(0.5),
  secretThreat: z.boolean().default(false),
  ownership: z.number().min(0).max(1).default(0),
  identity: z.string().default(''),
  personality: z.string().default(''),
  speechStyle: z.string().default(''),
  values: z.string().default(''),
  want: z.string().default(''),
  model: z.string().default('offline'),
  temperature: z.number().min(0).max(2).default(0.8),
});

const CardInput = z.strictObject({
  title: z.string().trim().min(1),
  trigger: z.unknown().optional(),
  minLevel: z.number().int().min(0).max(MAX_LEVEL).default(0),
  weight: z.number().positive().default(1),
  oneShot: z.boolean().default(false),
});

const SceneCreatePayload = z.strictObject({
  title: z.string().trim().min(1),
  cast: z.array(CastInput).default([]),
  present: z.array(z.string().min(1)).min(1),
  location: z.string().min(1).optional(),
  storyStart: z.string().trim().min(1),
  timeline: z.string().trim().min(1).default('main'),
  idx: z.number().int().min(0).optional(),
  goal: z.union([z.string(), z.record(z.string(), z.unknown())]),
  situation: z.string().default(''),
  conflictLevel: z.number().min(0).max(MAX_LEVEL).default(1),
  maxBeats: z.number().int().min(1).max(MAX_BEATS_LIMIT).default(MAX_BEATS_DEFAULT),
  exitConditions: z.unknown(),
  cards: z.array(CardInput).default([]),
});

export type SceneCreateInput = z.input<typeof SceneCreatePayload>;

export interface SceneCreateResult {
  sceneId: string;
  idx: number;
  present: string[];
  cast: { entityId: string; name: string }[];
  narratorAgentId: string;
  cards: string[];
}

/** 建场：一次性写入角色、旁白、场景与事件卡；四者同一事件、同一事务。 */
export const sceneCreateHandler: CommandHandler = {
  kind: 'scene.create',
  propose(raw, ctx): Proposal<SceneCreateResult> {
    const payload = SceneCreatePayload.parse(raw);
    const exitConditions = assertExitExpr(payload.exitConditions);
    const { db, branchId, headSeq } = ctx;

    if (payload.present.length > PARAMS['scheduler.max_candidates']) {
      throw new UsageError(`在场者超过 ${PARAMS['scheduler.max_candidates']} 个：评分上限`);
    }

    const entities: EntityRow[] = [];
    const agents: AgentRow[] = [];
    const castResult: { entityId: string; name: string }[] = [];

    const seen = new Set<string>();
    for (const member of payload.cast) {
      if (seen.has(member.name)) throw new UsageError(`cast 名字重复：${member.name}`);
      seen.add(member.name);
      const existing = db
        .prepare("SELECT id FROM entity WHERE branch_id = ? AND kind = 'character' AND name = ?")
        .get(branchId, member.name) as { id: string } | undefined;
      if (existing) {
        // 复用已有角色：同一角色可以出现在多场戏里。
        castResult.push({ entityId: existing.id, name: member.name });
        const agent = db
          .prepare("SELECT id FROM agent_config WHERE branch_id = ? AND entity_id = ?")
          .get(branchId, existing.id);
        if (!agent) {
          agents.push({
            id: newId('a'),
            branchId,
            roleType: 'character',
            name: member.name,
            entityId: existing.id,
            model: member.model,
            temperature: member.temperature,
            card: canonicalJson({}),
            permissions: canonicalJson({
              goalRel: member.goalRel,
              initiative: member.initiative,
              secretThreat: member.secretThreat,
              ownership: member.ownership,
            }),
            enabled: 1,
          });
        }
        continue;
      }
      const entityId = newId('e');
      const card = {
        identity: member.identity,
        personality: member.personality,
        speech_style: member.speechStyle,
        values: member.values,
        want: member.want,
      };
      entities.push({
        id: entityId,
        branchId,
        kind: 'character',
        name: member.name,
        aliases: '[]',
        card: canonicalJson(card),
        status: 'active',
        createdSeq: headSeq,
      });
      const agentId = newId('a');
      agents.push({
        id: agentId,
        branchId,
        roleType: 'character',
        name: member.name,
        entityId,
        model: member.model,
        temperature: member.temperature,
        card: canonicalJson(card),
        permissions: canonicalJson({
          goalRel: member.goalRel,
          initiative: member.initiative,
          secretThreat: member.secretThreat,
          ownership: member.ownership,
        }),
        enabled: 1,
      });
      castResult.push({ entityId, name: member.name });
    }

    // 旁白：整个分支一个，entity_id 为空。3 角色 + 1 旁白是 P1 的最小剧场。
    const existingNarrator = db
      .prepare("SELECT id FROM agent_config WHERE branch_id = ? AND role_type = 'narrator' LIMIT 1")
      .get(branchId) as { id: string } | undefined;
    const narratorId = existingNarrator?.id ?? newId('a');
    if (!existingNarrator) {
      agents.push({
        id: narratorId,
        branchId,
        roleType: 'narrator',
        name: '旁白',
        entityId: null,
        model: 'offline',
        temperature: 0.8,
        card: canonicalJson({ want: '让读者看见这一拍' }),
        permissions: canonicalJson({}),
        enabled: 1,
      });
    }

    const presentIds: string[] = [];
    for (const ref of payload.present) {
      const direct = entities.find((e) => e.name === ref);
      if (direct) {
        presentIds.push(direct.id);
        continue;
      }
      const existing = resolveEntity(ctx, ref);
      if (!existing) throw new UsageError(`在场者不是本分支实体：${ref}`);
      if (existing.kind !== 'character') throw new UsageError(`在场者必须是角色：${ref}`);
      presentIds.push(existing.id);
    }
    if (new Set(presentIds).size !== presentIds.length) {
      throw new UsageError('present 有重复实体');
    }

    let locationId: string | null = null;
    if (payload.location) {
      const loc = resolveEntity(ctx, payload.location);
      if (!loc) throw new UsageError(`地点不是本分支实体：${payload.location}`);
      locationId = loc.id;
    }

    const idxRow = db
      .prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM scene WHERE branch_id = ?')
      .get(branchId) as { idx: number };
    const idx = payload.idx ?? idxRow.idx;
    if (
      db.prepare('SELECT 1 FROM scene WHERE branch_id = ? AND idx = ?').get(branchId, idx)
    ) {
      throw new UsageError(`场景 idx 已存在：${idx}`);
    }

    const sceneId = newId('s');
    // goal_rel / initiative / secret 是**场景级**的（场景开启时写死），
    // 但没有 scene_cast 表；存在 goal JSON 的 cast 字段里，不改 schema。
    const castWeights: Record<string, Record<string, unknown>> = {};
    for (const member of payload.cast) {
      const created = castResult.find((entry) => entry.name === member.name);
      if (!created) continue;
      castWeights[created.entityId] = {
        goalRel: member.goalRel,
        initiative: member.initiative,
        secretThreat: member.secretThreat,
        ownership: member.ownership,
      };
    }
    const baseGoal = typeof payload.goal === 'string' ? { text: payload.goal } : payload.goal;
    const goalJson = canonicalJson({ ...baseGoal, cast: castWeights });
    const situation = payload.situation.trim();
    const scene: SceneRow = {
      id: sceneId,
      branchId,
      arcId: null,
      idx,
      title: payload.title,
      locationId,
      storyStart: payload.storyStart,
      storyEnd: null,
      timeline: payload.timeline,
      present: canonicalJson(presentIds),
      goal: goalJson,
      conflictLevel: payload.conflictLevel,
      maxBeats: payload.maxBeats,
      beats: 0,
      state: 'planned',
      exitConditions: canonicalJson(exitConditions),
      summary: situation.length > 0 ? situation : null,
      openedSeq: null,
      closedSeq: null,
    };

    const cards: CardRow[] = payload.cards.map((card) => ({
      id: newId('ec'),
      branchId,
      title: card.title,
      triggerJson: canonicalJson(card.trigger ?? null),
      minLevel: card.minLevel,
      weight: card.weight,
      oneShot: card.oneShot ? 1 : 0,
      consumedSeq: null,
    }));

    return {
      eventKind: 'scene.created',
      eventPayload: { entities, agents, scene, cards },
      apply(): SceneCreateResult {
        const insertEntity = db.prepare(
          `INSERT INTO entity(id, branch_id, kind, name, aliases, card, status, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const entity of entities) {
          insertEntity.run(
            entity.id,
            entity.branchId,
            entity.kind,
            entity.name,
            entity.aliases,
            entity.card,
            entity.status,
            entity.createdSeq,
          );
        }
        const insertAgent = db.prepare(
          `INSERT INTO agent_config(id, branch_id, role_type, name, entity_id, model,
             temperature, card, permissions, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const agent of agents) {
          insertAgent.run(
            agent.id,
            agent.branchId,
            agent.roleType,
            agent.name,
            agent.entityId,
            agent.model,
            agent.temperature,
            agent.card,
            agent.permissions,
            agent.enabled,
          );
        }
        db.prepare(
          `INSERT INTO scene(id, branch_id, arc_id, idx, title, location_id, story_start,
             story_end, timeline, present, goal, conflict_level, max_beats, beats, state,
             exit_conditions, summary, opened_seq, closed_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          scene.id,
          scene.branchId,
          scene.arcId,
          scene.idx,
          scene.title,
          scene.locationId,
          scene.storyStart,
          scene.storyEnd,
          scene.timeline,
          scene.present,
          scene.goal,
          scene.conflictLevel,
          scene.maxBeats,
          scene.beats,
          scene.state,
          scene.exitConditions,
          scene.summary,
          scene.openedSeq,
          scene.closedSeq,
        );
        const insertCard = db.prepare(
          `INSERT INTO event_card(id, branch_id, title, trigger_json, min_level, weight, one_shot, consumed_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const card of cards) {
          insertCard.run(
            card.id,
            card.branchId,
            card.title,
            card.triggerJson,
            card.minLevel,
            card.weight,
            card.oneShot,
            card.consumedSeq,
          );
        }
        return {
          sceneId,
          idx,
          present: presentIds,
          cast: castResult,
          narratorAgentId: narratorId,
          cards: cards.map((c) => c.id),
        };
      },
    };
  },
};

const SceneStatePayload = z.strictObject({
  sceneId: z.string().min(1),
  to: z.enum(['planned', 'open', 'paused', 'closing', 'closed', 'abandoned']),
  reason: z.string().default(''),
});

const ALLOWED: Record<SceneState, readonly SceneState[]> = {
  planned: ['open', 'abandoned'],
  open: ['paused', 'closing', 'closed', 'abandoned'],
  paused: ['open', 'closed', 'abandoned'],
  closing: ['closed', 'open'],
  closed: ['open'],
  abandoned: [],
};

export interface SceneStateResult {
  sceneId: string;
  from: SceneState;
  to: SceneState;
  openedSeq: number | null;
  closedSeq: number | null;
  summaryNodeId: string | null;
}

interface SummaryNodeRow {
  id: string;
  branchId: string;
  kind: 'event' | 'summary';
  text: string;
  importance: number;
  stability: number;
  conf: number;
  validFrom: string;
  pinned: 0 | 1;
  hard: 0 | 1;
  sensitivity: number;
  slotKey: string | null;
  sourceSeq: number | null;
}

interface SceneCloseMemory {
  children: SummaryNodeRow[];
  summary: SummaryNodeRow;
  edges: { src: string; dst: string; kind: 'DERIVED_FROM'; weight: number }[];
  downweight: { id: string; importance: number }[];
}

/**
 * 场景关闭时的记忆落点（03 §6）：每拍一条 event 节点，一个 summary 节点，
 * DERIVED_FROM 指向被压缩的拍；原文只降权、不删除（触发器守删除）。
 * 摘要走确定性抽取，回退能复演；模型润色留给 P3 的 summarize 作业。
 */
function buildSceneCloseMemory(
  ctx: CommandContext,
  scene: SceneRow,
  sourceSeq: number,
): SceneCloseMemory | null {
  const slotKey = `scene:${scene.id}`;
  const exists = ctx.db
    .prepare(
      "SELECT 1 FROM memory_node WHERE branch_id = ? AND kind = 'summary' AND slot_key = ?",
    )
    .get(ctx.branchId, slotKey);
  if (exists) return null;

  const rows = ctx.db
    .prepare(
      `SELECT seq, agent_id AS agentId, role_type AS roleType, prose, created_at AS createdAt
       FROM message WHERE scene_id = ? AND role_type IN ('character','narrator')
       ORDER BY seq`,
    )
    .all(scene.id) as { seq: number; agentId: string; roleType: string; prose: string; createdAt: string }[];
  const body = rows.filter((row) => row.prose.trim().length > 0);
  if (body.length === 0) return null;

  const speakerOf = (agentId: string, roleType: string): string => {
    if (roleType === 'narrator') return '旁白';
    const entity = ctx.db.prepare('SELECT name FROM entity WHERE id = ?').get(agentId) as
      | { name: string }
      | undefined;
    return entity?.name ?? agentId;
  };
  const text = sceneSummaryText({
    title: scene.title,
    goal: (() => {
      try {
        const goal = JSON.parse(scene.goal) as { text?: unknown };
        return typeof goal.text === 'string' ? goal.text : '';
      } catch {
        return '';
      }
    })(),
    beats: body.map((row) => ({
      seq: row.seq,
      roleType: row.roleType,
      speaker: speakerOf(row.agentId, row.roleType),
      prose: row.prose,
    })),
  });
  if (text.length === 0) return null;

  const children: SummaryNodeRow[] = body.map((row) => ({
    id: newId('mn'),
    branchId: ctx.branchId,
    kind: 'event',
    text: row.prose,
    importance: 0.8,
    stability: 21,
    conf: 1,
    validFrom: row.createdAt,
    pinned: 0,
    hard: 0,
    sensitivity: 0,
    slotKey: null,
    sourceSeq: row.seq,
  }));
  const summary: SummaryNodeRow = {
    id: newId('mn'),
    branchId: ctx.branchId,
    kind: 'summary',
    text,
    importance: 1.5,
    stability: 180,
    conf: 1,
    validFrom: ctx.now,
    pinned: 0,
    hard: 0,
    sensitivity: 1,
    slotKey,
    sourceSeq,
  };
  return {
    children,
    summary,
    // DERIVED_FROM 的方向：child → summary（"这条记忆派生自那次压缩"）。
    // 触发器 ck_memory_has_children 保护 dst，也就是保护摘要节点不被删。
    edges: children.map((child) => ({
      src: child.id,
      dst: summary.id,
      kind: 'DERIVED_FROM' as const,
      weight: 1,
    })),
    downweight: children.map((child) => ({
      id: child.id,
      importance: Math.max(0.05, Number((child.importance * 0.5).toFixed(3))),
    })),
  };
}

function applySceneCloseMemory(ctx: CommandContext, sceneId: string, memory: SceneCloseMemory): void {
  const insert = ctx.db.prepare(
    `INSERT INTO memory_node(id, branch_id, kind, text, importance, stability, conf,
       valid_from, last_access, access_count, pinned, hard, sensitivity, owner_id,
       slot_key, source_seq, resolved_seq, embedding, embedding_model, embedding_dim)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
  );
  for (const row of memory.children) {
    insert.run(
      row.id,
      row.branchId,
      row.kind,
      row.text,
      row.importance,
      row.stability,
      row.conf,
      row.validFrom,
      row.pinned,
      row.hard,
      row.sensitivity,
      row.slotKey,
      row.sourceSeq,
    );
  }
  const summary = memory.summary;
  insert.run(
    summary.id,
    summary.branchId,
    summary.kind,
    summary.text,
    summary.importance,
    summary.stability,
    summary.conf,
    summary.validFrom,
    summary.pinned,
    summary.hard,
    summary.sensitivity,
    summary.slotKey,
    summary.sourceSeq,
  );
  const link = ctx.db.prepare(
    'INSERT INTO memory_edge(src, dst, kind, weight) VALUES (?, ?, ?, ?)',
  );
  for (const edge of memory.edges) link.run(edge.src, edge.dst, edge.kind, edge.weight);
  const weight = ctx.db.prepare('UPDATE memory_node SET importance = ? WHERE id = ?');
  for (const row of memory.downweight) weight.run(row.importance, row.id);
  ctx.db.prepare('UPDATE scene SET summary = ? WHERE id = ?').run(summary.text, sceneId);
}

export const sceneStateHandler: CommandHandler = {
  kind: 'scene.state',
  propose(raw, ctx): Proposal<SceneStateResult> {
    const payload = SceneStatePayload.parse(raw);
    const scene = requireScene(ctx, payload.sceneId);
    if (scene.state === payload.to) {
      throw new UsageError(`场景已经是 ${payload.to} 状态`);
    }
    if (!ALLOWED[scene.state].includes(payload.to)) {
      throw new UsageError(`场景状态不能从 ${scene.state} 变为 ${payload.to}`);
    }
    const openedSeq = payload.to === 'open' ? ctx.headSeq : scene.openedSeq;
    const closedSeq = payload.to === 'closed' || payload.to === 'abandoned'
      ? ctx.headSeq
      : null;
    const memory =
      payload.to === 'closed'
        ? buildSceneCloseMemory(ctx, scene, closedSeq ?? ctx.headSeq)
        : null;
    return {
      eventKind: 'scene.state.changed',
      eventPayload: {
        sceneId: scene.id,
        from: scene.state,
        to: payload.to,
        openedSeq,
        closedSeq,
        reason: payload.reason,
        memory,
      },
      apply(): SceneStateResult {
        ctx.db
          .prepare('UPDATE scene SET state = ?, opened_seq = ?, closed_seq = ? WHERE id = ?')
          .run(payload.to, openedSeq, closedSeq, scene.id);
        if (payload.to === 'open') {
          ctx.db
            .prepare('UPDATE project_state SET active_scene_id = ? WHERE project_id = ?')
            .run(scene.id, ctx.projectId);
        } else if (
          (payload.to === 'closed' || payload.to === 'abandoned') &&
          (
            ctx.db
              .prepare('SELECT active_scene_id FROM project_state WHERE project_id = ?')
              .get(ctx.projectId) as { active_scene_id: string | null } | undefined
          )?.active_scene_id === scene.id
        ) {
          ctx.db
            .prepare('UPDATE project_state SET active_scene_id = NULL WHERE project_id = ?')
            .run(ctx.projectId);
        }
        if (memory) applySceneCloseMemory(ctx, scene.id, memory);
        return {
          sceneId: scene.id,
          from: scene.state,
          to: payload.to,
          openedSeq,
          closedSeq,
          summaryNodeId: memory?.summary.id ?? null,
        };
      },
    };
  },
};

const CognitionInput = z.strictObject({
  characterId: z.string().min(1),
  factId: z.string().min(1),
  attitude: z.enum(ATTITUDES).default('knows'),
  certainty: z.number().min(0).max(1).default(1),
  percept: z.enum(PERCEPTS).default('witness'),
});

const RelationInput = z.strictObject({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  axis: z.enum(RELATION_AXES),
  value: z.number().min(-1).max(1),
  reason: z.string().default(''),
});

const BeatCommitPayload = z.strictObject({
  sceneId: z.string().min(1),
  agentId: z.string().min(1),
  roleType: z.enum(['character', 'narrator']),
  mode: z.enum(BEAT_MODES),
  score: z.number(),
  damped: z.number(),
  breakdown: z.record(z.string(), z.unknown()).default({}),
  prose: z.string(),
  structured: z.record(z.string(), z.unknown()).default({}),
  percept: z.enum(MESSAGE_PERCEPTS),
  audience: z.array(z.string().min(1)).default([]),
  cognition: z.array(CognitionInput).default([]),
  relations: z.array(RelationInput).default([]),
  conflictLevel: z.number().min(0).max(MAX_LEVEL),
  cardId: z.string().min(1).optional(),
  tokenEst: z.number().int().min(0).optional(),
});

export type BeatCommitInput = z.input<typeof BeatCommitPayload>;

export interface BeatCommitResult {
  beatId: string;
  messageId: string;
  beatSeq: number;
  messageSeq: number;
  relationJumps: { axis: RelationAxis; from: number; to: number; clamped: boolean }[];
}

export const beatCommitHandler: CommandHandler = {
  kind: 'beat.commit',
  propose(raw, ctx): Proposal<BeatCommitResult> {
    const payload = BeatCommitPayload.parse(raw);
    const scene = requireScene(ctx, payload.sceneId);
    const { db, branchId, headSeq, now } = ctx;

    if (scene.state !== 'open') {
      throw new UsageError(`场景状态 ${scene.state} 不能提交拍：收束旁白走 message.append`);
    }
    const beatSeq = scene.beats + 1;
    if (beatSeq > scene.maxBeats) {
      throw new UsageError(
        `场景已到 max_beats=${scene.maxBeats}：必须先写 WARN 并关闭，不允许静默超拍`,
      );
    }

    let agentName: string;
    if (payload.roleType === 'narrator') {
      if (payload.agentId !== 'narrator') throw new UsageError('旁白的 agentId 必须是 narrator');
      if (payload.audience.length > 0) throw new UsageError('旁白不得有受众');
      if (payload.percept !== 'narrator_reader') {
        throw new UsageError('旁白的 percept 必须是 narrator_reader');
      }
      agentName = '旁白';
    } else {
      const entity = db
        .prepare("SELECT id, name, kind FROM entity WHERE id = ? AND branch_id = ?")
        .get(payload.agentId, branchId) as { id: string; name: string; kind: string } | undefined;
      if (!entity) throw new UsageError(`发言角色不是本分支实体：${payload.agentId}`);
      if (entity.kind !== 'character') throw new UsageError('只有角色实体可以发言');
      const present = JSON.parse(scene.present) as string[];
      if (!present.includes(entity.id)) {
        throw new UsageError(`发言角色不在场：${entity.name}`);
      }
      agentName = entity.name;
      if (payload.percept === 'narrator_reader') {
        throw new UsageError('角色不能使用 narrator_reader');
      }
    }
    if (
      payload.percept === 'soliloquy' &&
      typeof payload.structured.thought !== 'string'
    ) {
      throw new UsageError('soliloquy 必须在 structured.thought 里给出心理活动');
    }
    if (payload.percept === 'whisper' && payload.audience.length < 1) {
      throw new UsageError('耳语必须有受众');
    }
    if (
      (payload.percept === 'soliloquy' || payload.percept === 'narrator_reader') &&
      payload.audience.length !== 0
    ) {
      throw new UsageError('心理独白 / 旁白不得有受众');
    }

    const hasLine = typeof payload.structured.line === 'string';
    if (payload.prose.length === 0 && !hasLine) {
      throw new UsageError('空消息：prose 与 structured.line 至少有一个');
    }
    for (const audienceId of payload.audience) {
      const entity = db
        .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
        .get(audienceId, branchId);
      if (!entity) throw new UsageError(`受众不是本分支实体：${audienceId}`);
    }

    // 03 §8 第 1/2 类冲突在提交前判定：结构化断言越权、设定冲突都阻断。
    if (payload.roleType === 'character') {
      const parsed = CharacterOutputSchema.safeParse(payload.structured);
      if (!parsed.success) {
        throw new UsageError(
          `角色 structured 不符合输出契约：${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const known = readKnownFactIds(db, branchId, payload.agentId);
      const claims = readClaimIndex(db, branchId);
      const violations = knowledgeViolations(parsed.data, known, claims);
      if (violations.length > 0) {
        throw new ConstraintError(
          `结构化断言越权：${violations.map((v) => v.detail).join('；')}`,
          'ck_knowledge_violation',
        );
      }
      for (const factId of parsed.data.reveals) {
        const active = db
          .prepare('SELECT 1 FROM fact WHERE id = ? AND branch_id = ? AND valid_to IS NULL')
          .get(factId, branchId);
        if (!active) {
          throw new ConstraintError(
            `reveals 了已失效或不存在的事实 ${factId}：陈旧值不得再被引用`,
            'ck_stale_fact_reveal',
          );
        }
      }
      const conflicts = claimSettingConflicts(ctx, parsed.data.asserts);
      if (conflicts.length > 0) {
        throw new ConstraintError(conflicts.join('；'), 'ck_setting_conflict');
      }
    }

    const cognitionRows: CognitionRow[] = [];
    for (const row of payload.cognition) {
      const fact = db
        .prepare('SELECT id FROM fact WHERE id = ? AND branch_id = ? AND valid_to IS NULL')
        .get(row.factId, branchId);
      if (!fact) throw new UsageError(`认知引用了无效事实：${row.factId}`);
      const character = db
        .prepare("SELECT id FROM entity WHERE id = ? AND branch_id = ? AND kind = 'character'")
        .get(row.characterId, branchId);
      if (!character) throw new UsageError(`认知引用了无效角色：${row.characterId}`);
      if (row.characterId !== payload.agentId && !payload.audience.includes(row.characterId)) {
        throw new UsageError(
          `认知主体不在本条消息的受众里：${row.characterId}（同场 ≠ 可感知）`,
        );
      }
      cognitionRows.push({
        branchId,
        characterId: row.characterId,
        factId: row.factId,
        attitude: row.attitude,
        certainty: row.certainty,
        learnedSeq: headSeq,
        sourceMessageId: null,
        percept: row.percept,
      });
    }

    const relationRows: RelationRow[] = [];
    const relationJumps: BeatCommitResult['relationJumps'] = [];
    for (const row of payload.relations) {
      if (row.fromId === row.toId) throw new UsageError('关系两端不能是同一实体');
      const from = db
        .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
        .get(row.fromId, branchId);
      const to = db
        .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
        .get(row.toId, branchId);
      if (!from || !to) throw new UsageError('关系两端必须是本分支实体');
      const previous = db
        .prepare(
          `SELECT value FROM relation WHERE branch_id = ? AND from_id = ? AND to_id = ? AND axis = ?`,
        )
        .get(branchId, row.fromId, row.toId, row.axis) as { value: number } | undefined;
      const oldValue = previous?.value ?? 0;
      const adjustment = adjustRelation({
        oldValue,
        requested: row.value,
        reason: row.reason,
      });
      if (adjustment.jumped) {
        relationJumps.push({
          axis: row.axis,
          from: oldValue,
          to: adjustment.value,
          clamped: adjustment.clamped,
        });
      }
      relationRows.push({
        branchId,
        fromId: row.fromId,
        toId: row.toId,
        axis: row.axis,
        value: adjustment.value,
        updatedSeq: headSeq,
        reason: adjustment.reason,
      });
    }

    if (payload.cardId) {
      const card = db
        .prepare('SELECT id FROM event_card WHERE id = ? AND branch_id = ?')
        .get(payload.cardId, branchId);
      if (!card) throw new UsageError(`事件卡不存在：${payload.cardId}`);
    }

    const structuredJson = canonicalJson(payload.structured);
    const contentHash = sha256Hex(`${payload.prose}\u0000${structuredJson}`);
    const tokenEst = payload.tokenEst ?? estTokens(payload.prose);
    const messageId = newId('m');
    const beatId = newId('b');
    const breakdown = {
      ...payload.breakdown,
      eventSeq: headSeq,
      conflict: payload.conflictLevel,
      speakerName: agentName,
      relationJumps,
    };
    const beat: BeatRow = {
      id: beatId,
      branchId,
      sceneId: scene.id,
      seq: beatSeq,
      agentId: payload.agentId,
      score: payload.score,
      damped: payload.damped,
      breakdown: canonicalJson(breakdown),
      mode: payload.mode,
      createdAt: now,
    };
    const message = {
      id: messageId,
      branchId,
      seq: headSeq,
      sceneId: scene.id,
      beatId,
      agentId: payload.agentId,
      roleType: payload.roleType,
      prose: payload.prose,
      structured: structuredJson,
      audience: canonicalJson(payload.audience),
      percept: payload.percept,
      contentHash,
      tokenEst,
      createdAt: now,
      supersedesId: null,
    };

    return {
      eventKind: 'beat.committed',
      eventPayload: {
        beat,
        message,
        cognition: cognitionRows,
        relations: relationRows,
        sceneUpdate: { beats: beatSeq, conflictLevel: payload.conflictLevel },
        card: payload.cardId ? { id: payload.cardId, consumedSeq: payload.cardId ? headSeq : null } : null,
      },
      apply(): BeatCommitResult {
        db.prepare(
          `INSERT INTO beat(id, branch_id, scene_id, seq, agent_id, score, damped, breakdown,
             mode, stale, stale_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        ).run(
          beat.id,
          beat.branchId,
          beat.sceneId,
          beat.seq,
          beat.agentId,
          beat.score,
          beat.damped,
          beat.breakdown,
          beat.mode,
          beat.createdAt,
        );
        db.prepare(
          `INSERT INTO message(id, branch_id, seq, scene_id, beat_id, agent_id, role_type,
             prose, structured, audience, percept, content_hash, token_est, created_at, supersedes_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          message.id,
          message.branchId,
          message.seq,
          message.sceneId,
          message.beatId,
          message.agentId,
          message.roleType,
          message.prose,
          message.structured,
          message.audience,
          message.percept,
          message.contentHash,
          message.tokenEst,
          message.createdAt,
          message.supersedesId,
        );
        const insertCognition = db.prepare(
          `INSERT OR IGNORE INTO cognition(branch_id, character_id, fact_id, attitude,
             certainty, learned_seq, source_message_id, percept)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of cognitionRows) {
          insertCognition.run(
            row.branchId,
            row.characterId,
            row.factId,
            row.attitude,
            row.certainty,
            row.learnedSeq,
            messageId,
            row.percept,
          );
        }
        const upsertRelation = db.prepare(
          `INSERT INTO relation(branch_id, from_id, to_id, axis, value, updated_seq, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(branch_id, from_id, to_id, axis)
           DO UPDATE SET value = excluded.value, updated_seq = excluded.updated_seq,
                         reason = excluded.reason`,
        );
        for (const row of relationRows) {
          upsertRelation.run(
            row.branchId,
            row.fromId,
            row.toId,
            row.axis,
            row.value,
            row.updatedSeq,
            row.reason,
          );
        }
        db.prepare('UPDATE scene SET beats = ?, conflict_level = ? WHERE id = ?').run(
          beatSeq,
          payload.conflictLevel,
          scene.id,
        );
        if (payload.cardId) {
          db.prepare('UPDATE event_card SET consumed_seq = ? WHERE id = ? AND one_shot = 1').run(
            headSeq,
            payload.cardId,
          );
        }
        return { beatId, messageId, beatSeq, messageSeq: headSeq, relationJumps };
      },
    };
  },
};

const RelationSetPayload = z.strictObject({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  axis: z.enum(RELATION_AXES),
  value: z.number().min(-1).max(1),
  reason: z.string().default(''),
});

export interface RelationSetResult {
  fromId: string;
  toId: string;
  axis: RelationAxis;
  value: number;
  previous: number;
  clamped: boolean;
}

export const relationSetHandler: CommandHandler = {
  kind: 'relation.set',
  propose(raw, ctx): Proposal<RelationSetResult> {
    const payload = RelationSetPayload.parse(raw);
    if (payload.fromId === payload.toId) throw new UsageError('关系两端不能是同一实体');
    const { db, branchId, headSeq } = ctx;
    const from = db
      .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
      .get(payload.fromId, branchId);
    const to = db
      .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
      .get(payload.toId, branchId);
    if (!from || !to) throw new UsageError('关系两端必须是本分支实体');
    const previous = db
      .prepare('SELECT value FROM relation WHERE branch_id = ? AND from_id = ? AND to_id = ? AND axis = ?')
      .get(branchId, payload.fromId, payload.toId, payload.axis) as { value: number } | undefined;
    const oldValue = previous?.value ?? 0;
    const adjustment = adjustRelation({
      oldValue,
      requested: payload.value,
      reason: payload.reason,
    });
    const row: RelationRow = {
      branchId,
      fromId: payload.fromId,
      toId: payload.toId,
      axis: payload.axis,
      value: adjustment.value,
      updatedSeq: headSeq,
      reason: adjustment.reason,
    };
    return {
      eventKind: 'relation.set',
      eventPayload: { relation: row, previous: oldValue, clamped: adjustment.clamped },
      apply(): RelationSetResult {
        db.prepare(
          `INSERT INTO relation(branch_id, from_id, to_id, axis, value, updated_seq, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(branch_id, from_id, to_id, axis)
           DO UPDATE SET value = excluded.value, updated_seq = excluded.updated_seq,
                         reason = excluded.reason`,
        ).run(
          row.branchId,
          row.fromId,
          row.toId,
          row.axis,
          row.value,
          row.updatedSeq,
          row.reason,
        );
        return {
          fromId: row.fromId,
          toId: row.toId,
          axis: row.axis,
          value: row.value,
          previous: oldValue,
          clamped: adjustment.clamped,
        };
      },
    };
  },
};

const WarnPayload = z.strictObject({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  sceneId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export interface WarnResult {
  code: string;
  sceneId: string | null;
}

export const warnHandler: CommandHandler = {
  kind: 'system.warn',
  propose(raw, ctx): Proposal<WarnResult> {
    const payload = WarnPayload.parse(raw);
    if (payload.sceneId) requireScene(ctx, payload.sceneId);
    return {
      eventKind: 'system.warned',
      eventPayload: {
        code: payload.code,
        message: payload.message,
        sceneId: payload.sceneId ?? null,
        details: payload.details,
      },
      apply(): WarnResult {
        return { code: payload.code, sceneId: payload.sceneId ?? null };
      },
    };
  },
};

export const P1_HANDLERS: readonly CommandHandler[] = [
  sceneCreateHandler,
  sceneStateHandler,
  beatCommitHandler,
  relationSetHandler,
  warnHandler,
];
