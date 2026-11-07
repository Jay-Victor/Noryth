/** 单拍：下一拍 / 为什么是它 / 回退到这一拍。 */
import {
  UsageError,
  getActiveBranch,
  readBeatHistory,
  restoreBranch,
  resolveSceneId,
  type RestoreResult,
} from '@noryth/store';
import { replayDigest, type BeatDigestEntry } from '@noryth/core';
import type { ModelPort } from '@noryth/core';
import { runSession, type SessionResult } from '../theater-session.js';
import { openProject, openProjectForWrite } from './project.js';
import { readManifest, writeManifest } from '../project-root.js';

export interface BeatNextOptions {
  dir?: string;
  scene?: string;
  seed: number;
  pick?: string;
  model: ModelPort;
}

export async function runBeatNext(options: BeatNextOptions): Promise<SessionResult> {
  const opened = openProjectForWrite(options.dir);
  try {
    return await runSession(opened.db, {
      sceneId: options.scene,
      beats: 1,
      seed: options.seed,
      mode: 'step',
      pick: options.pick,
      model: options.model,
      root: opened.root,
    });
  } finally {
    opened.close();
  }
}

export interface BeatWhy {
  sceneId: string;
  beatSeq: number;
  agentId: string;
  agentName: string;
  mode: string;
  score: number;
  damped: number;
  breakdown: Record<string, unknown>;
  prose: string;
}

export function runBeatWhy(dir: string | undefined, sceneIdArg: string | undefined, beatSeq: number): BeatWhy {
  const opened = openProject(dir);
  try {
    const sceneId = resolveSceneId(opened.db, sceneIdArg);
    const row = opened.db
      .prepare(
        `SELECT b.seq, b.agent_id, b.mode, b.score, b.damped, b.breakdown,
                COALESCE(e.name, b.agent_id) AS agent_name, m.prose
         FROM beat b
         LEFT JOIN entity e ON e.id = b.agent_id
         LEFT JOIN message m ON m.beat_id = b.id
         WHERE b.scene_id = ? AND b.seq = ?`,
      )
      .get(sceneId, beatSeq) as
      | {
          seq: number;
          agent_id: string;
          mode: string;
          score: number;
          damped: number;
          breakdown: string;
          agent_name: string;
          prose: string | null;
        }
      | undefined;
    if (!row) throw new UsageError(`第 ${beatSeq} 拍不存在于场景 ${sceneId}`);
    return {
      sceneId,
      beatSeq: row.seq,
      agentId: row.agent_id,
      agentName: row.agent_name,
      mode: row.mode,
      score: row.score,
      damped: row.damped,
      breakdown: JSON.parse(row.breakdown) as Record<string, unknown>,
      prose: row.prose ?? '',
    };
  } finally {
    opened.close();
  }
}

export interface BeatRewindResult extends RestoreResult {
  beatSeq: number;
  eventSeq: number;
}

/**
 * 回退到某一拍之后的状态：开新分支，旧分支保留。
 * 目标用 beat.breakdown.eventSeq（事件序号），而不是拍号——拍号只在场景内唯一。
 */
export function runBeatRewind(
  dir: string | undefined,
  sceneIdArg: string | undefined,
  beatSeq: number,
  label?: string,
): BeatRewindResult {
  const opened = openProjectForWrite(dir);
  try {
    const sceneId = resolveSceneId(opened.db, sceneIdArg);
    const row = opened.db
      .prepare('SELECT breakdown FROM beat WHERE scene_id = ? AND seq = ?')
      .get(sceneId, beatSeq) as { breakdown: string } | undefined;
    if (!row) throw new UsageError(`第 ${beatSeq} 拍不存在于场景 ${sceneId}`);
    const breakdown = JSON.parse(row.breakdown) as { eventSeq?: number };
    if (typeof breakdown.eventSeq !== 'number') {
      throw new UsageError(`第 ${beatSeq} 拍缺少 eventSeq，无法回退（旧版数据）`);
    }
    const branch = getActiveBranch(opened.db)!;
    if (breakdown.eventSeq <= branch.forkSeq) {
      throw new UsageError(
        `第 ${beatSeq} 拍来自父分支（fork_seq=${branch.forkSeq}），本分支没有它的事件；请用 restore --checkpoint/--seq 回退`,
      );
    }
    const head = branch.headSeq;
    const result = restoreBranch(opened.db, {
      targetSeq: breakdown.eventSeq,
      idempotencyKey: `beat-rewind-${sceneId}-${beatSeq}-${head}`,
      label: label ?? `回退到第 ${beatSeq} 拍`,
    });
    writeManifest(opened.root, { ...readManifest(opened.root), branch: result.branchName });
    return { ...result, beatSeq, eventSeq: breakdown.eventSeq };
  } finally {
    opened.close();
  }
}

/** 回退后重放一致性的证据：从第 fromSeq 拍起的决策摘要。 */
export function beatDigest(dir: string | undefined, sceneId: string, fromSeq = 1): string {
  const opened = openProject(dir);
  try {
    const entries: BeatDigestEntry[] = readBeatHistory(opened.db, sceneId, fromSeq);
    return replayDigest(entries);
  } finally {
    opened.close();
  }
}
