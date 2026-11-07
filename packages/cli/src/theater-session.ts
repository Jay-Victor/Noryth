/**
 * 剧场会话：一拍一拍地跑，直到拍数用尽、场景关闭或需要作者裁决。
 *
 * 这一层只做编排：core 决定"谁说话"，store 负责落库，provider 生成文本。
 * 任何业务判断都不在这里发明——收束、升级、抽牌全部来自 core 的纯函数。
 */
import {
  PARAMS,
  assembleCharacterContext,
  assembleNarratorContext,
  assertKey,
  buildAudience,
  estTokens,
  evalExit,
  knowledgeViolations,
  parseCharacterOutput,
  parseNarratorOutput,
  planBeat,
  reachedMaxBeats,
  type CharacterOutput,
  type ContextResult,
  type ExitExpr,
  type ModelPort,
  type NarratorOutput,
  type SceneState,
} from '@noryth/core';
import {
  CommandBus,
  HumanError,
  ModelError,
  UsageError,
  createCheckpointWithSnapshot,
  lastSnapshotSeq,
  loadTheater,
  readCharacterContext,
  readClaimIndex,
  readClues,
  readKnownFactIds,
  readNarratorContext,
  readSceneEvalState,
  resolveSceneId,
  type Db,
} from '@noryth/store';
import { commitSceneClose } from './state-export.js';

export interface SessionOptions {
  sceneId?: string;
  beats: number;
  seed: number;
  mode: 'auto' | 'step';
  pick?: string;
  model: ModelPort;
  /** 项目根；场景关闭时写状态包并提交。缺省则跳过 Git 落点。 */
  root?: string;
}

export interface SessionBeat {
  beatSeq: number;
  speaker: string;
  mode: string;
  isNarrator: boolean;
  tokens: number;
  level: string;
  card: string | null;
  escalated: boolean;
  /** 这一拍的正文（台词的段落），供 CLI 展示与 --json 消费。 */
  prose: string;
}

export interface SessionResult {
  sceneId: string;
  title: string;
  produced: number;
  beats: number;
  maxBeats: number;
  state: SceneState;
  exitSatisfied: boolean;
  warned: boolean;
  log: SessionBeat[];
  tokens: { total: number; max: number; budget: number };
  warnings: { code: string; message: string }[];
  /** 场景关闭时的 Git 提交（没有提交则为 null）。 */
  commit: string | null;
}

const BUDGET = PARAMS['context.budget_total'];
const SNAPSHOT_INTERVAL = PARAMS['rollback.snapshot_interval'];

function currentHead(db: Db): number {
  const row = db
    .prepare('SELECT head_seq AS head FROM branch WHERE id = (SELECT active_branch_id FROM project_state LIMIT 1)')
    .get() as { head: number };
  return row.head;
}

function branchOf(db: Db, sceneId: string): string {
  return (
    db.prepare('SELECT branch_id AS id FROM scene WHERE id = ?').get(sceneId) as { id: string }
  ).id;
}

