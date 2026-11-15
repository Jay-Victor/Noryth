# 阶段 13 · as-of、世界状态与上下文可见性

> 阶段 13 / 18（M1 第 3 阶段）｜ 依赖：12 ｜ 下游：14–18
> 对应：`docs/DEV-PLAN.md` §5.6、§7.3、§10.4、§12.6（M1-3、M1-17、M1-18、M1-19）
>
> **一句话目标**：回答「第 3 章结束时，谁知道账本在祠堂」，并让审批只看见第 3 章该看见的东西。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 世界状态可按 as-of 回放 | 同一项目两个 as-of 返回不同事实 / 信念 / 边 |
| 2 | 读者已知与角色已知不同 | T14 只返回 `reveal_seq ≤ as_of` 的公开事实；T13 返回 `known_by` 含本人 |
| 3 | 第 3 章审阅读不到第 20 章才产生的事实 | `E2E-M1-ASOF-01`：review 上下文与工具结果不含 ch20 新 fact |
| 4 | 作者可显式新增事实 | 世界状态编辑器写 `source_type='author'`，不写正文 |
| 5 | 上下文检查器能解释「这轮为什么贵」 | 显示 L0–L3 块、tokens、裁剪、refs、prefixHash |

## 2 范围

### 2.1 做

- M1-3：as-of 查询 + 世界时间线 UI（章 + seq 滑杆；事实 / 信念分节）。
- M1-18：世界状态作者编辑器（显式新增 / 关闭事实；作者权限）。
- M1-17：上下文检查器 + 预算条（只读）。
- M1-19：审查与检索的 as-of 边界（review 用 `covered_until_seq`；manuscript 按章截断）。
- 世界状态 IPC：`world.projection`、`world.fact.add`（只在 main 校验）。

### 2.2 不做

