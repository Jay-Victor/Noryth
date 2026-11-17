# 阶段 20 · 预算化自动模式与成本报表

> 阶段 20 / 24（M2 第 2 阶段）｜ 依赖：19 ｜ 下游：21–24
> 对应：`docs/DEV-PLAN.md` §12.6（M2-3、M2-5）、`docs/PRD.md` §9.3（按章预算）、§11（每万字成本）
>
> **一句话目标**：让自动模式在作者给的费用上限内跑完一场并正确收束，同时把每一笔模型费用归因到章与 Agent。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 章预算同时支持 token 与人民币，任一超限都暂停 | 固定 usage 的假模型跑到第 N 拍暂停；`job.result_json.budget` 有两套数字 |
| 2 | 出口优先于预算：最后一拍满足出口时场景正常关闭 | 预算刚好够出口拍 → `closed` 而不是 `paused` |
| 3 | 开跑前的费用是区间，不是假精确值 | 预检返回 low/mid/high 与样本量；无计价时只给 token |
| 4 | 每次模型调用都能归因到章或明确标为项目级 | `turn_metric.chapter_id` 覆盖写拍/审批/记忆/讨论；规划为 NULL |
| 5 | 报表合计与 DB 一致，可按章/Agent 看每万字成本 | `COST-M2-01` 对账；UI 数字与 IPC 逐项一致 |
| 6 | 预算停不会丢已确认拍，恢复后能继续 | 暂停/恢复集成测试；已确认拍 body 逐字不变 |

## 2 范围

### 2.1 做

- M2-3：章级人民币预算 `chapter.budget_cny` + 费用预测 + 自动模式预算暂停/恢复 + 状态栏预算段。
- M2-5：`turn_metric.chapter_id` + 全链路模型调用计量 + `report.cost` IPC + `CostReportDialog`。
- 迁移 `0013_cost.sql`：`chapter.budget_cny`、`turn_metric.chapter_id`、两个报表索引。
- 成本基线 `docs/M2-COST-BASELINE.md`：30 章 / 10 万字夹具的总费用、每万字成本、按 Agent 占比；注明假模型计价。
- 预算与报表共用同一份 `chapterBudget()` 与 `sumByChapter()`，不出现两套口径。

### 2.2 不做

- 不做供应商账单对账、汇率换算、发票导出；费用是本地估算，以供应商 `usage` 为准。
- 不做匿名遥测、不上传成本数据；报表只在本地。
- 不做「超预算自动换便宜模型」——降级/切换是 M2-4 的显式策略，不在本阶段偷偷做。
- 不阻断手动逐拍生成；手动模式超预算只提示，自动模式才暂停。
- 不做按场预算、按项目预算、跨项目汇总；本阶段只到章。
- 不引入图表库；报表用表格与简单条形，虚拟列表复用现有组件。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 预算口径 | `src/shared/domain/budget.ts`、`src/main/scheduler/loop.ts` | `chapterBudget()` 同时返回 token/费用；出口优先 |
| 预测 | `src/main/scheduler/forecast.ts` | 纯函数；最近 5 拍中位数；无随机 |
| 预算编辑 | `src/renderer/app/CostReportDialog.tsx` | 章预算可改；状态栏可点开；非法值拒绝 |
| 计量 | `src/main/model/usage.ts`、`src/main/agents/turn.ts`、`src/main/review/run.ts`、`src/main/memory/extract.ts`、`src/main/plan/runtime.ts` | 所有模型调用有一行 `turn_metric` |
| 迁移 | `src/main/db/migrations/0013_cost.sql` | 回填 beat 行；`LATEST_SCHEMA_VERSION = 13` |
| 报表服务 | `src/main/report/cost.ts` | 按章/Agent 聚合；字数、每万字、P50/P95 |
| 报表 UI | `src/renderer/app/CostReportDialog.tsx` | 两个 tab；空态；无计价标记 |
| 测试 | `tests/unit/scheduler/forecast.test.ts`、`tests/unit/report/cost.test.ts`、`tests/integration/budget.spec.ts`、`tests/e2e/budget.spec.ts`、`tests/e2e/cost.spec.ts` | `E2E-M2-BUDGET-01`、`E2E-M2-COST-01` |
| 基线 | `docs/M2-COST-BASELINE.md` | 总费用、每万字、按 Agent；口径与局限 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M2-3 | 预算化自动模式 + 费用预测 | F6、B3 | 双预算；出口优先；暂停/恢复不丢拍 |
| M2-5 | 成本/耗时报表（按章/Agent） | M2-3、B3 | 对账一致；每万字；项目级单列 |
| 0013 迁移 | 预算列 + 归属列 + 索引 | B1 | 旧库升级；beat 行回填 |
| 全链路计量 | 规划/审批/记忆/讨论 | D1、G1、H3 | 无未计量的模型调用 |
| 报表 UI | 状态栏 → 对话框 | A3、A4、M2-5 | 数字与 IPC 一致；无截断 |
| 成本基线 | 10 万字夹具 | 全部 | 有可复跑数字与局限说明 |

