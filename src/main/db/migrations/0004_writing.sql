-- name: writing
-- 0004_writing.sql：创作台（PHASE-07 F1–F7）
-- - 分镜草案独立表：G2 之前只改草案，不碰 scene/beat；G2 通过才物化
-- - scene.max_beats：场景拍数上限（DEV-PLAN §8.2 / §8.5）
-- - chapter.budget_tokens：章预算（空 = 用默认值），自动模式超预算即暂停
-- - 编排对话：chapter_id 上的一问一答，只讨论分镜与出口，不写正文
-- - 调度器事件：暂停原因与出口判定结果需要可恢复（重启后 banner 仍在）

CREATE TABLE storyboard_draft (
  chapter_id   TEXT PRIMARY KEY REFERENCES chapter(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  rev          INTEGER NOT NULL DEFAULT 1,
  scenes_json  TEXT NOT NULL,
  updated_by   TEXT NOT NULL CHECK (updated_by IN ('author','orchestrator')),
  updated_at   TEXT NOT NULL
);
CREATE INDEX storyboard_draft_by_project ON storyboard_draft(project_id);

ALTER TABLE scene ADD COLUMN max_beats INTEGER NOT NULL DEFAULT 40;
ALTER TABLE chapter ADD COLUMN budget_tokens INTEGER;

CREATE TABLE write_message (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id  TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('author','orchestrator','system')),
  kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','storyboard','pause','refusal')),
  body        TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX write_message_by_chapter ON write_message(chapter_id, created_at);

CREATE TABLE scheduler_event (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id  TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  job_id      TEXT,
  kind        TEXT NOT NULL CHECK (kind IN (
                'started','beat_committed','beat_confirmed','paused','resumed',
                'scene_closed','chapter_complete','stopped')),
  reason      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX scheduler_event_by_chapter ON scheduler_event(chapter_id, created_at);