function sceneExit(db: Db, sceneId: string): ExitExpr {
  const row = db.prepare('SELECT exit_conditions AS e FROM scene WHERE id = ?').get(sceneId) as {
    e: string;
  };
  try {
    return JSON.parse(row.e) as ExitExpr;
  } catch (error) {
    throw new ModelError(
      `场景 ${sceneId} 的 exit_conditions 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function namesOf(db: Db, refs: readonly string[]): string[] {
  return refs.map((ref) => {
    const row = db
      .prepare('SELECT name FROM entity WHERE id = ? OR name = ? LIMIT 1')
      .get(ref, ref) as { name: string } | undefined;
    return row?.name ?? ref;
  });
}

async function characterOutput(
  model: ModelPort,
  request: Parameters<ModelPort['generate']>[0],
  hint = '',
): Promise<CharacterOutput> {
  let text = await model.generate({
    ...request,
    prompt: {
      system: request.prompt.system,
      user: hint.length > 0 ? `${request.prompt.user}\n\n${hint}` : request.prompt.user,
    },
  });
  let parsed = parseCharacterOutput(text);
  if (parsed.ok) return parsed.value;
  text = await model.generate({
    ...request,
    prompt: {
      system: request.prompt.system,
      user: `${request.prompt.user}\n\n【上一次输出不是合法 JSON】${parsed.error}\n只输出合法 JSON，不要解释。`,
    },
  });
  parsed = parseCharacterOutput(text);
  if (!parsed.ok) {
    throw new ModelError(`角色输出无法解析（已重试 1 次）：${parsed.error}`);
  }
  return parsed.value;
}

async function narratorOutput(
  model: ModelPort,
  request: Parameters<ModelPort['generate']>[0],
): Promise<NarratorOutput> {
  let text = await model.generate(request);
  let parsed = parseNarratorOutput(text);
  if (parsed.ok) return parsed.value;
  text = await model.generate({
    ...request,
    prompt: {
      system: request.prompt.system,
      user: `${request.prompt.user}\n\n【上一次输出不是合法 JSON】${parsed.error}\n只输出合法 JSON，不要解释。`,
    },
  });
  parsed = parseNarratorOutput(text);
  if (!parsed.ok) {
    throw new ModelError(`旁白输出无法解析（已重试 1 次）：${parsed.error}`);
  }
  return parsed.value;
}

function contextOf(
  db: Db,
  sceneId: string,
  speakerId: string,
  isNarrator: boolean,
): ContextResult {
  if (isNarrator) {
    return assembleNarratorContext(readNarratorContext(db, sceneId, BUDGET));
  }
  return assembleCharacterContext(readCharacterContext(db, sceneId, speakerId, BUDGET));
}

function cognitionRows(
  db: Db,
  sceneId: string,
  output: CharacterOutput,
  audience: readonly string[],
): {
  characterId: string;
  factId: string;
  attitude: 'knows' | 'suspects' | 'falsely_believes';
  certainty: number;
  percept: 'told' | 'witness';
}[] {
  if (audience.length === 0) return [];
  const scene = db.prepare('SELECT branch_id AS b FROM scene WHERE id = ?').get(sceneId) as {
    b: string;
  };
  const claims = readClaimIndex(db, scene.b);
  const rows: {
    characterId: string;
    factId: string;
    attitude: 'knows' | 'suspects' | 'falsely_believes';
    certainty: number;
    percept: 'told' | 'witness';
  }[] = [];
  const seen = new Set<string>();
  const push = (
    characterId: string,
    factId: string,
    attitude: 'knows' | 'suspects' | 'falsely_believes',
  ): void => {
    const key = `${characterId}\u0000${factId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ characterId, factId, attitude, certainty: 1, percept: 'told' });
  };
  for (const assert of output.asserts) {
    const entry = claims.get(assertKey(assert.subject, assert.predicate, assert.object));
    if (!entry) continue; // 新 claim 不改世界状态
    const attitude =
      entry.truth === 1 ? 'knows' : entry.truth === -1 ? 'falsely_believes' : 'suspects';
    for (const who of audience) push(who, entry.factId, attitude);
  }
  for (const factId of output.reveals) {
    for (const who of audience) push(who, factId, 'knows');
  }
  return rows;
}

function maybeCheckpoint(db: Db, branchId: string, label: string): void {
  const head = currentHead(db);
  if (head - lastSnapshotSeq(db, branchId) < SNAPSHOT_INTERVAL) return;
  createCheckpointWithSnapshot(db, { branchId, seq: head, label, trigger: 'auto' });
}

/**
 * 跑一场。返回时场景可能是 closed（收束或 WARN）或 open（拍数用尽）。
 * 需要作者裁决时抛 HumanError，模型输出修不好时抛 ModelError，两者都不写拍。
 */
