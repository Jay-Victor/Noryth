# 阶段 24 · QA、内测与 M2 验收

> 阶段 24 / 24（M2 第 6 阶段）｜ 依赖：19–23 ｜ 下游：无（M2 收口）
> 对应：`docs/DEV-PLAN.md` §12.6（M2-10）、§16.5、`docs/PRD.md` §10（M2 四条）
>
> **一句话目标**：10 万字项目能连续推进并完成至少一卷，M2 四条退出标准逐条有可复跑证据。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 10 万字项目可稳定推进并完成至少一卷 | `E2E-M2-A`：30 章 / 10 万字 / 30 final；至少一卷完整走完 G2→G7 |
| 2 | 自动模式在预算内跑完一场并正确收束 | `E2E-M2-BUDGET-01` 回归 + `E2E-M2-A` 预算段 |
| 3 | 声音区分度与伏笔回收率有基线报告 | `E2E-M2-METRICS-01` + `docs/M2-METRICS-BASELINE.md` |
| 4 | 每万字成本可归因到章/Agent | `E2E-M2-COST-01` + `docs/M2-COST-BASELINE.md` |
| 5 | M1 不回归、安装/更新仍可用 | M1 全部关键 E2E + 安装冒烟 + 更新演练 |
| 6 | 内测问题有清单、有里程碑，不藏在「已知问题」里 | `docs/M2-ACCEPTANCE.md` §已知问题 |

## 2 范围

### 2.1 做

- M2-10：`E2E-M2-A` 30 章 / 10 万字长跑；`E2E-M2-SMOKE` 3 章提交门。
- M2-10：全量门禁、混沌、性能、安全、无障碍、200% 缩放、安装冒烟、更新演练。
- M2-10：内测（作者自测 100k 项目 + 可选外部试用）与问题清单；不引入遥测。
- `docs/M2-ACCEPTANCE.md`：PRD M2 四条 + 任务验收 + 基线报告 + 已知问题 + 复跑命令。
- 版本 0.3.0（发布标签 `v0.3.0-m2.1`）；NSIS + `latest.yml`；阶段标签 `phase-24-done`。
- 把 M2 的测试 ID、基线数字、迁移版本同步回 `DEV-PLAN` / `PROGRESS` / `AGENTS`。

### 2.2 不做

- 不在 QA 阶段加新功能；发现缺口先修缺陷，不扩范围。
- 不要求外部内测用户数量；没有外部试用时记录为外部依赖，不阻断 PRD M2 四条。
- 不做真实第二家 Key 采购；没有 Key 时仍用假服务器证明协议与路由。
- 不做 Win10 22H2 强制安装冒烟；有 VM 则跑，没有则按外部依赖记录（沿用 M1 口径）。
- 不做分支合并、模型摘要、项目模板、自动补旁白建议。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 100k 长跑 | `tests/e2e-long/m2-a.spec.ts`、`playwright.m2a.config.ts`、`pnpm test:e2e:m2a` | 30 章 / 10 万字 / 30 final |
| 提交门 smoke | `tests/e2e/m2-smoke.spec.ts` | 3 章闭环；`pnpm test:e2e` 内 |
| 验收报告 | `docs/M2-ACCEPTANCE.md` | PRD M2 四条逐条证据 |
| 内测清单 | `docs/M2-ACCEPTANCE.md` §内测 或 `docs/M2-BETA-NOTES.md` | 问题、严重度、里程碑 |
| 分发 | `release/Noryth-0.3.0-setup.exe` + `latest.yml` | 安装 / 更新 / 回滚 |
| 版本 | `package.json` 0.3.0 | 安装包、`app.info`、窗口标题一致 |
| 标签 | `phase-24-done` | 推送并记录 CI run |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M2-10 | QA / 内测 / M2 验收（长跑 → 全量 QA → 内测 → 验收 → 收口） | 19–23 | PRD M2 四条有证据；无 P0/P1；0.3.0 可安装 |
| 子项 | `E2E-M2-A` 100k 长跑 | 19–23 | 30 章 / 10 万字；无崩溃/孤儿/overflow |
| 子项 | `E2E-M2-SMOKE` 3 章 | 19–23 | 提交门 <4 分钟；覆盖 M2 新增面 |
| 子项 | 全量 QA | 全部 | 门禁、混沌、性能、安全、无障碍绿 |
| 子项 | 内测 | 全部 | 问题清单与里程碑；无 P0/P1 |
| 子项 | M2 验收报告 | 全部 | PRD 四条有命令与结果 |
| 子项 | 0.3.0 安装包 / 更新 / 标签 | 阶段 18 | 安装冒烟、更新演练 PASS；tag 推送 |

## 5 实现要点

### 5.1 `E2E-M2-A`（100k 长跑）

