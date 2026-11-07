/**
 * P2 命令：事实 / 认知 / 设定锁 / 记忆节点 / 后台任务。
 *
 * 与 P1 一样，模型没有写权限：这里接收的已经是校验过的提案。
 * 每条写入都走 CommandBus（幂等收据 + 事件 + 同事务投影），
 * 事件 payload 带完整行，保证回退重放不依赖当前投影。
 */
import {
  PARAMS,
  canonicalJson,
  encodeVector,
  planFactAssert,
  prepareVector,
  slotKeyOf,
  type ActiveFactState,
  type Cardinality,
  type FactPlan,
  type JobKind,
  type JobStatus,
  type LockScope,
  type MemoryEdgeKind,
  type MemoryKind,
  type Truth,
} from '@noryth/core';
import { z } from 'zod';
import type { CommandContext, CommandHandler, Proposal } from './commands.js';
import { ConstraintError, UsageError } from './errors.js';
import { newId } from './ids.js';
import { resolveEntity } from './refs.js';

const VECTOR_DIM = PARAMS['memory.vector_dim'];
const RELATION_AXES = ['trust', 'affection', 'fear', 'debt', 'power'] as const;
const LOCK_SCOPES = ['fact', 'relation', 'entity', 'world', 'timeline'] as const;
const MEMORY_KINDS = [
  'event',
  'summary',
  'fact',
  'preference',
  'relationship',
  'clue',
  'world',
] as const;
const MEMORY_EDGE_KINDS = ['CAUSES', 'SUPERSEDES', 'DERIVED_FROM', 'SIMILAR', 'CO_OCCURS'] as const;
const JOB_KINDS = ['summarize', 'embed', 'extract', 'index'] as const;
const JOB_FINISH = ['done', 'failed', 'discarded'] as const;

interface PredicateRow {
  predicate: string;
  cardinality: Cardinality;
}

function requirePredicate(ctx: CommandContext, predicate: string): PredicateRow {
  const row = ctx.db
    .prepare('SELECT predicate, cardinality FROM predicate_spec WHERE predicate = ?')
    .get(predicate) as PredicateRow | undefined;
  if (!row) {
    throw new UsageError(
      `谓词「${predicate}」不在 predicate_spec 中：P2 只支持 schema 内置谓词（docs/02-schema.sql §predicate_spec）`,
    );
  }
  return row;
}

