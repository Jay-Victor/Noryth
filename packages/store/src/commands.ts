import {
  canonicalJson,
  estTokens,
  sha256Hex,
  type ActorType,
} from '@noryth/core';
import { z } from 'zod';
import type { Db } from './db.js';
import { ConstraintError, UsageError, asConstraintError } from './errors.js';
import { P1_HANDLERS } from './handlers.js';
import { newId } from './ids.js';
import { getActiveBranch, getProject } from './project.js';

/** actor 由宿主注入，绝不从 payload 里读——否则"模型无写权限"在命令层就被绕过。 */
export interface Actor {
  type: ActorType;
  id?: string | null;
}

export interface Command {
  kind: string;
  idempotencyKey: string;
  /** 客户端看到的 head。不一致说明有人先提交了，拒绝而不是覆盖。 */
  expectedHead?: number;
  payload: unknown;
}

export interface CommandContext {
  db: Db;
  projectId: string;
  branchId: string;
  /** 本次提交将占用的分支序号（branch.head_seq + 1）。 */
  headSeq: number;
  now: string;
}

export interface Proposal<R = unknown> {
  eventKind: string;
  eventPayload: unknown;
  apply(ctx: CommandContext): R;
}

export interface CommandHandler {
  kind: string;
  propose(payload: unknown, ctx: CommandContext): Proposal;
}

export interface CommandResult<R = unknown> {
  seq: number;
  replayed: boolean;
  result: R;
}

interface ReceiptRow {
  idempotency_key: string;
  request_hash: string;
  result_json: string;
  result_seq: number | null;
}

interface BranchRow {
  id: string;
  head_seq: number;
}

function readReceipt(db: Db, projectId: string, key: string): ReceiptRow | undefined {
  return db
    .prepare(
      `SELECT idempotency_key, request_hash, result_json, result_seq
       FROM receipt WHERE project_id = ? AND idempotency_key = ?`,
    )
    .get(projectId, key) as ReceiptRow | undefined;
}

const MESSAGE_ROLES = ['character', 'narrator', 'director', 'user', 'system'] as const;
const MESSAGE_PERCEPTS = [
  'public',
  'whisper',
  'soliloquy',
  'narrator_reader',
  'director',
  'system',
] as const;

const MessageAppendPayload = z.strictObject({
  sceneId: z.string().min(1),
  agentId: z.string().min(1),
  roleType: z.enum(MESSAGE_ROLES),
  prose: z.string(),
  structured: z.record(z.string(), z.unknown()).default({}),
  audience: z.array(z.string().min(1)).default([]),
  percept: z.enum(MESSAGE_PERCEPTS),
  beatId: z.string().min(1).optional(),
  tokenEst: z.number().int().min(0).optional(),
});

export type MessageAppendInput = z.input<typeof MessageAppendPayload>;

export interface MessageAppendResult {
  messageId: string;
  seq: number;
  contentHash: string;
  tokenEst: number;
}

/**
 * 唯一一条 P0 命令：追加一条消息。
 * 它同时是幂等收据、引用完整性、感知规则三条路径的活样本；P1 的
 * beat / cognition / relation 命令都走同一个 submit 外壳。
 */