## 5 实现要点

### 5.1 预算口径

- `chapter.budget_tokens` 保留（默认 120k）；新增 `chapter.budget_cny`（可空，空 = 默认 ¥5.00）。两者任一超限都算 `budget_exceeded`。
- `chapterBudget(repos, chapter)` 返回：

```ts
type ChapterBudget = {
  tokensUsed: number
  tokensLimit: number
  costUsed: number
  costLimit: number
  pricedCalls: number
  unpricedCalls: number
  exceeded: boolean
  reason: 'tokens' | 'cost' | 'both' | null
}
```

- 费用合计只加 `turn_metric.cost_cny` 非空的行；有调用但无计价时 `unpricedCalls > 0`，UI 显示「费用为下限」，不把未知当 0。
- 章预算口径 = 本章所有已计量调用（拍 + 审批 + 记忆 + 讨论，`chapter_id` 命中）；预检只估接下来的拍，不把未来的审批/记忆费用算进去；UI 分开显示「已花」与「预计本场」。
- 判定顺序保持 `exit → max_beats → budget`：出口满足时先关场景，哪怕预算刚好到线；预算在出口前到线才暂停。这是「预算内跑完一场并正确收束」的关键。
- 预算检查在每拍落盘后、下一拍发牌前；不重生成已确认拍；不因预算回滚已落盘正文。
- 暂停写 `job.status='paused'`、`scheduler_event.reason='budget_exceeded'`；`job.result_json.budget` 记录两套 limit/used/reason，供 E2E 与验收报告引用。
- 恢复：作者提高预算后 `write.resume`；续跑前重算预算与出口，`expected_revision` 仍生效。

### 5.2 费用预测

```
remainingBeats = maxBeats - beatsGenerated
perBeatTokens = median(最近 5 拍 tokens_in + tokens_out)（不足 5 拍用 900）
perBeatCost   = median(最近 5 拍 cost_cny)（无计价则 null）
range         = 0.7 × mid .. 1.3 × mid
```

- 输出 `{beats, tokens:{low,mid,high}, cost:{low,mid,high}|null, basis:'recent'|'default', sampleSize}`；不在 UI 写「预计 ¥x.xx 精确值」。
- 预检只估自动模式的拍；审批/记忆/导出不在其中，UI 明确写「不含审批与记忆费用」。
- 切换模型后预检重算；运行中不换绑定（沿用 M0/M1 快照）。
- 预测是纯函数，同一输入两次相等；测试固定最近 5 拍与空历史两种路径。

### 5.3 全链路计量

现状：`turn_metric` 只在 `agents/turn.ts` 的写拍路径写入；审批、记忆、讨论的 usage 没有统一落库（规划消息只在 `meta_json` 存了 token，未写 `turn_metric`），无法按章聚合。本阶段统一：