export async function runSession(db: Db, options: SessionOptions): Promise<SessionResult> {
  const sceneId = resolveSceneId(db, options.sceneId);
  const bus = new CommandBus(db);
  const warnings: SessionResult['warnings'] = [];
  const log: SessionBeat[] = [];
  let exitSatisfied = false;
  let warned = false;
  let tokenTotal = 0;
  let tokenMax = 0;
  let lastCommit: string | null = null;

  const sceneInfo = db
    .prepare('SELECT title, state, max_beats AS maxBeats FROM scene WHERE id = ?')
    .get(sceneId) as { title: string; state: SceneState; maxBeats: number };
  let state: SceneState = sceneInfo.state;

  const closeScene = (branchId: string, label: string): void => {
    const checkpoint = createCheckpointWithSnapshot(db, {
      branchId,
      seq: currentHead(db),
      label,
      trigger: 'scene_close',
    });
    if (!options.root) return;
    const committed = commitSceneClose(options.root, db, sceneInfo.title, checkpoint.checkpointId);
    if (committed.error) {
      warnings.push({ code: 'git_commit_failed', message: committed.error });
    }
    if (committed.commit) lastCommit = committed.commit;
  };

  if (options.pick) {
    const loaded = loadTheater(db, sceneId);
    const found = loaded.runtime.actors.some(
      (actor) => actor.id === options.pick || actor.name === options.pick,
    );
    if (!found) throw new UsageError(`--pick 指定的人不在场：${options.pick}`);
  }

  if (state === 'closed' || state === 'abandoned') {
    throw new HumanError(`场景已关闭：${sceneId}（用 noryth scene create 新建一场）`);
  }
  if (state === 'planned' || state === 'paused') {
    const head = currentHead(db);
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.state',
        idempotencyKey: `open-${sceneId}-${head}`,
        payload: { sceneId, to: 'open', reason: 'run' },
      },
    );
    state = 'open';
    createCheckpointWithSnapshot(db, {
      branchId: branchOf(db, sceneId),
      seq: currentHead(db),
      label: `场景开启 · ${sceneInfo.title}`,
      trigger: 'auto',
    });
  }

  const maxLoops = Math.max(4, options.beats * 2 + 8);
  for (let loop = 0; loop < maxLoops; loop += 1) {
    const loaded = loadTheater(db, sceneId);
    state = loaded.runtime.scene.state;

    // 收束：场景已进入 closing，再写 1 拍旁白，然后关闭。
    if (state === 'closing') {
      const context = contextOf(db, sceneId, 'narrator', true);
      const narration = await narratorOutput(options.model, {
        kind: 'narrator',
        agentId: 'narrator',
        agentName: '旁白',
        seq: loaded.runtime.scene.beats + 1,
        seed: options.seed,
        intent: 'closing',
        prompt: context.prompt,
      });
      const prose = narration.paragraphs.join('\n\n');
      bus.submit(
        { type: 'character', id: 'narrator' },
        {
          kind: 'message.append',
          idempotencyKey: `closing-${sceneId}-${currentHead(db)}`,
          payload: {
            sceneId,
            agentId: 'narrator',
            roleType: 'narrator',
            prose,
            structured: { paragraphs: narration.paragraphs, focus: narration.focus, closing: true },
            audience: [],
            percept: 'narrator_reader',
            tokenEst: estTokens(prose),
          },
        },
      );
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'scene.state',
          idempotencyKey: `close-${sceneId}-${currentHead(db)}`,
          payload: { sceneId, to: 'closed', reason: 'exit_conditions' },
        },
      );
      closeScene(branchOf(db, sceneId), `场景关闭 · ${sceneInfo.title}`);
      state = 'closed';
      break;
    }

    if (state !== 'open') break;
    if (log.length >= options.beats) break;

    const first = log.length === 0;
    const plan = planBeat(loaded.runtime, options.seed, {
      userPick: first ? options.pick : undefined,
      eligibleCards: loaded.eligibleCards,
    });
    const context = contextOf(db, sceneId, plan.speakerId, plan.isNarrator);
    const branchId = branchOf(db, sceneId);
    const beatSeq = loaded.runtime.scene.beats + 1;

    let prose: string;
    let structured: Record<string, unknown>;
    let audience: string[];
    let percept: 'public' | 'narrator_reader';
    let addressedNames: string[] = [];
    let cognition: ReturnType<typeof cognitionRows> = [];

    if (plan.isNarrator) {
      const narration = await narratorOutput(options.model, {
        kind: 'narrator',
        agentId: 'narrator',
        agentName: plan.speakerName,
        seq: beatSeq,
        seed: options.seed,
        prompt: context.prompt,
      });
      prose = narration.paragraphs.join('\n\n');
      structured = { paragraphs: narration.paragraphs, focus: narration.focus };
      audience = [];
      percept = 'narrator_reader';
    } else {
      const request = {
        kind: 'character' as const,
        agentId: plan.speakerId,
        agentName: plan.speakerName,
        seq: beatSeq,
        seed: options.seed,
        prompt: context.prompt,
      };
      let output = await characterOutput(options.model, request);
      const known = readKnownFactIds(db, branchId, plan.speakerId);
      const claims = readClaimIndex(db, branchId);
      let violations = knowledgeViolations(output, known, claims);
      if (violations.length > 0) {
        const hint = `【你不知道】${violations.map((v) => v.detail).join('；')}。删掉这些内容，只使用【你知道什么】里的事实。`;
        output = await characterOutput(options.model, request, hint);
        violations = knowledgeViolations(output, known, claims);
        if (violations.length > 0) {
          bus.submit(
            { type: 'system' },
            {
              kind: 'system.warn',
              idempotencyKey: `knowledge-${sceneId}-${beatSeq}`,
              payload: {
                code: 'knowledge_violation',
                message: violations.map((v) => v.detail).join('；'),
                sceneId,
                details: { agentId: plan.speakerId, beatSeq },
              },
            },
          );
          throw new HumanError(
            `${plan.speakerName} 连续两次越权：${violations.map((v) => v.detail).join('；')}。需要作者裁决。`,
          );
        }
        warnings.push({
          code: 'knowledge_retry',
          message: `${plan.speakerName} 第 ${beatSeq} 拍越界一次，已重写。`,
        });
      }
      const lineProse = [output.line, output.action].filter((part) => part.trim().length > 0).join('\n');
      prose = lineProse.length > 0 ? lineProse : output.thought;
      if (prose.trim().length === 0) {
        throw new ModelError(`${plan.speakerName} 第 ${beatSeq} 拍输出为空（line / action / thought 都为空）`);
      }
      structured = output as unknown as Record<string, unknown>;
      audience = buildAudience(loaded.runtime.scene.present, plan.speakerId, 'public');
      percept = 'public';
      addressedNames = namesOf(db, output.addressed_to);
      cognition = cognitionRows(db, sceneId, output, audience);
    }

    const chosen = plan.ranked.find((row) => row.id === plan.speakerName);
    const breakdown = {
      parts: chosen?.parts ?? null,
      base: chosen?.base ?? null,
      jitter: chosen?.jitter ?? null,
      score: plan.preDamp,
      damped: plan.damped,
      addressed: chosen?.addressed ?? 0,
      speakCount: chosen?.speakCount ?? 0,
      capped: chosen?.capped ?? false,
      arbitration: plan.arbitration,
      forced: plan.mode === 'forced_narrator',
      seed: options.seed,
      conflict: plan.conflictLevel,
      card: plan.card?.id ?? null,
      context: {
        tokens: context.tokens,
        budget: context.budget,
        level: context.level,
        dropped: context.dropped,
      },
      addressedTo: addressedNames,
    };

    bus.submit(
      { type: plan.isNarrator ? 'character' : 'character', id: plan.speakerId },
      {
        kind: 'beat.commit',
        idempotencyKey: `beat-${sceneId}-${beatSeq}`,
        payload: {
          sceneId,
          agentId: plan.speakerId,
          roleType: plan.isNarrator ? 'narrator' : 'character',
          mode: plan.mode,
          score: plan.preDamp,
          damped: plan.damped,
          breakdown,
          prose,
          structured,
          percept,
          audience,
          cognition,
          relations: [],
          conflictLevel: plan.conflictLevel,
          cardId: plan.card?.id,
          tokenEst: estTokens(prose),
        },
      },
    );

    tokenTotal += context.tokens;
    tokenMax = Math.max(tokenMax, context.tokens);
    log.push({
      beatSeq,
      speaker: plan.speakerName,
      mode: plan.mode,
      isNarrator: plan.isNarrator,
      tokens: context.tokens,
      level: context.level,
      card: plan.card ? loaded.cardTitles[plan.card.id] ?? plan.card.id : null,
      escalated: plan.escalated,
      prose,
    });

    // 导演事件：抽牌 / 冲突升级。它是系统动作，不是谁说的话（04 §4.1）。
    if (plan.card || plan.escalated) {
      const parts: string[] = [];
      if (plan.card) parts.push(`抽牌「${loaded.cardTitles[plan.card.id] ?? plan.card.id}」`);
      if (plan.escalated) {
        parts.push(`冲突 ${loaded.runtime.scene.conflictLevel} → ${plan.conflictLevel}`);
      }
      bus.submit(
        { type: 'director' },
        {
          kind: 'message.append',
          idempotencyKey: `director-${sceneId}-${beatSeq}`,
          payload: {
            sceneId,
            agentId: 'director',
            roleType: 'director',
            prose: parts.join(' · '),
            structured: {
              cardId: plan.card?.id ?? null,
              cardTitle: plan.card ? loaded.cardTitles[plan.card.id] ?? plan.card.id : null,
              escalated: plan.escalated,
              conflictFrom: loaded.runtime.scene.conflictLevel,
              conflictTo: plan.conflictLevel,
            },
            audience: [],
            percept: 'director',
          },
        },
      );
      if (plan.card) warnings.push({ code: 'event_card', message: `抽牌：${loaded.cardTitles[plan.card.id] ?? plan.card.id}` });
      if (plan.escalated) warnings.push({ code: 'conflict_escalated', message: `冲突升到 ${plan.conflictLevel}` });
    }

    const after = loadTheater(db, sceneId).runtime.scene;
    if (evalExit(sceneExit(db, sceneId), readSceneEvalState(db, sceneId))) {
      exitSatisfied = true;
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'scene.state',
          idempotencyKey: `closing-${sceneId}-${currentHead(db)}`,
          payload: { sceneId, to: 'closing', reason: 'exit_conditions' },
        },
      );
      continue;
    }
    if (reachedMaxBeats(after)) {
      warned = true;
      const openClues = readClues(db, branchId).map((clue) => clue.text);
      bus.submit(
        { type: 'system' },
        {
          kind: 'system.warn',
          idempotencyKey: `warn-${sceneId}-${beatSeq}`,
          payload: {
            code: 'exit_conditions_unsatisfied',
            message: `到 max_beats=${after.maxBeats} 仍未满足收束条件`,
            sceneId,
            details: { beats: after.beats, maxBeats: after.maxBeats, openClues },
          },
        },
      );
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'scene.state',
          idempotencyKey: `force-close-${sceneId}-${currentHead(db)}`,
          payload: { sceneId, to: 'closed', reason: 'max_beats_unsatisfied' },
        },
      );
      closeScene(branchId, `场景关闭（WARN）· ${sceneInfo.title}`);
      state = 'closed';
      break;
    }

    maybeCheckpoint(db, branchId, `自动检查点 · 第 ${after.beats} 拍`);
  }

  const final = loadTheater(db, sceneId).runtime.scene;
  return {
    sceneId,
    title: sceneInfo.title,
    produced: log.length,
    beats: final.beats,
    maxBeats: final.maxBeats,
    state: final.state,
    exitSatisfied,
    warned,
    log,
    tokens: { total: tokenTotal, max: tokenMax, budget: BUDGET },
    warnings,
    commit: lastCommit,
  };
}
