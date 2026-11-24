# ADR-0009 异构复检默认值：保持 off

- 状态：**已决定**（2026-11-21）
- 对应：PHASE-21 M2-8、DEV-PLAN §17 D4、`docs/M2-HETERO-CALIBRATION.md`
- 关联：ADR-0003（第二家未补测）、ADR-0008（路由优先级）

## 背景

`review.hetero = off | prefer` 在 M1 默认 `off`。M2-8 要求用数据决定是否把默认改为 `prefer`：费用增加 < 20%，且阻断代理指标改善（接受率不降、漏报代理下降）。

## 证据（2026-11-21，30 章夹具）

来源：`docs/M2-HETERO-CALIBRATION.md` §2；脚本 `scripts/m2-calibration.mjs`。

| 指标 | 数值 |
|---|---:|
| 审批报告 | 60（30 章 × G4 + 复检） |
| 阻断（全部接受） | 60 / 60 |
| 建议（30 拒绝） | 120 |
| 审批费用 | ¥1.2384 |
| 生成费用 | ¥1.4688 |
| `heteroDeltaPct` | null |
| 同家 / 异构报告 | 60 / 0 |
| G6 定稿 | 30 |

## 判定

D4 规则要求费用差可估算且异构组样本可比。本次两项都不满足：

1. 第二家预设（OpenAI / 通义）未接真实 Key、未计价，`heteroDeltaPct` 为 null；
2. 异构组报告数为 0，无法证明「阻断接受率不降、漏报代理下降」。

因此**保持 `review.hetero = off`**。不把「模拟费用差」当成真实账单，不把 0 份异构样本当成改善证据。

## 后果

- 默认行为与 M1 一致：审批用配置的 reviewer 绑定；作者可手动切 `prefer`，无第二家时报告标 `hetero_unavailable`，不阻断 G6。
- 状态栏、报告 provider、`review.calibration` 都能看到实际归因；没有伪造「已异构」。
- 外部依赖继续记录在 ADR-0003 与 `docs/BACKLOG.md`：真实第二家 Key 补测后才能重跑 D4。

## 何时改默认

真实第二家 Key 补测后：

1. 用同一 30 章夹具（或真实项目）重跑 `node scripts/m2-calibration.mjs`；
2. 若 `heteroDeltaPct < 20`、同家/异构两组都有作者决策，且异构组接受率不降、每份报告阻断数增加；
3. 先改 `docs/PRD.md` 变更记录与 `docs/DEV-PLAN.md` §17，再改 `ReviewSettingsSchema` 默认值与设置页文案；
4. 已有设置文件保留作者显式值，不强制迁移。

## 回退

改默认为 `prefer` 后若费用或质量变差：把默认值改回 `off`，保留作者显式设置；不需要迁移或重建数据。
