/** 场景管理：建场 / 列出 / 打开 / 关闭。P1 的唯一内容入口是 scene create。 */
import type { Db } from '@noryth/store';
import {
  CommandBus,
  UsageError,
  createCheckpointWithSnapshot,
  getActiveBranch,
  listScenes,
} from '@noryth/store';
import { PARAMS } from '@noryth/core';
import { openProject, openProjectForWrite } from './project.js';
import { commitSceneClose } from '../state-export.js';

export interface SceneCreateOptions {
  dir?: string;
  title: string;
  cast: string[];
  present?: string[];
  goal?: string;
  situation?: string;
  storyStart?: string;
  timeline?: string;
  location?: string;
  conflict?: number;
  maxBeats?: number;
  exit?: unknown;
  cards?: unknown;
}

export interface SceneCreateResult {
  sceneId: string;
  title: string;
  idx: number;
  cast: string[];
  present: string[];
  cards: number;
}

function head(db: Db): number {
  return getActiveBranch(db)!.headSeq;
}

/**
 * --cast 的语法：`名字` 或 `名字:goalRel:initiative:secret`。
 * 例：`林砚:1:0.9,沈昼:1:0.6,祁昭:0:0.3`。
 * goalRel 是场景开启时写死的目标相关度（0 / 0.5 / 1），不参与拍内变化。
 */
function parseCast(raw: string): {
  name: string;
  goalRel?: number;
  initiative?: number;
  secretThreat?: boolean;
} {
  const [name, goal, initiative, secret] = raw.split(':').map((part) => part.trim());
  if (!name) throw new UsageError(`--cast 有空名字：${raw}`);
  const read = (value: string | undefined, field: string): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new UsageError(`--cast ${name} 的 ${field} 必须是 0–1：${value}`);
    }
    return number;
  };
  if (secret !== undefined && secret !== '' && secret !== '0' && secret !== '1') {
    throw new UsageError(`--cast ${name} 的 secret 只能是 0 或 1：${secret}`);
  }
  return {
    name,
    goalRel: read(goal, 'goalRel'),
    initiative: read(initiative, 'initiative'),
    secretThreat: secret === '1',
  };
}

export function runSceneCreate(options: SceneCreateOptions): SceneCreateResult {
  const opened = openProjectForWrite(options.dir);
  try {
    const cast = options.cast.map((name) => name.trim()).filter(Boolean);
    if (cast.length === 0) throw new UsageError('scene create 至少需要一个 --cast 角色');
    const members = cast.map(parseCast);
    const maxBeats = options.maxBeats ?? PARAMS['scene.max_beats'];
    const exit =
      options.exit ?? ({ op: 'beats', cmp: '>=', value: maxBeats } as const);
    const bus = new CommandBus(opened.db);
    const result = bus.submit<{
      sceneId: string;
      idx: number;
      present: string[];
      cast: { entityId: string; name: string }[];
      cards: string[];
    }>(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.create',
        idempotencyKey: `scene-${options.title}-${head(opened.db)}`,
        payload: {
          title: options.title,
          cast: members.map((member) => ({
            name: member.name,
            ...(member.goalRel !== undefined ? { goalRel: member.goalRel } : {}),
            ...(member.initiative !== undefined ? { initiative: member.initiative } : {}),
            ...(member.secretThreat ? { secretThreat: true } : {}),
          })),
          present: options.present && options.present.length > 0 ? options.present : members.map((m) => m.name),
          location: options.location,
          storyStart: options.storyStart ?? '第01天',
          timeline: options.timeline ?? 'main',
          goal: options.goal ?? '推进这一场',
          situation: options.situation ?? '',
          conflictLevel: options.conflict ?? 1,
          maxBeats,
          exitConditions: exit,
          cards: options.cards ?? [],
        },
      },
    );
    return {
      sceneId: result.result.sceneId,
      title: options.title,
      idx: result.result.idx,
      cast: result.result.cast.map((member) => member.name),
      present: result.result.present.map(
        (id) =>
          result.result.cast.find((member) => member.entityId === id)?.name ?? id,
      ),
      cards: result.result.cards.length,
    };
  } finally {
    opened.close();
  }
}

export function runSceneList(dir?: string): ReturnType<typeof listScenes> {
  const opened = openProject(dir);
  try {
    return listScenes(opened.db);
  } finally {
    opened.close();
  }
}

export function runSceneOpen(dir: string | undefined, sceneId: string): string {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.state',
        idempotencyKey: `cli-open-${sceneId}-${head(opened.db)}`,
        payload: { sceneId, to: 'open', reason: 'cli' },
      },
    );
    createCheckpointWithSnapshot(opened.db, {
      branchId: getActiveBranch(opened.db)!.id,
      seq: head(opened.db),
      label: `场景开启 · ${sceneId}`,
      trigger: 'auto',
    });
    return sceneId;
  } finally {
    opened.close();
  }
}

export interface SceneCloseResult {
  sceneId: string;
  commit: string | null;
  packagePath: string | null;
  error: string | null;
}

export function runSceneClose(dir: string | undefined, sceneId: string): SceneCloseResult {
  const opened = openProjectForWrite(dir);
  try {
    const title = (
      opened.db.prepare('SELECT title FROM scene WHERE id = ?').get(sceneId) as
        | { title: string }
        | undefined
    )?.title;
    if (!title) throw new UsageError(`场景不存在：${sceneId}`);
    const bus = new CommandBus(opened.db);
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.state',
        idempotencyKey: `cli-close-${sceneId}-${head(opened.db)}`,
        payload: { sceneId, to: 'closed', reason: 'cli' },
      },
    );
    const checkpoint = createCheckpointWithSnapshot(opened.db, {
      branchId: getActiveBranch(opened.db)!.id,
      seq: head(opened.db),
      label: `场景关闭 · ${title}`,
      trigger: 'scene_close',
    });
    return {
      sceneId,
      ...commitSceneClose(opened.root, opened.db, title, checkpoint.checkpointId),
    };
  } finally {
    opened.close();
  }
}

export function formatSceneList(rows: ReturnType<typeof listScenes>): string[] {
  if (rows.length === 0) return ['（还没有场景）'];
  return rows.map(
    (row) =>
      `${String(row.idx).padStart(2, '0')}  ${row.id}  ${row.title}  ${row.state}  ${row.beats}/${row.maxBeats} 拍  · ${row.timeline}`,
  );
}
