# 阶段 22 · 记忆归档与上下文成本优化

> 阶段 22 / 24（M2 第 4 阶段）｜ 依赖：20、21 ｜ 下游：23–24
> 对应：`docs/DEV-PLAN.md` §12.6（M2-7、M2-9）、`docs/PRD.md` §5.4（归档）、§9.3（前缀缓存与上下文预算）
>
> **一句话目标**：只归档非事实类的冗余记忆，同时把每拍上下文成本降下来，且不让正文质量与 grounding 退化。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 归档只碰非事实类 | 只有 `kind='experience'` 的低重要度重复条目进入候选；fact/relationship/cognition/pinned 永不自动归档 |
| 2 | 归档是软失效，不物理删除 | `archived_at` + 审计；检索排除；可恢复；矢量行仍保留 |
| 3 | 候选可解释、可确认 | 每条候选有 keeper、相似度、原因；作者勾选后 `author_confirm` 执行 |
| 4 | 归档不影响正文与 trace | 不建 revision、不改 `beat.body`、不写 outbox |
| 5 | 上下文成本有可复跑的下降 | 同一 30 章夹具，单拍 `tokens_in` 中位数下降 ≥15% |
| 6 | 缓存命中可观测 | 供应商返回 cache 字段时写 `cached_tokens`；不返回时为 NULL，不伪造 0 |

## 2 范围

### 2.1 做

- M2-7：记忆台「维护 → 归档候选」；确定性候选规则、勾选、`author_confirm`、执行、恢复、已归档过滤。
- M2-7：迁移 `0014_archive_context.sql`：`memory_entry.archived_at / archive_reason`、`turn_metric.cached_tokens`、`memory_audit` 动作扩展、归档索引。
- M2-9：上下文去重与稳定前缀、摘要压缩、L3 旁观者裁剪、提示词去重；以 `tokens_in` 中位数与缓存命中衡量。
- M2-9：`ChatUsage.cachedTokens` 解析（OpenAI `prompt_tokens_details.cached_tokens`、DeepSeek `prompt_cache_hit_tokens`），写 `turn_metric.cached_tokens`。
- 基线 `docs/M2-CONTEXT-COST.md`：优化前后按层 token、单拍成本、缓存命中、样本与局限。

### 2.2 不做

- 不做模型语义去重、不做自动归档事实/关系/认知/pinned、不做物理删除。
- 不做模型摘要（章末摘要仍是抽取式）；不换嵌入模型；不做 embedding 维度变更。
- 不为省 token 裁角色卡核心、禁揭清单、本拍意图；不降低 grounding 校验。
- 不做分支合并、项目模板、自动补旁白建议。
- 不把「压缩」做成静默丢内容：所有裁剪仍走 `context_json.trimmed`，UI 可查。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 归档服务 | `src/main/memory/archive.ts` | 候选规则、keeper、批量执行、恢复、审计 |
| 单一写入者 | `src/main/memory/apply.ts` | `archiveEntries` 在 MemoryExecutor 事务内写 |
| 迁移 | `src/main/db/migrations/0014_archive_context.sql` | 列、索引、`memory_audit` 动作；`LATEST_SCHEMA_VERSION = 14` |
| 检索过滤 | `src/main/memory/retrieve.ts`、`src/main/db/repos/memory.ts` | 默认排除 archived；pinned 同口径 |
| 记忆台 UI | `src/renderer/pages/memory/MemoryArchivePanel.tsx`、`MemoryBrowser.tsx` | 候选 / 已归档 / 恢复；不显示正文外的秘密 |
| 上下文优化 | `src/main/context/assemble.ts`、`src/main/context/budget.ts`、`src/main/agents/prompts/**` | 去重、稳定前缀、摘要压缩、提示词去重 |
| 缓存指标 | `src/main/model/openai-compat.ts`、`src/main/model/usage.ts`、`src/main/db/repos/model.ts` | 可选 cached tokens；NULL 语义正确 |
| 测试 | `tests/unit/memory/archive.test.ts`、`tests/unit/context/cost.test.ts`、`tests/e2e/archive.spec.ts`、`tests/e2e/context-cost.spec.ts` | `E2E-M2-ARCHIVE-01`、`COST-M2-02` |
| 基线 | `docs/M2-CONTEXT-COST.md` | 优化前后数字、方法、局限 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M2-7 | 归档候选与执行 | H3、M1-4 | 只 experience；软失效；可恢复；审计 |
| M2-9 | 上下文成本优化 | M2-5、D3 | tokens_in 中位数降 ≥15%；质量回归绿 |
| 0014 迁移 | 归档列 + 缓存列 + 审计动作 | B1、H3 | 旧库升级；`db.verify()` 绿 |
| 检索口径 | archived 过滤 | H3、M2-7 | 检索/ pinned/计数一致；审计仍可见 |
| 缓存解析 | cached tokens | D1、M2-5 | 有则记录；无则 NULL；报表可读 |
| 基线 | 前后对比 | 全部 | 有数字、有样本、有局限 |