export const messageAppendHandler: CommandHandler = {
  kind: 'message.append',
  propose(raw, ctx): Proposal<MessageAppendResult> {
    const payload = MessageAppendPayload.parse(raw);
    const { db, branchId, headSeq, now } = ctx;

    const scene = db
      .prepare('SELECT id FROM scene WHERE id = ? AND branch_id = ?')
      .get(payload.sceneId, branchId);
    if (!scene) {
      throw new UsageError(`场景不存在或不属于当前分支：${payload.sceneId}`);
    }
    if (payload.beatId) {
      const beat = db
        .prepare('SELECT id FROM beat WHERE id = ? AND scene_id = ?')
        .get(payload.beatId, payload.sceneId);
      if (!beat) throw new UsageError(`节拍不存在或不属于该场景：${payload.beatId}`);
    }
    for (const audienceId of payload.audience) {
      const entity = db
        .prepare('SELECT id FROM entity WHERE id = ? AND branch_id = ?')
        .get(audienceId, branchId);
      if (!entity) throw new UsageError(`受众不是本分支实体：${audienceId}`);
    }
    if (payload.percept === 'whisper' && payload.audience.length < 1) {
      throw new UsageError('耳语必须有受众');
    }
    if (
      (payload.percept === 'soliloquy' || payload.percept === 'narrator_reader') &&
      payload.audience.length !== 0
    ) {
      throw new UsageError('心理独白 / 旁白不得有受众：这条消息不进任何角色的上下文');
    }
    const hasLine = typeof payload.structured.line === 'string';
    if (payload.prose.length === 0 && !hasLine) {
      throw new UsageError('空消息：prose 与 structured.line 至少有一个');
    }

    const structuredJson = canonicalJson(payload.structured);
    const contentHash = sha256Hex(`${payload.prose}\u0000${structuredJson}`);
    const tokenEst = payload.tokenEst ?? estTokens(payload.prose);
    const messageId = newId('m');
    const messageRow = {
      id: messageId,
      branchId,
      seq: headSeq,
      sceneId: payload.sceneId,
      beatId: payload.beatId ?? null,
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
      eventKind: 'message.appended',
      eventPayload: {
        messageId,
        seq: headSeq,
        sceneId: payload.sceneId,
        agentId: payload.agentId,
        percept: payload.percept,
        // 重放需要完整行；只有摘要字段的事件无法回退（A6）。
        message: messageRow,
      },
      apply(): MessageAppendResult {
        db.prepare(
          `INSERT INTO message(id, branch_id, seq, scene_id, beat_id, agent_id, role_type,
             prose, structured, audience, percept, content_hash, token_est, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          messageRow.id,
          messageRow.branchId,
          messageRow.seq,
          messageRow.sceneId,
          messageRow.beatId,
          messageRow.agentId,
          messageRow.roleType,
          messageRow.prose,
          messageRow.structured,
          messageRow.audience,
          messageRow.percept,
          messageRow.contentHash,
          messageRow.tokenEst,
          messageRow.createdAt,
        );
        return { messageId, seq: headSeq, contentHash, tokenEst };
      },
    };
  },
};

export const DEFAULT_HANDLERS: readonly CommandHandler[] = [messageAppendHandler, ...P1_HANDLERS];

/**
 * 唯一写入路径：Command → 幂等收据 → 授权（actor）→ 提案 → 校验 →
 * BEGIN IMMEDIATE（事件 + 投影 + head + 收据）→ COMMIT。
 *
 * 失败的操作不占用幂等键：整个事务回滚，包括 event 与 receipt。
 */
export class CommandBus {
  constructor(
    private readonly db: Db,
    private readonly handlers: readonly CommandHandler[] = DEFAULT_HANDLERS,
  ) {}

  submit<R = unknown>(actor: Actor, command: Command): CommandResult<R> {
    const key = command.idempotencyKey.trim();
    if (!key) throw new UsageError('idempotencyKey 不能为空');
    if (!command.kind.trim()) throw new UsageError('command.kind 不能为空');
    if (
      command.expectedHead !== undefined &&
      (!Number.isInteger(command.expectedHead) || command.expectedHead < 0)
    ) {
      throw new UsageError(`expectedHead 必须是非负整数：${command.expectedHead}`);
    }
    const handler = this.handlers.find((h) => h.kind === command.kind);
    if (!handler) throw new UsageError(`未知命令：${command.kind}`);

    const project = getProject(this.db);
    const branch = getActiveBranch(this.db);
    if (!project || !branch) throw new UsageError('项目未初始化：project / branch 缺失');

    const requestHash = sha256Hex(
      canonicalJson({
        kind: command.kind,
        payload: command.payload,
        expectedHead: command.expectedHead ?? null,
      }),
    );

    const replay = (row: ReceiptRow): CommandResult<R> => {
      if (row.request_hash !== requestHash) {
        throw new ConstraintError(
          '同一幂等键被用于不同请求（同键不同 hash），拒绝执行',
          'ck_idempotency_conflict',
        );
      }
      return {
        seq: row.result_seq ?? 0,
        replayed: true,
        result: JSON.parse(row.result_json) as R,
      };
    };

    const existing = readReceipt(this.db, project.id, key);
    if (existing) return replay(existing);

    const now = new Date().toISOString();
    const run = this.db.transaction((): CommandResult<R> => {
      const again = readReceipt(this.db, project.id, key);
      if (again) return replay(again);

      const current = this.db
        .prepare('SELECT id, head_seq FROM branch WHERE id = ?')
        .get(branch.id) as BranchRow;
      if (command.expectedHead !== undefined && current.head_seq !== command.expectedHead) {
        throw new ConstraintError(
          `提交基于过期 head：expected ${command.expectedHead}，实际 ${current.head_seq}`,
          'ck_stale_head',
        );
      }
      // branch.head_seq / checkpoint.seq / snapshot.seq 都使用全局 event.seq。
      // fork_seq 与 head_seq 只有在同一坐标系里比较才有意义（A6 的回退范围）。
      const nextSeqRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM event')
        .get() as { n: number };
      const nextSeq = Number(nextSeqRow.n);
      const ctx: CommandContext = {
        db: this.db,
        projectId: project.id,
        branchId: branch.id,
        headSeq: nextSeq,
        now,
      };

      const proposal = handler.propose(command.payload, ctx);
      this.db
        .prepare(
          `INSERT INTO event(project_id, branch_id, kind, actor_type, actor_id,
             payload, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          branch.id,
          proposal.eventKind,
          actor.type,
          actor.id ?? null,
          canonicalJson(proposal.eventPayload),
          key,
          now,
        );

      const result = proposal.apply(ctx) as R;
      this.db.prepare('UPDATE branch SET head_seq = ? WHERE id = ?').run(nextSeq, branch.id);
      this.db
        .prepare('UPDATE project_state SET head_seq = ? WHERE project_id = ?')
        .run(nextSeq, project.id);
      this.db
        .prepare(
          `INSERT INTO receipt(project_id, idempotency_key, command, request_hash,
             result_json, result_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(project.id, key, command.kind, requestHash, canonicalJson(result), nextSeq, now);

      return { seq: nextSeq, replayed: false, result };
    });

    try {
      return run.immediate();
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new UsageError(
          `命令负载不合法：${error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        );
      }
      asConstraintError(error);
    }
  }
}