| 入口 | `agent_key` | `chapter_id` | `beat_id` |
|---|---|---|---|
| `agents/turn.ts` | 实际角色/旁白 | 拍所属章 | 拍 id |
| `review/run.ts` | `reviewer` | 被审章 | NULL |
| `review/service.ts` 讨论 | `reviewer` | 当前章 | NULL |
| `memory/extract.ts` | `memory` | 来源章 | NULL |
| `memory/service.ts` 讨论 | `memory` | 当前章 | NULL |
| `plan/runtime.ts` | `planner` | NULL（项目级） | NULL |

- 统一走 `recordTurnMetric()`；`turn_id` 对一次调用稳定，重试/重放用 upsert，不产生第二行。
- 非写拍调用的 `context_json` 只存 `{kind:'review'|'memory'|'plan', prompt_version, toolset_version, block_tokens}`，不存提示词全文或正文。
- `read` 类工具调用不写 `turn_metric`；只有真正调用模型的回合写。
- `sumByChapter()` 改为 `WHERE chapter_id = ?`；旧的 `beat` join 只用于回填，不再作为运行时口径。
- 报表的「项目级」桶收纳 `chapter_id IS NULL` 的规划费用；不强行摊到章，避免假归因。

### 5.4 迁移 0013

```sql
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
```

- `chapter_id` 不设外键：删除章后历史费用仍要保留做审计；报表对已删除章显示 `已删除章`。
- 回填只覆盖已有 beat 行；规划/审批/记忆行从本阶段起才有。
- 旧项目升级后 `budget_cny` 为 NULL，按默认 ¥5.00；不改既有 token 预算。
- `LATEST_SCHEMA_VERSION = 13`；迁移测试覆盖「旧库有 beat 指标 → 升级后 chapter_id 正确」。

### 5.5 成本报表

`report.cost` 输入 `{chapterId?, from?, to?}`，输出：

```ts
type CostReport = {
  total: { tokensIn; tokensOut; costCny; pricedCalls; unpricedCalls; words; costPer10k: number | null }
  byChapter: Array<{ chapterId; ord; title; words; tokensIn; tokensOut; costCny; costPer10k; calls; latencyP50; latencyP95 }>
  byAgent: Array<{ agentKey; label; tokensIn; tokensOut; costCny; calls; share; latencyP50; latencyP95 }>
  projectLevel: { tokensIn; tokensOut; costCny; calls }
  generatedAt: string
}
```

- 字数：定稿章取 final revision 清单的 `beat.word_count` 合计；草稿章取 current revision；没有 revision 的章计 0，不读 live 拍。`byChapter.title` 取 `outline_node.title`，不把正文读进报表。
- `costPer10k = costCny / words × 10000`；`words=0` 时为 null，不显示 `0`。
- `share = agent cost / total cost`（仅在有计价时）；无计价时按 token 占比展示，并标「按 token」。
- P50/P95 用线性插值或最近秩，口径写进报告脚注；样本 <5 时只显示中位数。
- 「每拍确认耗时」从 `scheduler_event` 推导：同一 `beatId` 的 `beat_committed` → `beat_confirmed` 的时间差；只统计 `decided_by='author'` 的拍，自动确认不计入。没有事件对的拍计为缺失，不补 0。
- 「每千字作者净操作时间」需要点击/输入/切页的客户端交互埋点；M2-5 不新增通用埋点，只在阶段 24 内测用秒表记录 100k 项目的基线，写进验收报告的「未自动化」项。PRD M2 四条不依赖该指标，不用它替代每万字成本。
- 查询一次聚合，不在循环里查章标题；100 行以上用 `VirtualList`。`COST-M2-01` 断言 IPC 结果与直接 SQL 汇总一致。
- UI：状态栏「章预算 ¥0.84 / ¥5.00」可点；对话框含「本章 / 全书」范围、按章/按 Agent 两个 tab、预算编辑与「费用为下限」提示；不新增页面。
- `report.cost` 是只读 IPC：新增 `shared/schema/cost.ts` 的视图 schema 与 preload 命名空间；不改工具 manifest、不改闸门语义。`CostReportDialog` 只通过它取数，不直接 `window.noryth` 之外的通道。

