-- name: blueprint_ops
-- 阶段 15（PHASE-15 §5.4，M1-8 / M1-10 / M1-11）
--
-- 1) outline_node.meta_json：覆盖检查唯一的结构化输入（key_events / character_ids /
--    pov_character_id / mainline）。旧行默认 '{}'，迁移后不阻断任何老项目。
-- 2) chapter.invalidated_at / invalidated_reason：蓝图变更后的「跨章标脏」。
--    只标记、不改章状态、不改正文；作者可忽略。
-- 3) foreshadow：作者手写的伏笔（不做自动语义识别，M2）。
-- 4) blueprint_change：G1 后每次蓝图变更一行，ops + impact 可追溯。

ALTER TABLE outline_node ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE chapter ADD COLUMN invalidated_at TEXT;
ALTER TABLE chapter ADD COLUMN invalidated_reason TEXT;

CREATE TABLE foreshadow (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  text                    TEXT NOT NULL,
  planted_chapter_id      TEXT REFERENCES chapter(id),
  planned_payoff_chapter_id TEXT REFERENCES chapter(id),
  payoff_chapter_id       TEXT REFERENCES chapter(id),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX foreshadow_by_status ON foreshadow(project_id, status);

CREATE TABLE blueprint_change (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id TEXT,
  ops_json    TEXT NOT NULL,
  impact_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected')),
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  applied_at  TEXT
);
CREATE INDEX blueprint_change_by_project ON blueprint_change(project_id, created_at);