## 5 实现要点

### 5.1 归档候选（只碰非事实类）

候选必须同时满足：

1. `kind='experience'`；`fact` / `relationship` / `cognition` 一律不进入候选。
2. `status='active'`、`archived_at IS NULL`、`pinned=0`、`importance <= 0.3`。
3. 没有被有效世界事实或关系边引用：`world_fact.source_type='memory' AND source_id=entry.id AND valid_to_seq IS NULL`、`relationship_edge.source_type='memory' AND source_id=entry.id AND valid_to_seq IS NULL` 均为空。
4. 同一角色内存在「keeper」：文本完全相等（NFKC + 去空白）或同一 `embedding_model` 的向量余弦 ≥0.92；keeper 的 `importance` 不低于候选（相同则取更新 `learned_seq`）。不同 embedding 模型不混算余弦，只做文本相等判断。
5. 不是待决策提案的来源：`memory_proposal_item.decision='pending'` 的来源条目不归档。

- 每批最多 50 条；按 `(character_id, learned_seq)` 排序，保证确定性。
- 候选输出 `{id, characterId, text, importance, learnedSeq, keeperId, similarity, reason}`；`reason` 固定为 `duplicate_experience`。
- 不做语义判断「这句话是氛围还是承诺」；用 kind 白名单与引用保护，不用模型猜。

### 5.2 执行与恢复（单一写入者）

```
memory.archive.candidates（只读）
  → 作者勾选
  → memory.archive.issue → author_confirm 令牌（10 分钟、只存 hash）
  → memory.archive.apply(ids, token)
      → MemoryExecutor.archiveEntries(ids) 单事务：
          校验候选仍有效 → archived_at=now, archive_reason='redundant'
          → memory_audit(action='archive') 每条一行
          → 消费令牌
  → memory.archive.restore(id) → archived_at=NULL, archive_reason=NULL, audit('restore')
```

- 写只在 `MemoryExecutor` 内；`memory/archive.ts` 只做规则与编排，不直接 `UPDATE`。
- `memory.archive.candidates / issue / apply / restore` 是 IPC 契约：先补 `docs/DEV-PLAN.md` §4.3 的 IPC 表与 `shared/schema/memory.ts`；不改工具 manifest，不新增 G7（归档不是提案应用，使用 `author_confirm`）。
- 幂等键 `memory.archive:<project>:<batchHash>`；重放返回首次结果，不双写、不重复消费。
- 候选在签发令牌后变化 → 跳过失效项并在结果里列 `skipped`；有效项一次事务全写，任一失败整体回滚。`skipped` 是校验结果，不是半写。
- 恢复不需要令牌，但需确认对话框；写 `restore` 审计。恢复不重建向量（行仍在）。
- `archived_at` 不改 `status`：active 仍是 active，但检索默认排除；审计与记忆浏览器能区分「归档」与「标记错误（inactive）」。