### 5.6 成本基线

`docs/M2-COST-BASELINE.md` 记录：

- 夹具：30 章 / 10 万字 / 5 角色 / 3k 记忆；假模型固定 usage 与预设计价。
- 总费用、每万字成本、按 Agent 占比、按章分布、项目级规划费用。
- 与真实 API 的差异：假模型 usage 固定，真实费用以供应商账单为准；不把基线当报价。
- 阶段 24 的 100k E2E 复用同一报表，数字更新到 M2 验收报告。

## 6 验收清单

- [ ] 0013 迁移：`chapter.budget_cny`、`turn_metric.chapter_id`、两个索引存在；beat 指标回填正确；`db.verify()` 绿；`LATEST_SCHEMA_VERSION = 13`（`tests/unit/migrator.test.ts`）。
- [ ] 双预算：token 超限与费用超限分别触发 `budget_exceeded`；`reason` 正确；`job.result_json.budget` 有两套数字（`tests/unit/scheduler/forecast.test.ts`、`tests/integration/budget.spec.ts`）。
- [ ] 出口优先：预算刚好够出口拍时场景 `closed`，不是 `paused`（`tests/integration/budget.spec.ts`）。
- [ ] 预测：最近 5 拍中位数、区间 0.7–1.3、样本不足回落 900、无计价返回 null；两次调用相等。
- [ ] `E2E-M2-BUDGET-01`：自动模式开到预算上限 → 暂停横幅显示原因与数字 → 提高预算恢复 → 已完成拍逐字不变 → 出口满足后关闭。
- [ ] 全链路计量：写拍/审批/记忆/讨论/规划各写一行；重试 upsert 不重复；`chapter_id` 归属正确，规划为 NULL（`tests/integration/usage.spec.ts`）。
- [ ] `E2E-M2-COST-01`：状态栏打开报表 → 按章/按 Agent 数字与 `report.cost` 一致 → 每万字成本与字数口径一致 → 无计价显示「下限」→ 空项目空态。
- [ ] 每拍确认耗时来自 `scheduler_event`（作者确认才计入，自动确认排除）；每千字净操作时间在阶段 24 内测用秒表记录，不伪造自动化埋点。
- [ ] `COST-M2-01`：报表合计 = `turn_metric` 直接汇总；`byChapter + projectLevel = total`；无 N+1（查询计数断言）。
- [ ] 手动模式超预算只提示、不暂停；自动模式才暂停（`tests/e2e/budget.spec.ts`）。
- [ ] 门禁：typecheck / lint / depcruise / unit / integration / e2e / build / gen:check。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 计价缺失 | 预设没有价格或供应商不返回 usage | 只按 token 预算；费用显示「未知/下限」；不伪造 0 |
| 费用口径漂移 | 报表与状态栏各算一套 | 只保留 `chapterBudget()` 与 `sumByChapter()` 两个入口，其他调用复用 |
| 重试双计 | 同一 turn 重试写两行 | `turn_id` upsert；报表按 turn 去重 |
| 预算卡死收束 | 最后一拍因预算不发牌 | 判定顺序 exit 优先；测试覆盖「预算刚好够出口」 |
| 报表拖慢 UI | 30 章全量查询 | 一次聚合 + 索引 + 虚拟列表；阶段 23 复测 |
| 假 usage 过于乐观 | 基线费用偏低 | 文档写明假模型口径；真实账单另行抽样，不改基线结论 |

## 8 进入下一阶段的条件

1. 0013 迁移与回填全绿；旧项目可打开。
2. 双预算生效，出口优先，暂停/恢复不丢已确认拍。
3. 每次模型调用都有 `turn_metric`；报表合计与 DB 一致。
4. `E2E-M2-BUDGET-01`、`E2E-M2-COST-01` 通过。
5. 成本基线报告有可复跑命令与实际数字。
