-- name: voice
-- 阶段 19（PHASE-19 §5.4，M2-1 / M2-2）
--
-- voice_metric 是派生数据：每场 + 每个 revision 一行，缓存逐角色与两两指标。
-- 只由 voice/service 写；删场景/章时级联清理，不碰 revision 与正文。
-- 同一 (scene_id, revision_id) 只保留一行：重算覆盖，不追加历史。

CREATE TABLE voice_metric (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id        TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id          TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  revision_id       TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  metrics_json      TEXT NOT NULL,
  threshold_version TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (scene_id, revision_id)
);

CREATE INDEX voice_metric_by_chapter
  ON voice_metric(project_id, chapter_id, created_at);