### 5.3 检索、计数与 UI

- `memory.retrieve_own` 与 `pinnedBlock` 的 SQL 增加 `archived_at IS NULL`；`as_of`、`status='active'`、`valid_to` 规则不变。
- `memory.retrieve_audit` 默认包含归档行并返回 `archived` 标记；审批仍可审计，不把归档当删除。
- `memory.state` 计数分 `active / archived / inactive / superseded`；记忆台默认「活跃」，可切「已归档」。
- 记忆浏览器过滤器加「已归档」；行内显示归档原因与恢复按钮；归档条目不进入提案/检索候选。
- 缓存键含 `project + actor + character + as_of + model + query`；归档/恢复后清空该角色缓存，避免旧结果回魂。
- 不显示其他角色的私有记忆；归档面板只显示当前角色或作者视图下的条目。

### 5.4 迁移 0014

```sql
ALTER TABLE memory_entry ADD COLUMN archived_at TEXT;
ALTER TABLE memory_entry ADD COLUMN archive_reason TEXT;
ALTER TABLE turn_metric ADD COLUMN cached_tokens INTEGER;
CREATE INDEX memory_entry_archive
  ON memory_entry(project_id, kind, status, archived_at);

-- memory_audit.action 的 CHECK 需要加入 archive / restore：
-- 新建同构表 → 复制 → 删除旧表 → 重命名 → 重建索引（SQLite 不能直接改 CHECK）
```

- `memory_audit` 重建后动作集合 = 旧六种 + `archive` + `restore`；旧行逐列复制，`id` 不变。
- `cached_tokens` 可空；旧行为 NULL，表示「供应商未报告」，不是 0。
- `archived_at` 可空；旧行 NULL，默认全部可见。
- 迁移测试覆盖：旧记忆/审计行保留、CHECK 接受新动作、旧动作仍可用、索引存在、`db.verify()` 绿。
- `LATEST_SCHEMA_VERSION = 14`。

### 5.5 上下文成本优化（M2-9）

先测后改：用 30 章 / 10 万字夹具记录优化前 `turn_metric.tokens_in` 中位数、按层 token、`context_trimmed` 比例、缓存命中。优化只做以下可解释项：

1. **稳定前缀**：L0/L1/角色卡核心在前，动态检索/最近拍/意图在后；`prefixHash` 只覆盖稳定块；提示词模板去重，不删禁则。
2. **块去重**：同一 `(type,id)` 同时出现在 pinned、检索、最近拍时只保留优先级最高的一份；不改变 grounding 引用集合。
3. **摘要压缩**：`summary.prev` 仍 ≤300 tokens；预算紧张时先压到 150，再整块丢（沿用 M1 顺序）。
4. **L3 旁观者**：只保留与场景目标/发言者相关的旁观者；无台词、无关系的角色先裁；上限仍是 8。
5. **最近拍**：默认 6 拍；预算不足时按现有顺序降到 4，再降检索 top_k；不先裁角色卡。
6. **提示词**：删除重复说明与示例，保留输出契约、禁则与工具规则；`prompt_version` 升版并写入 `turn_metric.context_json`。

验收口径：

- 同一 fixture、同一绑定、同一假模型 usage，单拍 `tokens_in` 中位数下降 ≥15%；P95 不升。
- 有 cache 字段的供应商：`cached_tokens / tokens_in` ≥30%（假服务器可注入验证；真实 API 只在 nightly 记录）。
- `context_trimmed` 比例不升超过 5 个百分点；`context_overflow` 仍为 0。
- `E2E-M1-SMOKE`、`E2E-M2-VOICE-01`、grounding/契约测试全绿；不接受「省 token 但引用变少/正文变差」。
- 优化后把按层 token、单拍成本、每万字成本写进 `docs/M2-CONTEXT-COST.md`；阶段 24 在 100k 项目复测。