function activeFactsInSlot(
  ctx: CommandContext,
  slotKey: string,
): (ActiveFactState & { ownerId: string })[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, subject_id AS ownerId, slot_key AS slotKey, object_json AS objectJson,
              truth, secrecy, valid_from AS validFrom
       FROM fact WHERE branch_id = ? AND slot_key = ? AND valid_to IS NULL`,
    )
    .all(ctx.branchId, slotKey) as (ActiveFactState & { ownerId: string })[];
  return rows.map((row) => ({ ...row, truth: Number(row.truth) as Truth }));
}

function isLocked(ctx: CommandContext, scope: LockScope, slotKey: string): boolean {
  return Boolean(
    ctx.db
      .prepare('SELECT 1 FROM lock WHERE branch_id = ? AND scope = ? AND slot_key = ?')
      .get(ctx.branchId, scope, slotKey),
  );
}

function factError(plan: Extract<FactPlan, { ok: false }>): never {
  const constraint =
    plan.code === 'fact_locked'
      ? 'ck_fact_locked'
      : plan.code === 'time_conflict'
        ? 'ck_fact_time'
        : 'ck_fact_object';
  throw new ConstraintError(plan.message, constraint);
}

// ── fact.assert ────────────────────────────────────────────────────────────

const FactAssertPayload = z.strictObject({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown().refine((value) => value !== undefined, 'fact.assert 需要 object'),
  truth: z.union([z.literal(-1), z.literal(0), z.literal(1)]).default(1),
  secrecy: z.number().int().min(0).max(3).default(0),
  validFrom: z.string().min(1).optional(),
  sourceSeq: z.number().int().min(0).optional(),
});

export type FactAssertInput = z.input<typeof FactAssertPayload>;

export interface FactAssertResult {
  factId: string;
  slotKey: string;
  action: 'insert' | 'same' | 'supersede';
  supersededId: string | null;
  truth: Truth;
}

export interface FactRow {
  id: string;
  branchId: string;
  subjectId: string;
  predicate: string;
  objectJson: string;
  card: Cardinality;
  truth: Truth;
  secrecy: number;
  validFrom: string;
  validTo: string | null;
  sourceSeq: number | null;
  createdAt: string;
}

export const factAssertHandler: CommandHandler = {
  kind: 'fact.assert',
  propose(raw, ctx): Proposal<FactAssertResult> {
    const payload = FactAssertPayload.parse(raw);
    const subject = resolveEntity(ctx, payload.subject);
    if (!subject) throw new UsageError(`事实主语不是本分支实体：${payload.subject}`);
    const spec = requirePredicate(ctx, payload.predicate);

    let objectJson: string;
    try {
      objectJson = canonicalJson(payload.object);
    } catch (error) {
      throw new UsageError(
        `object 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const slotKey = slotKeyOf(subject.id, payload.predicate, payload.object, spec.cardinality);
    const existing = activeFactsInSlot(ctx, slotKey);
    // 默认 validFrom = 系统时间。同一毫秒内连续 supersede 时自动 +1ms，
    // 否则 valid_to 会等于 valid_from（CHECK 会拒绝）。故事时间（如"第01天"）不猜。
    let validFrom = payload.validFrom ?? ctx.now;
    if (payload.validFrom === undefined) {
      const latest = existing
        .map((row) => Date.parse(row.validFrom))
        .filter((value) => Number.isFinite(value));
      if (latest.length > 0) {
        const floor = Math.max(...latest) + 1;
        if (Date.parse(validFrom) < floor) validFrom = new Date(floor).toISOString();
      }
    }
    const plan = planFactAssert({
      subjectId: subject.id,
      predicate: payload.predicate,
      cardinality: spec.cardinality,
      object: payload.object,
      truth: payload.truth,
      secrecy: payload.secrecy,
      validFrom,
      existing,
      locked: isLocked(ctx, 'fact', slotKey),
    });
    if (!plan.ok) factError(plan);
    if (plan.action === 'same') {
      return {
        eventKind: 'fact.asserted',
        eventPayload: { action: 'same', slotKey, factId: plan.factId },
        apply(): FactAssertResult {
          return {
            factId: plan.factId,
            slotKey,
            action: 'same',
            supersededId: null,
            truth: payload.truth,
          };
        },
      };
    }

    const fact: FactRow = {
      id: newId('f'),
      branchId: ctx.branchId,
      subjectId: subject.id,
      predicate: payload.predicate,
      objectJson,
      card: spec.cardinality,
      truth: payload.truth,
      secrecy: payload.secrecy,
      validFrom,
      validTo: null,
      sourceSeq: payload.sourceSeq ?? ctx.headSeq,
      createdAt: ctx.now,
    };
    const supersededId = plan.action === 'supersede' ? plan.supersededId : null;
    const supersededValidTo = plan.action === 'supersede' ? plan.supersededValidTo : validFrom;
    return {
      eventKind: 'fact.asserted',
      eventPayload: {
        action: plan.action,
        fact,
        supersededId,
        supersededValidTo: supersededId ? supersededValidTo : null,
      },
      apply(): FactAssertResult {
        if (supersededId) {
          ctx.db
            .prepare('UPDATE fact SET valid_to = ? WHERE id = ? AND branch_id = ?')
            .run(supersededValidTo, supersededId, ctx.branchId);
        }
        ctx.db
          .prepare(
            `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth,
               secrecy, valid_from, valid_to, source_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fact.id,
            fact.branchId,
            fact.subjectId,
            fact.predicate,
            fact.objectJson,
            fact.card,
            fact.truth,
            fact.secrecy,
            fact.validFrom,
            fact.validTo,
            fact.sourceSeq,
            fact.createdAt,
          );
        return {
          factId: fact.id,
          slotKey,
          action: plan.action,
          supersededId,
          truth: fact.truth,
        };
      },
    };
  },
};

// ── fact.close ─────────────────────────────────────────────────────────────

const FactClosePayload = z.strictObject({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown().optional(),
  at: z.string().min(1).optional(),
});

export interface FactCloseResult {
  closed: number;
  ids: string[];
  at: string;
}

export const factCloseHandler: CommandHandler = {
  kind: 'fact.close',
  propose(raw, ctx): Proposal<FactCloseResult> {
    const payload = FactClosePayload.parse(raw);
    const subject = resolveEntity(ctx, payload.subject);
    if (!subject) throw new UsageError(`事实主语不是本分支实体：${payload.subject}`);
    const spec = requirePredicate(ctx, payload.predicate);
    if (spec.cardinality === 'multi' && payload.object === undefined) {
      throw new UsageError('多值谓词关闭事实必须指定 object（按宾语 id 定位槽位）');
    }
    const slotKey = slotKeyOf(subject.id, payload.predicate, payload.object, spec.cardinality);
    if (isLocked(ctx, 'fact', slotKey)) {
      throw new ConstraintError(`槽位 ${slotKey} 已锁定，不能关闭`, 'ck_fact_locked');
    }
    const active = activeFactsInSlot(ctx, slotKey);
    if (active.length === 0) throw new UsageError(`槽位没有当前有效事实：${slotKey}`);
    const at = payload.at ?? ctx.now;
    for (const row of active) {
      if (at <= row.validFrom) {
        throw new ConstraintError(
          `关闭时间 ${at} 必须晚于 valid_from ${row.validFrom}`,
          'ck_fact_time',
        );
      }
    }
    return {
      eventKind: 'fact.closed',
      eventPayload: { slotKey, at, rows: active.map((row) => ({ id: row.id, validTo: at })) },
      apply(): FactCloseResult {
        const update = ctx.db.prepare(
          'UPDATE fact SET valid_to = ? WHERE id = ? AND branch_id = ? AND valid_to IS NULL',
        );
        for (const row of active) update.run(at, row.id, ctx.branchId);
        return { closed: active.length, ids: active.map((row) => row.id), at };
      },
    };
  },
};

// ── cognition.grant ───────────────────────────────────────────────────────

const CognitionGrantPayload = z.strictObject({
  characterId: z.string().min(1),
  factId: z.string().min(1),
  attitude: z.enum(['knows', 'believes', 'suspects', 'doubts', 'falsely_believes']).default('knows'),
  certainty: z.number().min(0).max(1).default(1),
  percept: z.enum(['witness', 'told', 'reported', 'inferred', 'discovered']).default('told'),
});

export interface CognitionGrantResult {
  characterId: string;
  factId: string;
  attitude: string;
  created: boolean;
}

export const cognitionGrantHandler: CommandHandler = {
  kind: 'cognition.grant',
  propose(raw, ctx): Proposal<CognitionGrantResult> {
    const payload = CognitionGrantPayload.parse(raw);
    const character = resolveEntity(ctx, payload.characterId);
    if (!character || character.kind !== 'character') {
      throw new UsageError(`认知主体不是本分支角色：${payload.characterId}`);
    }
    const fact = ctx.db
      .prepare('SELECT id FROM fact WHERE id = ? AND branch_id = ? AND valid_to IS NULL')
      .get(payload.factId, ctx.branchId);
    if (!fact) throw new UsageError(`认知引用了无效或已失效的事实：${payload.factId}`);
    const existing = ctx.db
      .prepare('SELECT 1 FROM cognition WHERE branch_id = ? AND character_id = ? AND fact_id = ?')
      .get(ctx.branchId, character.id, payload.factId);
    return {
      eventKind: 'cognition.granted',
      eventPayload: {
        branchId: ctx.branchId,
        characterId: character.id,
        factId: payload.factId,
        attitude: payload.attitude,
        certainty: payload.certainty,
        learnedSeq: ctx.headSeq,
        percept: payload.percept,
      },
      apply(): CognitionGrantResult {
        ctx.db
          .prepare(
            `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty,
               learned_seq, source_message_id, percept)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(branch_id, character_id, fact_id)
             DO UPDATE SET attitude = excluded.attitude, certainty = excluded.certainty,
                           learned_seq = excluded.learned_seq, percept = excluded.percept`,
          )
          .run(
            ctx.branchId,
            character.id,
            payload.factId,
            payload.attitude,
            payload.certainty,
            ctx.headSeq,
            payload.percept,
          );
        return {
          characterId: character.id,
          factId: payload.factId,
          attitude: payload.attitude,
          created: !existing,
        };
      },
    };
  },
};

// ── lock.set ───────────────────────────────────────────────────────────────

const LockSetPayload = z.strictObject({
  scope: z.enum(LOCK_SCOPES),
  slotKey: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  predicate: z.string().min(1).optional(),
  object: z.unknown().optional(),
  fromId: z.string().min(1).optional(),
  toId: z.string().min(1).optional(),
  axis: z.enum(RELATION_AXES).optional(),
  reason: z.string().trim().min(1),
  lockedBy: z.string().default('author'),
});

export interface LockSetResult {
  scope: LockScope;
  slotKey: string;
  lockedBy: string;
}

export const lockSetHandler: CommandHandler = {
  kind: 'lock.set',
  propose(raw, ctx): Proposal<LockSetResult> {
    const payload = LockSetPayload.parse(raw);
    let slotKey: string;
    if (payload.scope === 'fact') {
      if (!payload.subject || !payload.predicate) {
        throw new UsageError('fact 锁需要 --subject 与 --predicate');
      }
      const subject = resolveEntity(ctx, payload.subject);
      if (!subject) throw new UsageError(`锁定主语不是本分支实体：${payload.subject}`);
      const spec = requirePredicate(ctx, payload.predicate);
      if (spec.cardinality === 'multi' && payload.object === undefined) {
        throw new UsageError('多值谓词的 fact 锁必须指定 object（槽位键含宾语 id）');
      }
      slotKey = slotKeyOf(subject.id, payload.predicate, payload.object, spec.cardinality);
    } else if (payload.scope === 'relation') {
      if (!payload.fromId || !payload.toId || !payload.axis) {
        throw new UsageError('relation 锁需要 --from、--to 与 --axis');
      }
      const from = resolveEntity(ctx, payload.fromId);
      const to = resolveEntity(ctx, payload.toId);
      if (!from || !to) throw new UsageError('relation 锁的两端必须是本分支实体');
      // relation 槽位键约定：from|to|axis（schema 未定义，写入侧与读取侧共用这一处）。
      slotKey = `${from.id}|${to.id}|${payload.axis}`;
    } else {
      if (!payload.slotKey) throw new UsageError(`${payload.scope} 锁需要 --slot`);
      slotKey = payload.slotKey;
    }
    if (isLocked(ctx, payload.scope, slotKey)) {
      throw new UsageError(`该槽位已锁定：${payload.scope} ${slotKey}`);
    }
    const row = {
      branchId: ctx.branchId,
      scope: payload.scope,
      slotKey,
      reason: payload.reason,
      lockedBy: payload.lockedBy,
      createdAt: ctx.now,
    };
    return {
      eventKind: 'lock.set',
      eventPayload: { lock: row },
      apply(): LockSetResult {
        ctx.db
          .prepare(
            `INSERT INTO lock(branch_id, scope, slot_key, reason, locked_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(row.branchId, row.scope, row.slotKey, row.reason, row.lockedBy, row.createdAt);
        return { scope: row.scope, slotKey: row.slotKey, lockedBy: row.lockedBy };
      },
    };
  },
};

