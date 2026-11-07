/** noryth run：剧场入口。P1 只有一个 provider（offline），真实供应商在 P3。 */
import { UsageError } from '@noryth/store';
import { OfflineModel } from '../offline-model.js';
import { runSession, type SessionResult } from '../theater-session.js';
import { openProjectForWrite } from './project.js';

export interface RunTheaterOptions {
  dir?: string;
  scene?: string;
  beats: number;
  seed: number;
  mode: 'auto' | 'step';
  pick?: string;
  offline: boolean;
}

export async function runTheater(options: RunTheaterOptions): Promise<SessionResult> {
  if (!options.offline) {
    throw new UsageError(
      'P1 只实现了离线 provider：请加 --offline（--offline 用 fixtures/beats 复演，真实供应商在 P3 接入）',
    );
  }
  if (!Number.isInteger(options.beats) || options.beats < 1) {
    throw new UsageError(`--beats 必须是正整数：${options.beats}`);
  }
  if (!Number.isInteger(options.seed)) {
    throw new UsageError(`--seed 必须是整数：${options.seed}`);
  }
  const opened = openProjectForWrite(options.dir);
  try {
    return await runSession(opened.db, {
      sceneId: options.scene,
      beats: options.mode === 'step' ? 1 : options.beats,
      seed: options.seed,
      mode: options.mode,
      pick: options.pick,
      model: OfflineModel.load(),
      root: opened.root,
    });
  } finally {
    opened.close();
  }
}

export function formatSession(result: SessionResult): string[] {
  const lines = [
    `场景 ${result.sceneId} · ${result.title}`,
    `  ${result.beats}/${result.maxBeats} 拍 · 状态 ${result.state}${result.exitSatisfied ? ' · 收束条件已满足' : ''}`,
  ];
  for (const beat of result.log) {
    const tags = [
      `${beat.mode}`,
      `${beat.tokens} tok/${beat.level}`,
      beat.card ? `抽牌「${beat.card}」` : '',
      beat.escalated ? '冲突升级' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`  第 ${beat.beatSeq} 拍  ${beat.speaker}  ${tags}`);
    const preview = beat.prose.split('\n').map((part) => part.trim()).filter(Boolean)[0] ?? '';
    if (preview.length > 0) {
      lines.push(`    ${preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}`);
    }
  }
  if (result.warned) {
    lines.push('  ! exit_conditions_unsatisfied：到 max_beats 仍未收束，已写 WARN 并关闭（未静默截断）');
  }
  for (const warning of result.warnings) {
    if (warning.code === 'event_card' || warning.code === 'conflict_escalated') continue;
    lines.push(`  ! ${warning.message}`);
  }
  lines.push(
    `  上下文  累计 ${result.tokens.total} tok · 单拍最高 ${result.tokens.max} / 预算 ${result.tokens.budget}`,
  );
  if (result.commit) {
    lines.push(`  Git      ${result.commit.slice(0, 7)} · .noryth/state.json.zst 已提交`);
  }
  return lines;
}
