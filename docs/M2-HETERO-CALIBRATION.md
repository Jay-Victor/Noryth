# M2 异构复检校准（阶段 21）

> 口径：`review.calibration` / `scripts/m2-calibration.mjs` 只读 `approval_report`、`patch`、`gate_record` 与 `turn_metric`。
> 「阻断被作者接受（patch 应用）」是代理指标，**不是人工标注的召回率**；没有作者决策的报告不进分母。
> 夹具是假模型（固定报告与 patch 决策），数字用于口径验证与 D4 判定，不是真实质量结论。

## 1 夹具

| 项 | 值 |
|---|---|
| 章节 | 30 章 / 3 卷（每卷 10 章） |
| 审批报告 | 60 份（每章 G4 + 复检） |
| 作者决策 | 每章 2 条阻断接受 + 1 条建议拒绝；复检不新增阻断 |
| 定稿 | 30 章（G6） |
| 模型 | `NORYTH_*_FAKE=1` 假适配器；嵌入 `hash-bigram-v1` |
| 异构开关 | `review.hetero = off`（默认；没有第二家真实 Key） |
| 计价 | DeepSeek 输入 ¥2 / 输出 ¥8 每百万 token（预设计价） |

夹具生成：`NORYTH_COST_BASELINE=1 NORYTH_E2E_KEEP=1 pnpm exec playwright test --config playwright.m1a.config.ts tests/e2e-long/_cost-baseline.spec.ts`；随后对打印出的项目目录跑校准脚本。

## 2 校准结果

| 指标 | 数值 |
|---|---:|
| 报告数 | 60 |
| 阻断总数 | 60 |
| 阻断接受 / 拒绝 | 60 / 0 |
| 阻断接受率（代理） | 100% |
| 建议总数 | 120 |
| 建议接受 / 拒绝 | 0 / 30 |
| 建议接受率（代理） | 0% |
| 审批费用 | ¥1.2384 |
| 生成费用 | ¥1.4688 |
| `heteroDeltaPct` | null（第二家未定价 + 没有异构样本） |
| G6 定稿章 | 30 |

按维度：

| 维度 | 均值 | 接受组均值 | 拒绝组均值 | 样本 |
|---|---:|---:|---:|---:|
| 人物一致性 | 3.5 | 3 | — | 60 |
| 剧情逻辑 | 3 | 2 | — | 60 |
| 纲要对齐 | 4 | 4 | — | 60 |
| 文笔质量 | 3 | — | 3 | 60 |

60 份报告全部是「同家审批」（`provider` 与生成家相同）；异构组样本为 0。60 条阻断全部被作者接受（夹具的 patch 决策固定），30 条建议被拒绝。

## 3 D4 判定

`docs/DEV-PLAN.md` §17 D4：**费用增加 < 20%，且阻断代理指标改善（接受率不降、漏报代理下降）→ 默认开**。

本次数据不满足：

- `heteroDeltaPct = null`：第二家预设未定价，无法估算费用差；
- 异构组报告数为 0：没有「审的人不是写的人」的样本，无法证明接受率不降、漏报代理下降。

结论：**保持 `review.hetero = off`**（ADR-0009）。这是数据不足下的保守决定，不是「异构无效」的结论。

## 4 局限

- 假模型：报告条目与证据是脚本化的，阻断/建议条数固定，不代表真实模型的误报/漏报分布。
- 代理指标：patch 接受率衡量「作者是否采纳」，不等于召回率；没有作者决策的条目被排除，可能高估接受率。
- 费用：`turn_metric.cost_cny` 来自预设计价；OpenAI / 通义未接真实 Key、未计价，`heteroDeltaPct` 只能为 null。
- 复核报告：每章复检报告会计入 `reports`，但不重复计阻断；把 G4 与复检混在同一分母里，适合看总体采纳，不适合比较单轮质量。
- 无真实异构：异构组为 0，任何「默认开启」的建议都只能来自模拟，不能当作验收证据。

## 5 外部依赖与回退

- 真实第二家 Key（DashScope / Moonshot）补测后，用同一脚本重跑，填入 `heteroDeltaPct` 与异构组；
- 满足 D4 时：先改 `docs/PRD.md` 变更记录与 `docs/DEV-PLAN.md` §17，再改 `ReviewSettingsSchema` 默认值和设置页文案；已有设置文件保留用户显式值，不强制迁移；
- 不满足或数据不足：保持 `off`，`review.hetero` 仍可由作者手动切到 `prefer`（报告标 `hetero_unavailable` 时不阻断）。

## 6 复跑命令

```bash
# 1) 生成 30 章夹具（nightly 级，约 20s；保留临时目录）
pnpm build
NORYTH_COST_BASELINE=1 NORYTH_E2E_KEEP=1 pnpm exec playwright test \
  --config playwright.m1a.config.ts tests/e2e-long/_cost-baseline.spec.ts

# 2) 只读校准
node scripts/m2-calibration.mjs "<COST-BASELINE project 路径>"
```

`scripts/m2-calibration.mjs` 只读打开项目库，不写库、不调模型、不改文档；输出字段与 `review.calibration` 同口径。
