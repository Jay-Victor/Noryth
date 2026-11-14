# 阶段 09 · 记忆台与 G7

> 阶段 9 / 10 ｜ 依赖：08 ｜ 下游：10
> 对应：`docs/DEV-PLAN.md` §5.4、§6.4、§7.5、§10、§12.3（H1–H5）
>
> **一句话目标**：定稿后只抽取一次，作者逐条审阅，G7 应用后第 2 章能检索到第 1 章的记忆，且跨角色永远查不到别人的。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 只从定稿抽取，初稿/未确认拍不进记忆 | 用初稿跑抽取应拒绝或为空 |
| 2 | 台词不能产生客观事实 | 「账本在祠堂」→ belief/claim，不是 objective |
| 3 | 证据 quote 必须能在来源拍里找到 | 篡改 quote → 丢弃该条 |
| 4 | apply 是原子的、幂等的 | 同 job 重放不双写；失败全回滚 |
| 5 | 第 2 章能召回第 1 章记忆 | `E2E-MEMORY-01` |

## 2 范围

### 2.1 做

- H1：抽取输入、提案 schema、证据子串校验、事实/信念/声称分类。
- H2：提案 UI（逐条接受/编辑/拒绝）、来源展示、对话追问。
- H3：apply 执行器、向量写入、supersede、幂等、G7。
- H4：角色记忆浏览、审计、世界状态只读。
- H5：隔离回归（写向量后再测一次）、软失效。
- 记忆管理 Agent 提示词。

### 2.2 不做

- 关系图、世界时间线 as-of UI → M1。
- 按章重建（T40）→ M1；本阶段只留接口与按钮占位（禁用）。
- 低分归档 → P2。
- 改正文、读初稿、物理删除。
- 跨章自动影响分析 → M1。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 抽取 | `src/main/memory/extract.ts` | 只读 final；提案逐条落库 |
| 证据校验 | `src/main/memory/evidence.ts` | quote 必须是来源拍子串 |
| 分类 | `src/main/memory/classify.ts` | 台词→belief/claim；旁白→fact |
| 提案页 | `src/renderer/pages/memory/ProposalList.tsx` | 逐条接受/编辑/拒绝 |
| 执行器 | `src/main/memory/apply.ts` | 单事务；幂等；向量同写 |
| 浏览/审计 | `MemoryBrowser.tsx`、`AuditList.tsx` | 来源可追；软失效 |
| 测试 | `tests/e2e/memory.spec.ts` | `E2E-MEMORY-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| H1 | 抽取管线 + 证据校验 + 事实分类 | G3、D5 | 台词不产生 objective 事实 |
| H2 | 提案 UI + 逐条决策 | H1、A4 | 编辑/拒绝不写库 |
| H3 | apply 执行器 + 向量 + 幂等 + G7 | H1、C4、B2 | 重放不双写；事务原子 |
| H4 | 记忆浏览 + 审计 + 世界状态只读 | H3 | 软失效；来源可追 |
| H5 | 隔离回归（写入向量后）+ 软删验证 | H3、E4 | 跨角色探针 0 命中 |

## 5 实现要点

### 5.1 抽取

- 输入只读 `revision.kind='final'`；初稿、未确认拍、未接受 patch 不进。
- 输出逐条：`kind`、`character_id`、`text`、`evidence{beatId, quote}`、`importance`、`pin`、`payload`。
- `quote` 归一化后必须是来源拍正文的子串；不匹配 → 丢弃 + `evidence_mismatch`。
- 台词证据 → 只允许 `belief` 或 `world_fact(truth='claim')`；`objective` 必须来自旁白事件或作者确认。

### 5.2 提案与决策

- 抽取只写 `job` + `memory_proposal_item`，不写记忆库。
- 接受/编辑/拒绝只写 `decision/edited_text`，不写长期状态。
- 台词条目不提供「转为事实」快捷按钮；要改事实必须作者在世界状态显式新增。

### 5.3 apply

```
G7 令牌 + 幂等键
  → 先算 embedding（worker）
  → 单事务：
      memory_entry（带 source_revision / learned_seq）
      world_fact（valid_to / valid_from）
      relationship_edge（valid_to / since_seq）
      memory_vec
      审计
  → job=applied；令牌消费
```

- embedding 失败 → 整个 apply 失败可重试，不出现「有文本无向量」。
- 单值谓词换宾语 → 旧值 `valid_to_seq`，新条目 `supersedes_id`。
- 多值谓词并存；否定句不因去重被合并。

### 5.4 浏览与审计

- 过滤：角色、类型、章节、状态（active/inactive/superseded）、pin。
- 详情：原文、来源、审计链、标记错误、按章重建（M1 禁用）。
- 不物理删除；失效用软状态。
- 世界状态 M0 只读当前视图；as-of 滑块 M1。

### 5.5 隔离回归

- 写向量后再跑一次探针：每个角色只能命中自己的 `mem_*`。
- 跨角色检索断言 0 条；命中即 `isolation_violation`，禁止开演。
- 缓存键含 `project_id + actor_id + character_id + as_of`。

## 6 验收清单

- [ ] `E2E-MEMORY-01`：定稿 → 14 条提案 → 删 2 改 1 → apply 12 条 → 第 2 章召回 ≥1 条。
- [ ] 用初稿跑抽取被拒或返回空；只读 final。
- [ ] 台词「账本在祠堂」只产生 belief/claim，不产生 objective 事实。
- [ ] 篡改 evidence quote → 该条被丢弃并记 `evidence_mismatch`。
- [ ] 同 job 重放 → `duplicate:true`，不双写。
- [ ] apply 中途失败 → 文本、事实、边、向量全部回滚。
- [ ] 跨角色检索 0 命中；探针回归通过。
- [ ] 记忆条目带 `source_chapter_id` / `source_revision_id` / `learned_seq`。
- [ ] 标记错误 → 软失效，不删除。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 抽取质量差 | 提案大量无意义 | 提高重要度阈值；作者逐条拒绝；不自动写入 |
| 事实/信念混淆 | 台词被写成事实 | 代码强制 `classifyEvidence`，不靠提示词 |
| 向量维度不一致 | 写入失败 | 校验 `embedding_dim`；换模型必须重建 |
| apply 半成功 | 有文本无向量 | 先 embedding 后单事务；失败全回滚 |
| 空结果率高 | 第 2 章查不到 | 检查 bigram/阈值；提示补记忆，不自动放宽 |

## 8 进入下一阶段的条件

1. G7 能应用 12+ 条且重放不双写。
2. 第 2 章能召回第 1 章至少 1 条记忆。
3. 跨角色隔离回归通过。
4. 事实/信念分类的代码级规则有测试。
5. apply 失败回滚演练通过。