- 关系图（阶段 14）。
- 世界状态批量编辑、导入、导出为设定集（M2）。
- 自动推断故事时间（M2）。
- 作者编辑记忆条目（只软失效；重建在阶段 14）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| as-of 投影 | `src/main/world/projection.ts` | 事实 / 信念 / 边三组；纯函数 |
| 世界时间线 | `src/renderer/pages/memory/WorldTimeline.tsx` | 滑杆 + 章选择；默认当前章结束 |
| 作者事实 | `src/main/world/author-facts.ts` + `src/main/memory/apply.ts`（`applyAuthorFact`） | `source_type='author'`；审计；单值槽 supersede；不新增写入口 |
| 上下文检查器 | `src/renderer/pages/write/ContextInspector.tsx` | 块列表 + 预算条 + 裁剪原因 |
| 审查边界 | `src/main/review/run.ts`、`src/main/context/sources.ts` | review 用章水位，不 fallback `seqHead` |
| 测试 | `tests/integration/asof.spec.ts`、`tests/e2e/asof.spec.ts` | `E2E-M1-ASOF-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-3 | as-of 投影 + 世界时间线 UI | B3、M1-2 | 同数据两个 as-of 结果不同；事实/信念分开 |
| M1-18 | 世界状态作者编辑器 | M1-3、C6 | 作者可新增；不进工具白名单 |
| M1-17 | 上下文检查器 + 预算条 | D3、D4 | 展示 `turn_metric.context_json`；数值可对齐 |
| M1-19 | 审查与检索 as-of 边界 | M1-3、G1 | ch3 审查不见 ch20 fact；manuscript 只到 ch3 |
| IPC | `world.projection` / `world.fact.add` | A3 | 参数 Zod 校验；错误映射统一 |

## 5 实现要点

### 5.1 as-of 水位

| 场景 | `as_of` 取值 | 说明 |
|---|---|---|
| 新章生成 | `max(前一章 covered_until_seq, 本章 covered_until_seq)`；第一章为 `0` | 按叙事顺序推进，不引入未来章事实 |
| 已写章生成/编辑 | `chapter.covered_until_seq` | 不引入本章之后的 seq |
| 审批 / 复审 | `chapter.covered_until_seq`（严格，不 fallback） | 未写过正文的章拒绝复审 |
| 作者查看世界状态 | 显式 `as_of ∈ [0, seq_head]` | 只读；不注入 Agent 上下文 |

- `project.seq_head` 只用于分配新 seq 与项目级元数据，**不再作为 Agent 上下文水位**。
- 初始世界事实由 G1 写 `valid_from_seq = 0`，所以第一章 `as_of=0` 仍能看到它们。

- 可见性过滤在 SQL，不在应用层：
  `valid_from_seq <= as_of AND (valid_to_seq IS NULL OR valid_to_seq > as_of)`。
- 角色 T13 再加 `known_by_json` 含本人，或 `visibility='public' AND reveal_seq <= as_of`。
- 事实与信念分节：`world_fact`（客观 / 声称）vs `character_belief`（角色以为）；允许互相矛盾，UI 不合并。
- `world.get_reader_known` 只返回 `visibility='public'` 且 `reveal_seq` 非空且 `<= as_of` 的事实；无 `reveal_seq` 的永不返回。

### 5.2 作者新增事实

- IPC `world.fact.add`：`subject / predicate / object / truth / visibility / known_by / reveal_seq / valid_from_seq`。
- 事务由 `memory/apply.ts` 的 `applyAuthorFact` 执行；`world/author-facts.ts` 只做参数组装与校验，**不写 SQL**，保持「世界状态只有一个写入者」（R2）。
- `source_type='author'`；单值谓词且 `truth='objective'` → 旧值 `valid_to_seq = 新 seq`；多值并存。
- 写 `memory_audit(action='apply', actor='author')`；不产生 job，不需要 G7（作者权限）。
- 作者可以新增 `claim`，但台词仍不能自动产生 `objective`：抽取规则不变（阶段 09）。
- 作者关闭事实：`valid_to_seq = 当前 seq`，不物理删除。

### 5.3 审查边界（M1 关键修复）

- `src/main/review/run.ts` 当前用 `asOf: project.seqHead`；M1 替换为 `chapter.coveredUntilSeq`，不再读项目水位。
- `src/main/context/sources.ts` 增加 `mode: 'write' | 'review'`：
  - `write`：本章已写用 `coveredUntilSeq`；新章用前一章 `coveredUntilSeq`（第一章 0）；
  - `review`：必须用本章 `coveredUntilSeq`，为 0 时拒绝复审（`invalid_args`）。
- `manuscript.search_final` / `get_final_chapter`：只返回 `chapter.ord <= 当前章.ord` 的定稿；显式请求更晚章 → `invalid_args`。
- `memory.retrieve_audit`：as_of 同样受当前章约束；审批不能借审计通道看未来记忆。
- 测试：ch3 定稿后写 ch20，ch20 **新产生**的事实 `valid_from_seq=ch20.seq`（`reveal_seq=ch20.seq`）；ch3 复审上下文与 `world.get_objective(as_of=ch3)` 都不含该 fact；ch3 可见 ch1–ch3 事实。`reveal_seq` 只控制读者已知视图，不改变 objective 事实的有效期。
- 若事实在 ch3 前已产生、但 ch20 才揭示：审批仍可在 `world.get_objective` 中看到它用于审计；它不进角色 / 旁白上下文，也不进读者已知视图。这条区别写进 `E2E-M1-ASOF-01` 的断言注释，避免把「读者未知」与「不存在」混为一谈。
- 作者在世界状态页看全量是允许的；限制只针对 Agent / 审批 / 检索上下文，日志标注来源。

### 5.4 上下文检查器

- 数据源 `turn_metric.context_json`：blocks（layer / priority / tokens / trimmed）、refs、prefixHash、degraded。
- 显示「估算 tokens + 上次实际 ratio」，不显示假精确值（§7.4）。
- 只读；不提供「改预算」按钮（设置页才有）。
- 预算条：本章 token / 费用进度；超预算显示暂停原因，不自动续跑。
- 不展示被裁掉的正文全文，只显示块 ID、类型与 token 数；依据 chips 打开只读面板。

## 6 验收清单

- [ ] 同一事实在两个 as-of 下可见性不同；事实与信念分节展示。
- [ ] `E2E-M1-ASOF-01`：第 3 章审批上下文无第 20 章**新产生**的 fact（`valid_from_seq=ch20.seq`）；第 20 章可见；ch20 才揭示的旧事实按「读者未知」处理，不混同「不存在」。
- [ ] `manuscript.search_final` 在 ch3 不返回 ch4+；`get_final_chapter` 同。
- [ ] 作者新增 objective 事实后，单值槽旧值 `valid_to_seq` 正确；审计有 author 记录。
- [ ] 上下文检查器显示块 / tokens / 裁剪原因，数值与 `turn_metric` 一致。
- [ ] UI-DESIGN §11「as-of 切换后事实与信念分别展示」勾选。
- [ ] 没有把 `as_of` 放回 `input_schema`；工具身份注入不变。
- [ ] `E2E-M1-ASOF-01` 同时断言：审批报告引用的证据全部 ≤ ch3 水位。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 新章 as-of 取错 | 读不到前章事实 | `write` 用前一章 covered；第一章 0；E2E 覆盖 |
| 作者全量视图被误判泄漏 | 误报 | 区分「作者视图」与「Agent 上下文」；日志标注 |
| 单值槽冲突 | 两值并存 | 新值先关旧值；唯一索引兜底 |
| 时间线 UI 过重 | 范围蔓延 | M1 只做滑杆 + 三张表；不做图形时间轴 |
| 检查器泄露正文 | 诊断包 | 只在本地 UI；不导出正文 |

## 8 进入下一阶段的条件

1. `E2E-M1-ASOF-01` 通过；review 不再使用 `seqHead`。
2. 作者事实写入有审计与唯一索引测试。
3. as-of UI 与 UI-DESIGN §11 对应条勾选。
4. 上下文检查器数值与 `turn_metric` 可对齐。
5. 没有新增写正文路径。