- 夹具：3 卷 × 10 章，每章 3 场 × 8 拍（24 拍/章），总字数 ≥100,000；5 角色；假模型 + 固定时钟；每拍文本唯一。可复用阶段 23 `PERF-M2-01` 的 seed 数据，但本 E2E 必须走真实 UI 流程，不复用 perf 的服务层断言。
- 流程：每章 G2 → 前 2 拍逐拍确认（含 1 次重生成）→ 自动模式跑完（带预算）→ G4 → G5（2 接受 1 拒绝）→ 复检 → G6 定稿 → G7 记忆应用 → 下一章。
- 断言：
  - 30 章 `finalized`、30 个 final revision、正文 ≥100,000 字。
  - 三卷（30 章）均走完 G2→G7；其中至少一卷作为验收抽样逐章检查，PRD 的「完成至少一卷」由更严格的全量完成覆盖。
  - 每 5 章 `project.verify()` 绿；0 孤儿 `revision_beat`、0 双活拍、0 failed job、0 `context_overflow`。
  - `memory_entry` active >0；30 份 `chapter_summary`；覆盖 30 章各场的 `voice_metric`；成本行覆盖 6 个 Agent；伏笔 open/closed 可读。
  - 自动模式预算段：`job.result_json.budget` 有 limit/used/reason；出口拍不被预算误暂停。
  - RSS 私有工作集合计 <600MB；工作集参考值单列。
- 运行时机：nightly / 发布前；提交门只跑 `E2E-M2-SMOKE`（3 章）。
- 不把 `E2E-M2-A` 的全量数字抄进验收报告；报告写实际运行输出与 run id。

### 5.2 `E2E-M2-SMOKE`（提交门）

- 3 章：G2 → 2 拍 → 自动 → G4 → G5 → 复检 → G6 → G7；覆盖 M2 的预算、声音徽标、成本报表打开、归档候选（有候选则打开面板，不执行）。
- 目标 <4 分钟；失败时保留 `test-results/` 与日志；不进 nightly 长跑的时间断言。
- 与 M1 smoke 分开，避免 M1 验收口径被 M2 新步骤污染。

### 5.3 M2 验收映射

`docs/M2-ACCEPTANCE.md` 按 PRD §10 M2 四条逐条写证据：

| # | PRD M2 标准 | 测试 ID | 证据 |
|---:|---|---|---|
| 1 | 10 万字项目可稳定推进并完成至少一卷 | `E2E-M2-A` | 30 章 / 100k 字 / 30 final / 每 5 章 verify 绿 / 三卷 G2→G7（至少一卷抽样） |
| 2 | 自动模式在预算内跑完一场并正确收束 | `E2E-M2-BUDGET-01` | 预算暂停/恢复；出口优先；`job.result_json.budget` |
| 3 | 声音区分度与伏笔回收率有基线报告 | `E2E-M2-METRICS-01` | `docs/M2-METRICS-BASELINE.md` 数字与语料/阈值版本 |
| 4 | 每万字成本可归因到章/Agent | `E2E-M2-COST-01` | `docs/M2-COST-BASELINE.md` + 报表对账 |

- 报告含：环境与版本（0.3.0 / schema / Electron / Windows）、每条命令与实际结果、任务验收表、安装/更新记录、安全/无障碍、已知问题与里程碑、复跑命令。
- 外部依赖（真实第二家 Key、Win10 22H2、外部内测）单列，写「未执行/作者决定」，不写成通过。
- 已知问题逐条给里程碑；不允许用「已知问题」替代 PRD 四条阻断项。

### 5.4 全量 QA

| 项 | 命令 / 证据 |
|---|---|
| 类型 / lint / 依赖边界 | `pnpm typecheck`、`pnpm lint`、`pnpm depcruise` |
| 单元 + 契约 | `pnpm test:unit`（含 T25 契约与 M2 新单测） |
| 集成 | `pnpm vitest run tests/integration` |
| 混沌 | `pnpm test:chaos`（CHAOS-01..09） |
| E2E | `pnpm test:e2e`（含 `E2E-M2-SMOKE`） |
| 100k 长跑 | `pnpm build && pnpm test:e2e:m2a`（nightly / 发布前） |
| 性能 | `pnpm test:perf`（PERF-01 + PERF-M1-01 + PERF-M2-01） |
| 安全 | `tests/unit/security.test.ts`、`tests/e2e/app.spec.ts`、诊断包扫描 |
| 无障碍 / 200% | `tests/e2e/a11y.spec.ts`、关键 M2 对话框 |
| 安装 / 更新 | `node scripts/install-smoke.mjs`、`node scripts/update-drill.mjs` |
| 生成物 / 规格 | `pnpm gen:check`、`check_ui_spec.py`、`check_tool_spec.py` |

- M1 关键回归每次发布前跑：`E2E-M1-TIME-01`、`E2E-M1-ASOF-01`、`E2E-M1-REBUILD-01`、`E2E-M1-BLUEPRINT-01`、`E2E-M1-BRANCH-01`、`E2E-M1-DOCX-01`、`E2E-M1-SMOKE`、`E2E-M1-A`。
- 版本 0.3.0：`package.json`、`app.info`、安装包文件名、`latest.yml` 一致；`schema_version` 记录实际（阶段 23 未使用 0015，仍为 14）。
- 安装冒烟：Win11 本机；Win10 22H2 有 VM 则跑，没有按外部依赖记录。
- 更新演练：`update-drill` PASS；人工「安装 → 重启 → 迁移」发布前在干净机跑一次，记录为人工步骤。

