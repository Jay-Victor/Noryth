import type { Db } from './db.js';
import { getActiveBranch, getProject } from './project.js';

export interface StatusScene {
  id: string;
  title: string;
  state: string;
  beats: number;
  maxBeats: number;
  conflictLevel: number;
}

export interface StatusSummary {
  project: { id: string; name: string; schemaVersion: number };
  branch: { id: string; name: string; headSeq: number };
  scene: StatusScene | null;
  chapters: { count: number; words: number };
  openClues: number;
}

/**
 * 一次 status 只读，不触发迁移、不写事件。
 * 场景优先取活动指针，其次取最近一个未关闭场景。
 */
export function readStatus(db: Db): StatusSummary {
  const project = getProject(db);
  const branch = getActiveBranch(db);
  if (!project || !branch) {
    throw new Error('项目未初始化：project / branch 缺失');
  }

  const pointer = db
    .prepare('SELECT active_scene_id FROM project_state WHERE project_id = ?')
    .get(project.id) as { active_scene_id: string | null } | undefined;

  const sceneRow = (
    pointer?.active_scene_id
      ? db
          .prepare(
            `SELECT id, title, state, beats, max_beats, conflict_level
             FROM scene WHERE id = ?`,
          )
          .get(pointer.active_scene_id)
      : db
          .prepare(
            `SELECT id, title, state, beats, max_beats, conflict_level
             FROM scene WHERE branch_id = ? AND state IN ('open','paused','closing')
             ORDER BY idx DESC LIMIT 1`,
          )
          .get(branch.id)
  ) as
    | {
        id: string;
        title: string;
        state: string;
        beats: number;
        max_beats: number;
        conflict_level: number;
      }
    | undefined;

  const chapterRow = db
    .prepare(
      `SELECT count(*) AS count, COALESCE(sum(word_count), 0) AS words
       FROM chapter WHERE branch_id = ?`,
    )
    .get(branch.id) as { count: number; words: number };

  const clueRow = db
    .prepare('SELECT count(*) AS count FROM v_open_clue WHERE branch_id = ?')
    .get(branch.id) as { count: number };

  return {
    project: { id: project.id, name: project.name, schemaVersion: project.schemaVersion },
    branch: { id: branch.id, name: branch.name, headSeq: branch.headSeq },
    scene: sceneRow
      ? {
          id: sceneRow.id,
          title: sceneRow.title,
          state: sceneRow.state,
          beats: sceneRow.beats,
          maxBeats: sceneRow.max_beats,
          conflictLevel: sceneRow.conflict_level,
        }
      : null,
    chapters: { count: chapterRow.count, words: chapterRow.words },
    openClues: clueRow.count,
  };
}
