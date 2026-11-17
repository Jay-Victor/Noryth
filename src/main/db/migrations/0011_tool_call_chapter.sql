-- name: tool_call_chapter
-- 阶段 18（PHASE-18 §5.3，M1-23）
--
-- tool_call 审计面板要按章过滤。原先只能经 turn_metric → beat 二次跳转，
-- 而审批/记忆抽取/重建这些回合没有拍，按章过滤会漏掉它们的工具调用。
--
-- 1) chapter_id：运行时从 TurnContext 写入（可空，规划会话没有章）。
-- 2) 回填两条来源：有拍的回合走 turn_metric.beat_id → beat.chapter_id；
--    其余走 job.payload_json.chapterId（审批/抽取/重建任务都带这个字段）。
-- 3) 项目 + 时间索引：面板按项目分页，没有索引会退化成全表扫描。
--
-- 只多一个归属列；参数原文仍然只存 args_hash（PRD §4.9.7）。

ALTER TABLE tool_call ADD COLUMN chapter_id TEXT;
CREATE INDEX tool_by_project ON tool_call(project_id, created_at);
CREATE INDEX tool_by_chapter ON tool_call(project_id, chapter_id, created_at);

UPDATE tool_call
SET chapter_id = (
  SELECT b.chapter_id
  FROM turn_metric tm
  JOIN beat b ON b.id = tm.beat_id
  WHERE tm.turn_id = tool_call.turn_id
  LIMIT 1
)
WHERE chapter_id IS NULL;

UPDATE tool_call
SET chapter_id = (
  SELECT CASE WHEN json_valid(j.payload_json) THEN json_extract(j.payload_json, '$.chapterId') END
  FROM job j
  WHERE j.id = tool_call.job_id
)
WHERE chapter_id IS NULL;