// ── memory.add / link / delete / embed ────────────────────────────────────

const MemoryAddPayload = z.strictObject({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1),
  importance: z.number().min(0.05).max(3).default(1),
  stability: z.number().positive().default(21),
  conf: z.number().min(0).max(1).default(1),
  validFrom: z.string().min(1).optional(),
  pinned: z.boolean().default(false),
  hard: z.boolean().default(false),
  sensitivity: z.number().int().min(0).max(3).default(0),
  ownerId: z.string().min(1).optional(),
  slotKey: z.string().min(1).optional(),
  sourceSeq: z.number().int().min(0).optional(),
  resolvedSeq: z.number().int().min(0).optional(),
  embedding: z.array(z.number()).max(4096).optional(),
  embeddingModel: z.string().min(1).optional(),
});

export interface MemoryAddResult {
  id: string;
  kind: MemoryKind;
  pinned: boolean;
  hard: boolean;
}

export interface MemoryNodeRow {
  id: string;
  branchId: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  stability: number;
  conf: number;
  validFrom: string;
  lastAccess: string | null;
  accessCount: number;
  pinned: 0 | 1;
  hard: 0 | 1;
  sensitivity: number;
  ownerId: string | null;
  slotKey: string | null;
  sourceSeq: number | null;
  resolvedSeq: number | null;
  embeddingB64: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
}

