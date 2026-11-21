-- name: cost
-- 阶段 20（PHASE-20 §5.4，M2-3 / M2-5）
--
-- chapter.budget_cny：章级人民币预算；NULL = 默认 ¥5.00，与 budget_tokens 任一超限都暂停。
-- turn_metric.chapter_id：每次模型调用归因到章；规划（项目级）为 NULL。
-- 不设外键：删章后历史费用仍保留做审计，报表对已删除章显示「已删除章」。
-- 回填只覆盖已有 beat 行；规划/审批/记忆行从本阶段起才有 chapter_id。

ALTER TABLE chapter ADD COLUMN budget_cny REAL
  CHECK (budget_cny IS NULL OR budget_cny >= 0);

ALTER TABLE turn_metric ADD COLUMN chapter_id TEXT;

UPDATE turn_metric
   SET chapter_id = (SELECT beat.chapter_id FROM beat WHERE beat.id = turn_metric.beat_id)
 WHERE chapter_id IS NULL AND beat_id IS NOT NULL;

CREATE INDEX turn_metric_by_chapter
  ON turn_metric(project_id, chapter_id, created_at);

CREATE INDEX turn_metric_by_agent
  ON turn_metric(project_id, agent_key, created_at);