### 5.6 缓存指标

- `ChatUsage` 增加可选 `cachedTokens?: number`；解析顺序：`prompt_tokens_details.cached_tokens`（OpenAI 兼容）→ `prompt_cache_hit_tokens`（DeepSeek）→ 缺省 `null`。
- `TurnMetricInput` / `turn_metric.cached_tokens` 写入；`context_json.cache` 记录 `{prefixHash, stableTokens, cachedTokens}`。
- 报表与上下文检查器显示「缓存命中（供应商报告）」；未报告显示「未报告」，不显示 0%。
- 缓存命中率只用于成本归因，不作为正确性依据；不因缓存命中跳过 grounding 校验。

## 6 验收清单

- [ ] 0014 迁移：`archived_at/archive_reason/cached_tokens` 列、归档索引、`memory_audit` 新动作；旧行保留；`LATEST_SCHEMA_VERSION = 14`（`tests/unit/migrator.test.ts`）。
- [ ] 候选规则：只 `experience`；fact/relationship/cognition/pinned 永不进入；被有效事实/边引用的条目不进入；确定性排序（`tests/unit/memory/archive.test.ts`）。
- [ ] 执行：`author_confirm` 令牌；单事务写 `archived_at` + 审计；重放不双写；坏令牌零写入；失效候选 `skipped` 不半写（`tests/unit/memory/archive.test.ts`）。
- [ ] 检索：归档后 `memory.retrieve_own` / pinned 不再命中；`memory.retrieve_audit` 仍可见并带标记；缓存失效（`tests/unit/memory/retrieve.test.ts` 扩展）。
- [ ] `E2E-M2-ARCHIVE-01`：记忆台生成候选 → 勾选 → 确认 → 归档列表出现 → 检索不命中 → 恢复 → 检索命中 → 正文/revision 不变。
- [ ] `COST-M2-02`：同一 30 章夹具优化前后 `tokens_in` 中位数下降 ≥15%；P95 不升；`context_trimmed` 不升 >5 个百分点；grounding/E2E 绿（`tests/unit/context/cost.test.ts`、`tests/e2e/context-cost.spec.ts`）。
- [ ] 缓存解析：OpenAI/DeepSeek 两种字段都能读；缺省 NULL；报表/检查器文案区分「未报告」与 0（`tests/unit/model/usage.test.ts`）。
- [ ] `docs/M2-CONTEXT-COST.md` 记录优化前后按层 token、单拍/每万字成本、缓存命中、样本与局限。
- [ ] 不物理删除；`memory_vec` / `memory_fts` 行仍在；归档只影响可见性。
- [ ] 门禁：typecheck / lint / depcruise / unit / integration / e2e / build / gen:check。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 误归档重要经历 | 相似度太高或 keeper 选错 | 只 experience + 低重要度 + 引用保护；作者勾选；可恢复 |
| 归档被当删除 | 作者找不到记忆 | 记忆台「已归档」过滤 + 恢复；审计保留；文案写「软归档」 |
| 省 token 伤质量 | 裁掉关键上下文 | 只做去重/压缩；角色卡/禁揭/意图不裁；质量回归门 |
| 缓存字段误读 | 供应商不返回或字段不同 | 缺省 NULL；两种字段解析；报表标「未报告」 |
| 审计表重建失败 | SQLite CHECK 不能直接改 | 事务内新表复制/改名；迁移测试覆盖旧行与索引 |
| 优化不可复现 | 排序或缓存不稳定 | 纯函数 + 固定排序 + 同 fixture 双跑 |

## 8 进入下一阶段的条件

1. 归档只碰非事实类，软失效、可恢复、审计可追。
2. 检索与计数口径一致；归档后缓存失效。
3. 上下文 token 中位数下降 ≥15%，质量/grounding 回归绿。
4. 0014 迁移与 `db.verify()` 全绿。
5. 成本与优化基线文档有数字与局限。