export const memoryAddHandler: CommandHandler = {
  kind: 'memory.add',
  propose(raw, ctx): Proposal<MemoryAddResult> {
    const payload = MemoryAddPayload.parse(raw);
    if (payload.resolvedSeq !== undefined && payload.kind !== 'clue') {
      throw new UsageError('只有线索（clue）可以被"回收"：resolvedSeq 仅对 clue 有效');
    }
    if (payload.resolvedSeq !== undefined && payload.sourceSeq === undefined) {
      throw new UsageError('回收线索需要 sourceSeq（记录是哪一回收的）');
    }
    const owner = payload.ownerId ? resolveEntity(ctx, payload.ownerId) : null;
    if (payload.ownerId && !owner) throw new UsageError(`owner 不是本分支实体：${payload.ownerId}`);

    let vectorB64: string | null = null;
    if (payload.embedding) {
      const vector = prepareVector(payload.embedding, VECTOR_DIM);
      vectorB64 = Buffer.from(encodeVector(vector)).toString('base64');
    }
    const model = vectorB64 ? payload.embeddingModel ?? 'hash' : null;
    const pinned = payload.hard ? true : payload.pinned;
    const node: MemoryNodeRow = {
      id: newId('mn'),
      branchId: ctx.branchId,
      kind: payload.kind,
      text: payload.text,
      importance: payload.importance,
      stability: payload.stability,
      conf: payload.conf,
      validFrom: payload.validFrom ?? ctx.now,
      lastAccess: null,
      accessCount: 0,
      pinned: pinned ? 1 : 0,
      hard: payload.hard ? 1 : 0,
      sensitivity: payload.sensitivity,
      ownerId: owner?.id ?? null,
      slotKey: payload.slotKey ?? null,
      sourceSeq: payload.sourceSeq ?? null,
      resolvedSeq: payload.resolvedSeq ?? null,
      embeddingB64: vectorB64,
      embeddingModel: model,
      embeddingDim: vectorB64 ? VECTOR_DIM : null,
    };
    return {
      eventKind: 'memory.added',
      eventPayload: { node },
      apply(): MemoryAddResult {
        ctx.db
          .prepare(
            `INSERT INTO memory_node(id, branch_id, kind, text, importance, stability, conf,
               valid_from, last_access, access_count, pinned, hard, sensitivity, owner_id,
               slot_key, source_seq, resolved_seq, embedding, embedding_model, embedding_dim)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            node.id,
            node.branchId,
            node.kind,
            node.text,
            node.importance,
            node.stability,
            node.conf,
            node.validFrom,
            node.pinned,
            node.hard,
            node.sensitivity,
            node.ownerId,
            node.slotKey,
            node.sourceSeq,
            node.resolvedSeq,
            node.embeddingB64 ? Buffer.from(node.embeddingB64, 'base64') : null,
            node.embeddingModel,
            node.embeddingDim,
          );
        return { id: node.id, kind: node.kind, pinned: pinned, hard: payload.hard };
      },
    };
  },
};

const MemoryLinkPayload = z.strictObject({
  src: z.string().min(1),
  dst: z.string().min(1),
  kind: z.enum(MEMORY_EDGE_KINDS),
  weight: z.number().min(0).max(1).default(1),
});

export interface MemoryLinkResult {
  src: string;
  dst: string;
  kind: MemoryEdgeKind;
}

export const memoryLinkHandler: CommandHandler = {
  kind: 'memory.link',
  propose(raw, ctx): Proposal<MemoryLinkResult> {
    const payload = MemoryLinkPayload.parse(raw);
    if (payload.src === payload.dst) throw new UsageError('记忆边两端不能是同一节点');
    for (const id of [payload.src, payload.dst]) {
      const node = ctx.db
        .prepare('SELECT id FROM memory_node WHERE id = ? AND branch_id = ?')
        .get(id, ctx.branchId);
      if (!node) throw new UsageError(`记忆节点不存在：${id}`);
    }
    const row = { src: payload.src, dst: payload.dst, kind: payload.kind, weight: payload.weight };
    return {
      eventKind: 'memory.linked',
      eventPayload: { edge: row },
      apply(): MemoryLinkResult {
        ctx.db
          .prepare('INSERT INTO memory_edge(src, dst, kind, weight) VALUES (?, ?, ?, ?)')
          .run(row.src, row.dst, row.kind, row.weight);
        return { src: row.src, dst: row.dst, kind: row.kind };
      },
    };
  },
};

const MemoryDeletePayload = z.strictObject({ id: z.string().min(1) });

export interface MemoryDeleteResult {
  id: string;
  deleted: true;
}

export const memoryDeleteHandler: CommandHandler = {
  kind: 'memory.delete',
  propose(raw, ctx): Proposal<MemoryDeleteResult> {
    const payload = MemoryDeletePayload.parse(raw);
    const node = ctx.db
      .prepare('SELECT id FROM memory_node WHERE id = ? AND branch_id = ?')
      .get(payload.id, ctx.branchId);
    if (!node) throw new UsageError(`记忆节点不存在：${payload.id}`);
    return {
      eventKind: 'memory.deleted',
      eventPayload: { id: payload.id },
      apply(): MemoryDeleteResult {
        // 有子节点的摘要由触发器 ck_memory_has_children 拒绝，这里不预判。
        ctx.db.prepare('DELETE FROM memory_node WHERE id = ? AND branch_id = ?').run(
          payload.id,
          ctx.branchId,
        );
        return { id: payload.id, deleted: true };
      },
    };
  },
};

const MemoryEmbedPayload = z.strictObject({
  updates: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        vector: z.array(z.number()).min(1),
        model: z.string().min(1).default('hash'),
      }),
    )
    .min(1)
    .max(50),
});

export interface MemoryEmbedResult {
  updated: number;
  dim: number;
}

export const memoryEmbedHandler: CommandHandler = {
  kind: 'memory.embed',
  propose(raw, ctx): Proposal<MemoryEmbedResult> {
    const payload = MemoryEmbedPayload.parse(raw);
    const updates = payload.updates.map((update) => {
      const node = ctx.db
        .prepare('SELECT id FROM memory_node WHERE id = ? AND branch_id = ?')
        .get(update.id, ctx.branchId);
      if (!node) throw new UsageError(`记忆节点不存在：${update.id}`);
      const vector = prepareVector(update.vector, VECTOR_DIM);
      return {
        id: update.id,
        vectorB64: Buffer.from(encodeVector(vector)).toString('base64'),
        model: update.model,
      };
    });
    return {
      eventKind: 'memory.embedded',
      eventPayload: { updates },
      apply(): MemoryEmbedResult {
        const stmt = ctx.db.prepare(
          `UPDATE memory_node SET embedding = ?, embedding_model = ?, embedding_dim = ?
           WHERE id = ? AND branch_id = ?`,
        );
        for (const update of updates) {
          stmt.run(
            Buffer.from(update.vectorB64, 'base64'),
            update.model,
            VECTOR_DIM,
            update.id,
            ctx.branchId,
          );
        }
        return { updated: updates.length, dim: VECTOR_DIM };
      },
    };
  },
};

// ── job.* ─────────────────────────────────────────────────────────────────

const JobEnqueuePayload = z.strictObject({
  kind: z.enum(JOB_KINDS),
  targetId: z.string().min(1).optional(),
  expectedSeq: z.number().int().min(0).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export interface JobEnqueueResult {
  jobId: string;
  generation: number;
  expectedSeq: number;
}

export interface JobRow {
  id: string;
  branchId: string;
  kind: JobKind;
  targetId: string | null;
  expectedSeq: number;
  generation: number;
  status: JobStatus;
  payload: string;
  createdAt: string;
}

export const jobEnqueueHandler: CommandHandler = {
  kind: 'job.enqueue',
  propose(raw, ctx): Proposal<JobEnqueueResult> {
    const payload = JobEnqueuePayload.parse(raw);
    const maxRow = ctx.db
      .prepare(
        `SELECT COALESCE(MAX(generation), 0) AS g FROM job
         WHERE branch_id = ? AND kind = ? AND COALESCE(target_id, '') = COALESCE(?, '')`,
      )
      .get(ctx.branchId, payload.kind, payload.targetId ?? null) as { g: number };
    const generation = Number(maxRow.g) + 1;
    const expectedSeq = payload.expectedSeq ?? ctx.headSeq;
    const job: JobRow = {
      id: newId('j'),
      branchId: ctx.branchId,
      kind: payload.kind,
      targetId: payload.targetId ?? null,
      expectedSeq,
      generation,
      status: 'queued',
      payload: canonicalJson(payload.payload),
      createdAt: ctx.now,
    };
    return {
      eventKind: 'job.enqueued',
      eventPayload: { job },
      apply(): JobEnqueueResult {
        ctx.db
          .prepare(
            `INSERT INTO job(id, branch_id, kind, target_id, expected_seq, generation, status,
               payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            job.id,
            job.branchId,
            job.kind,
            job.targetId,
            job.expectedSeq,
            job.generation,
            job.payload,
            job.createdAt,
          );
        return { jobId: job.id, generation, expectedSeq };
      },
    };
  },
};

const JobClaimPayload = z.strictObject({
  kinds: z.array(z.enum(JOB_KINDS)).min(1).optional(),
});

export interface JobClaimResult {
  job: JobRow | null;
  discarded: string[];
}

export const jobClaimHandler: CommandHandler = {
  kind: 'job.claim',
  propose(raw, ctx): Proposal<JobClaimResult> {
    const payload = JobClaimPayload.parse(raw);
    const rows = ctx.db
      .prepare(
        `SELECT id, branch_id AS branchId, kind, target_id AS targetId,
                expected_seq AS expectedSeq, generation, status, payload, created_at AS createdAt
         FROM job WHERE branch_id = ? AND status = 'queued'
         ORDER BY created_at, rowid`,
      )
      .all(ctx.branchId) as JobRow[];
    const filtered = payload.kinds
      ? rows.filter((row) => payload.kinds!.includes(row.kind))
      : rows;
    if (filtered.length === 0) throw new UsageError('任务队列为空');

    // 同一 (kind,target) 只跑最新 generation：旧任务在队列里就被取代 → discarded。
    const groups = new Map<string, JobRow[]>();
    for (const row of filtered) {
      const key = `${row.kind}\u0000${row.targetId ?? ''}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    const discarded: string[] = [];
    const survivors: JobRow[] = [];
    for (const list of groups.values()) {
      const newest = Math.max(...list.map((row) => row.generation));
      for (const row of list) {
        if (row.generation < newest) discarded.push(row.id);
        else survivors.push(row);
      }
    }
    survivors.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const chosen = survivors[0]!;
    return {
      eventKind: 'job.claimed',
      eventPayload: { jobId: chosen.id, discarded },
      apply(): JobClaimResult {
        ctx.db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(chosen.id);
        const discard = ctx.db.prepare("UPDATE job SET status = 'discarded' WHERE id = ?");
        for (const id of discarded) discard.run(id);
        return { job: { ...chosen, status: 'running' }, discarded };
      },
    };
  },
};

const JobFinishPayload = z.strictObject({
  jobId: z.string().min(1),
  status: z.enum(JOB_FINISH),
  error: z.string().optional(),
});

export interface JobFinishResult {
  jobId: string;
  status: JobStatus;
  superseded: boolean;
}

export const jobFinishHandler: CommandHandler = {
  kind: 'job.finish',
  propose(raw, ctx): Proposal<JobFinishResult> {
    const payload = JobFinishPayload.parse(raw);
    const row = ctx.db
      .prepare(
        `SELECT id, kind, target_id AS targetId, generation, status, payload
         FROM job WHERE id = ? AND branch_id = ?`,
      )
      .get(payload.jobId, ctx.branchId) as
      | {
          id: string;
          kind: JobKind;
          targetId: string | null;
          generation: number;
          status: JobStatus;
          payload: string;
        }
      | undefined;
    if (!row) throw new UsageError(`任务不存在：${payload.jobId}`);
    if (row.status !== 'running') throw new UsageError(`任务状态 ${row.status} 不能结束`);
    const newer = ctx.db
      .prepare(
        `SELECT 1 FROM job WHERE branch_id = ? AND kind = ? AND COALESCE(target_id,'') = COALESCE(?,'')
           AND generation > ? AND status = 'done' LIMIT 1`,
      )
      .get(ctx.branchId, row.kind, row.targetId, row.generation);
    const superseded = payload.status === 'done' && Boolean(newer);
    const effective: JobStatus = superseded ? 'discarded' : payload.status;
    const previous = JSON.parse(row.payload) as Record<string, unknown>;
    const nextPayload = canonicalJson(
      payload.error ? { ...previous, error: payload.error } : previous,
    );
    return {
      eventKind: 'job.finished',
      eventPayload: {
        jobId: row.id,
        status: effective,
        requested: payload.status,
        error: payload.error ?? null,
        payload: nextPayload,
      },
      apply(): JobFinishResult {
        ctx.db
          .prepare('UPDATE job SET status = ?, payload = ? WHERE id = ?')
          .run(effective, nextPayload, row.id);
        return { jobId: row.id, status: effective, superseded };
      },
    };
  },
};

export const P2_HANDLERS: readonly CommandHandler[] = [
  factAssertHandler,
  factCloseHandler,
  cognitionGrantHandler,
  lockSetHandler,
  memoryAddHandler,
  memoryLinkHandler,
  memoryDeleteHandler,
  memoryEmbedHandler,
  jobEnqueueHandler,
  jobClaimHandler,
  jobFinishHandler,
];
