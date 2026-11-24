# M2 上下文成本基线（阶段 22）

> 对应：`docs/PHASE-22-ARCHIVE-CONTEXT.md` §5.5–§5.6（M2-9）、`docs/DEV-PLAN.md` §7.3–§7.4 / §5.22
> 测试：`COST-M2-02`（`tests/unit/context/cost.test.ts`、`tests/e2e/context-cost.spec.ts`）
> 日期：2026-11-24 ｜ 结论：**同一夹具单拍提示词 token 中位数下降 20.5%，P95 不升，裁剪比例为 0**

## 1 方法

- **同一夹具、同一绑定、同一估算器**跑两遍：
  - `assembleContextBaseline()`：优化前路径——块不去重、旁观者按顺序取 8、最近拍可降到 2；
  - `assembleContext()`：M2-9 路径——块去重（pinned 优先，同 `(type,id)`/同文本只留一份）、L3 旁观者相关裁（点名/有张力优先，零相关最多补到 4）、最近拍先降到 4 再降 top_k。
- 统计对象是**送进模型前的提示词估算 token**：`renderPrompt()` 的 system + user 全部文本，用 `estimateTokens()`（DEV-PLAN §7.4）计算；等于 `tokens_in` 的可复现代理，不调用模型、不写数据库。
- 样本：30 章 × 每章 6 拍 = **180 拍**；每拍取中位数与 P95。
- 夹具还原 M2 目标场景：30 章累积的低重要度重复记忆（同一段氛围描写被重复抽取）、8 名旁观者的群戏、2 条 pinned、上一章摘要、6 拍最近正文。命令：

```bash
pnpm vitest run tests/unit/context/cost.test.ts
```

## 2 结果（同一夹具，180 拍）

| 指标 | 优化前（baseline） | 优化后 | 变化 |
|---|---:|---:|---:|
| 单拍提示词 token 中位数 | 2,725 | 2,167 | **−20.5%** |
| P95 | 2,736 | 2,176 | −20.5%（不升） |
| `context_trimmed` 比例 | 0% | 0% | 0 个百分点 |
| `context_overflow` | 0 | 0 | — |

按层平均 token（system 固定 738.5 / 拍）：

| 层 | 优化前 | 优化后 | 说明 |
|---|---:|---:|---|
| system（提示词 + 稳定前缀） | 738.5 | 738.5 | 提示词去重已合入当前版本；本表按同一版本对照，未把去重收益计入 |
| L0 章级 | 128.7 | 128.7 | 章纲 + 上一章摘要（≤300） |
| L1 场景级 | 104.0 | 104.0 | 不裁剪 |
| L2 发言者 | 1,156.7 | 970.7 | pinned + 检索去重 |
| L3 旁观者 | 592.0 | 296.0 | 8 人 → 4 人（2 个点名 + 2 个有张力） |
| **合计** | **2,726.8** | **2,167.9** | **−20.5%** |

## 3 写拍成本估算（仅上下文，不含审批/记忆/规划）

按 DeepSeek 预设折算价（in ¥2 / out ¥8 每百万 token，DEV-PLAN §5.21）与固定 90 输出 token：

| 口径 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| 单拍写拍成本（¥） | 0.006170 | 0.005054 | −18.1% |
| 每万字写拍成本（¥，按 200 字/拍 × 50 拍） | 0.3085 | 0.2527 | −18.1% |

说明：这是**写拍上下文**的估算，不是整章成本；审批、记忆抽取、规划与讨论另计（阶段 20 的 `docs/M2-COST-BASELINE.md` 是整章口径：30 章 / 540 拍 / 2.73 万字 / ¥3.0912）。阶段 24 的 100k 长跑用真实 `turn_metric` 复测整章口径。

## 4 缓存命中（供应商报告）

- 解析顺序：OpenAI 兼容 `prompt_tokens_details.cached_tokens` → DeepSeek `prompt_cache_hit_tokens` → 缺省 `NULL`。
- E2E 用假适配器注入 `cached_tokens=640 / prompt_tokens=1000`（`COST-M2-02`）：
  - `turn_metric.cached_tokens=640`；
  - `context_json.cache={prefix_hash, stable_tokens>0, cached_tokens:640}`；
  - 上下文检查器与成本报表显示「缓存命中 640 · 64%」；未报告时显示「未报告」（`NULL`，不是 0%）。
- 真实供应商缓存命中率**未测**：本机只有 DeepSeek 单家 Key，且缓存命中依赖供应商侧前缀缓存策略；按 ADR-0003 记录为外部依赖，阶段 24 的 100k 长跑如有真实 Key 再补数字。

## 5 质量回归

- 单元 + 契约：`pnpm test:unit` 全绿（873）。
- 记忆/审批/创作台 E2E：`E2E-MEMORY-01`、`E2E-M1-REBUILD-01`、`E2E-M1-SMOKE` 等复跑绿；`E2E-M2-ARCHIVE-01` 证明归档只影响可见性（正文 revision / content_hash 不变）。
- grounding 校验路径未改：上下文块去重后，被去掉的只是重复条目；`refs` 仍由最终保留的块生成，`grounding_not_returned` / `quote_mismatch` 规则不变。
- 角色卡核心、禁揭清单、本拍意图、L0/L1 不参与任何裁剪；L3 只裁零相关旁观者，上限仍 8。

## 6 局限

- 夹具是**合成**的 30 章 × 6 拍（不是真实项目），重复记忆与群戏比例按 M2 目标场景设定；真实项目的下降取决于重复率与在场人数。
- 提示词 token 用应用内估算器（CJK 1.05 / latin 1/3.6 / punct 0.6），与供应商 tokenizer 有差异；计费仍以供应商 `usage` 为准。
- 提示词去重（删除与输出契约重复的说明）已合入当前版本，但本对照使用同一版提示词，**未把去重收益计入 20.5%**（保守）。
- 不测模型摘要、不换嵌入模型、不改 grounding；`summary.prev` 仍是抽取式 ≤300 token。
- 100k 项目的缓存命中、每万字成本与按层分布留阶段 24 复测（同一 `docs/M2-CONTEXT-COST.md` 更新）。