### 5.5 内测

- 作者自测：用 100k 项目连续使用 7 天 / 至少完成一卷；记录每拍确认耗时（`scheduler_event` 自动聚合）、每千字净操作时间（秒表，不含阅读）、卡点、崩溃、困惑点。
- 可选外部试用：2–3 位作者，给安装包 + 一页操作说明；不收集遥测，只收主动反馈。
- 问题分级：P0 数据丢失/无法启动；P1 阻断写作；P2 体验；P3 文案。P0/P1 必须修完或作者明确豁免；P2/P3 进 `docs/BACKLOG.md` 并给里程碑。
- 内测不改变 PRD M2 四条判定；外部试用缺失记录为外部依赖，不阻断收口。

### 5.6 收口

- `docs/M2-ACCEPTANCE.md` 自签；`docs/DEV-PLAN.md` 变更记录追加 M2 实施条目（迁移、测试 ID、契约变更）。
- `PROGRESS.md` 阶段 24 标 `done`，写 CI run、tag、安装包大小、已知问题。
- `AGENTS.md` 当前状态改为 M2 已收口、版本 0.3.0、schema 实际值。
- 标签：`phase-24-done`；发布标签 `v0.3.0-m2.1`（可选 `m2-done`）。标签打在 CI 全绿的提交上，不把文档提交当成验证。
- 安装包与 `latest.yml` 保留；`release/` 不入库。

## 6 验收清单

- [ ] `E2E-M2-A`：30 章 / 100,000+ 字 / 30 final；每 5 章 `project.verify()` 绿；0 孤儿 / 0 双活 / 0 failed job / 0 `context_overflow`；至少一卷 G2→G7；RSS <600MB（私有合计）。
- [ ] `E2E-M2-SMOKE`：3 章闭环；`pnpm test:e2e` 全绿；提交门 <4 分钟。
- [ ] `E2E-M2-BUDGET-01`：预算内跑完一场并正确收束；暂停/恢复不丢拍；`job.result_json.budget` 有证据。
- [ ] `E2E-M2-METRICS-01` + `docs/M2-METRICS-BASELINE.md`：声音区分度、伏笔回收率、阈值版本、语料/局限。
- [ ] `E2E-M2-COST-01` + `docs/M2-COST-BASELINE.md`：每万字成本、按章/Agent、项目级单列、对账一致。
- [ ] M1 关键回归全绿（时间线 / as-of / 重建 / 蓝图 / 分支 / DOCX / smoke / 30 章长跑）。
- [ ] 全量门禁：typecheck / lint / depcruise / unit / integration / chaos / e2e / perf / build / gen:check / 规格脚本。
- [ ] 安全：Key 无明文、诊断包无正文/Key、CSP/导航/只读锁、200% 缩放无截断。
- [ ] 安装冒烟 PASS（Win11，0.3.0，实际 schema）；更新演练 PASS；Win10 按外部依赖记录。
- [ ] `docs/M2-ACCEPTANCE.md` 写完并自签；外部依赖与已知问题有里程碑。
- [ ] 版本 0.3.0 三处一致；标签 `phase-24-done` 推送，CI run 记录在 PROGRESS。
- [ ] 内测清单：作者 100k 项目 7 天 / 一卷；P0/P1 清零或作者豁免；P2/P3 进 BACKLOG。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 100k E2E 太慢 | CI 超时 | nightly；提交门 3 章 smoke；拆片/加诊断 |
| 假模型文本同质 | 声音指标虚高 | 夹具按角色写不同句长/口头禅；断言有区分度 |
| 成本数据缺失 | 规划/讨论未计量 | 阶段 20 全链路计量先绿；报表标项目级/下限 |
| 无真实第二家 Key | 异构默认无法验证 | 保持 off；ADR 记录外部依赖；不伪造默认开启 |
| 外部内测缺失 | 没有试用作者 | 作者自测 + 记录外部依赖；不阻断 PRD 四条 |
| 验收赶工 | 四条只过一半 | 砍 P2/P3，不砍 PRD M2 四条；阶段不标 done |
| 版本/迁移不一致 | 安装包与 schema 对不上 | 三处版本 + `app.info` 断言；迁移测试先行 |

## 8 M2 收口条件

1. PRD §10 M2 四条全部有可复跑证据。
2. 10 万字项目稳定推进并完成至少一卷；自动模式预算内正确收束。
3. 声音/伏笔基线与每万字成本报告有数字、口径与局限。
4. M1 关键回归、全量门禁、安装/更新通过；无 P0/P1。
5. `docs/M2-ACCEPTANCE.md` 自签；`PROGRESS` / `AGENTS` / `DEV-PLAN` 同步；标签与安装包保留。
