# M2 成本与预算基线（阶段 20）

> 口径：`turn_metric` 的 token 与 `cost_cny`（DeepSeek 预设计价，本地折算），字数取 revision 清单。
> 夹具是**假模型**：usage 固定、文本同构，数字用于回归与口径验证，**不是报价**。
> 复跑方式见 §7；真实账单需另行抽样，不改本基线结论。

## 1 夹具

| 项 | 值 |
|---|---|
| 章节 | 30 章 / 3 卷（每卷 10 章） |
| 拍 | 540 拍（3 场 × 6 拍 × 30 章） |
| 字数 | 27,318 字（假模型单拍约 50 字；低于 §5.6 的 10 万字设想，阶段 24 的 100k 长跑会用同一报表更新） |
| 角色 | 5 |
| 记忆 | 240 条 active（30 章 × 8 条左右；未刻意造到 3k） |
| 每章流程 | G2 → 2 拍逐拍确认 → 自动跑完 → G4 → G5（2 接受 1 拒绝）→ 复检 → G6 定稿 → G7 抽取 + 应用 |
| 模型 | `NORYTH_*_FAKE=1` 假适配器；嵌入 `hash-bigram-v1` |
| 计价 | DeepSeek：输入 ¥2 / 输出 ¥8 每百万 token（`src/main/model/presets.ts`） |

## 2 总费用与每万字

| 指标 | 数值 |
|---|---:|
| 输入 token | 1,140,000 |
| 输出 token | 101,400 |
| 总费用 | ¥3.0912 |
| 有计价调用 | 660 |
| 无计价调用 | 0 |
| 字数 | 27,318 |
| **每万字成本** | **¥1.1316** |

## 3 按 Agent

| Agent | 调用 | token（入/出） | 费用 | 占比 | P50 | P95 |
|---|---:|---:|---:|---:|---:|---:|
| reviewer（审批） | 90 | 480,000 / 34,800 | ¥1.2384 | 40.06% | 2ms | 4ms |
| character（角色） | 270 | 270,000 / 24,300 | ¥0.7344 | 23.76% | 6ms | 11ms |
| narrator（旁白） | 270 | 270,000 / 24,300 | ¥0.7344 | 23.76% | 6ms | 7ms |
| memory（记忆） | 30 | 120,000 / 18,000 | ¥0.3840 | 12.42% | 9ms | 19ms |

审批（G4 + 讨论 + 复检，每章 3 次）是最大的单项成本（40%）；写拍按 540 次调用分角色/旁白。
耗时是假适配器的本地耗时，只用于验证 P50/P95 口径，不代表真实供应商。

## 4 按章分布

30 章结构相同：每章 898–916 字、22 次调用、¥0.10304。
`costPer10k` 落在 **1.1249 – 1.1474** 之间（字数差异导致，不是费用差异）。

报表对每章给出 `calls / unpricedCalls / latencyP50 / latencyP95`；本章无计价的调用会显示「费用为下限」。

## 5 项目级（规划）

| 指标 | 数值 |
|---|---:|
| 调用 | 0 |
| token | 0 |
| 费用 | ¥0 |

本次夹具没有跑规划会话，所以项目级为 0；`report.cost` 对 `chapter_id IS NULL` 的规划费用单列、不摊到章，
口径由 `tests/unit/report/cost.test.ts` 与 `tests/integration/usage.spec.ts` 覆盖（规划行 `chapter_id` 为 NULL）。

## 6 每拍确认耗时

| 指标 | 数值 |
|---|---:|
| 作者确认样本 | 60（每章 2 拍） |
| P50 | 23ms |
| P95 | 34ms |
| 缺失拍（自动确认，无 `beat_confirmed`） | 480 |

自动模式不写 `beat_confirmed`，所以自动确认的拍计为缺失、不补 0；P95 在样本 <5 时只显示 P50。

## 7 复跑命令

```bash
pnpm build
NORYTH_COST_BASELINE=1 NORYTH_E2E_KEEP=1 pnpm exec playwright test \
  --config playwright.m1a.config.ts tests/e2e-long/_cost-baseline.spec.ts
# 从输出里取「COST-BASELINE project: <路径>」
node scripts/m2-cost-baseline.mjs <路径>
```

`scripts/m2-cost-baseline.mjs` 只读打开项目库（`readonly`），输出与 `report.cost` 同口径的 JSON；
不写库、不调模型、不改文档。`tests/e2e-long/_cost-baseline.spec.ts` 默认 `skip`（nightly 的
`pnpm test:e2e:m1a` 不会重复跑 30 章），只有显式设置 `NORYTH_COST_BASELINE=1` 时才生成夹具。

## 8 局限

- **假 usage**：假适配器每拍固定 `1000/90`（最终答复）与工具轮的 `400/20`，真实供应商的缓存命中折扣、阶梯价、reasoning token 都不在其中；费用只能用于横向比较（章 / Agent）。
- **预设计价**：DeepSeek 价格是本地折算；OpenAI / 通义保持未定价（`pricing = 0`），报表显示「费用为下限」而不是 0（ADR-0003：第二家真实补测前不伪造）。
- **不计入**：汇率、发票、供应商账单对账；导出与本地检索不产生模型费用。
- **每千字作者净操作时间**：需要客户端交互埋点，本阶段不新增通用埋点；阶段 24 内测用秒表记录 10 万字项目，写进 M2 验收报告的「未自动化」项。PRD M2 四条退出标准不依赖该指标，不用它替代每万字成本。
- **记忆规模**：30 章夹具的 active 记忆条数以脚本输出的 `fixture.memories` 为准，未刻意造到 3k 条；记忆检索本身不产生模型费用，写入费用已在每章 G7 中计。
