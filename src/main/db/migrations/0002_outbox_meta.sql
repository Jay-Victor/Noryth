-- name: outbox_meta
-- 0002_outbox_meta.sql：outbox 增加发布定位与退避字段（PHASE-02 B4 / DEV-PLAN §5.8）。
-- 0001 已应用的项目通过本迁移升级；不修改 0001。
-- chapter_id / revision_id 让崩溃恢复能按行重渲染，而不是猜文件名。

ALTER TABLE outbox ADD COLUMN chapter_id TEXT REFERENCES chapter(id) ON DELETE CASCADE;
ALTER TABLE outbox ADD COLUMN revision_id TEXT REFERENCES revision(id);
ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;

CREATE INDEX outbox_pending ON outbox(project_id, created_at) WHERE published_at IS NULL;
CREATE INDEX outbox_by_chapter ON outbox(chapter_id, created_at);
