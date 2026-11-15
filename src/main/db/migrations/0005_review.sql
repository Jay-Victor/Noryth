-- name: review
-- 0005_review.sql：审批台（PHASE-08 G1–G5）
-- - approval_report.scope_json：复检只跑受影响维度（DEV-PLAN §9.7）；空数组 = 全量报告
-- - review_message：审批台对话与轮次记录；讨论阶段不改稿，消息与创作台分开，
--   避免编排对话与审批讨论混在一条流里（UI-DESIGN §6.3）

ALTER TABLE approval_report ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE review_message (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL DEFAULT 0,
  role       TEXT NOT NULL CHECK (role IN ('author','reviewer','system')),
  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','report','patch','pause')),
  body       TEXT NOT NULL DEFAULT '',
  meta_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX review_message_by_chapter ON review_message(chapter_id, created_at);
