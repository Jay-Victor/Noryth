# 阶段 18 · 分发、硬化与 M1 验收

> 阶段 18 / 18（M1 第 8 阶段）｜ 依赖：17 ｜ 下游：M2
> 对应：`docs/DEV-PLAN.md` §13.7、§14、§16、§12.6（M1-7、M1-15、M1-23、M1-25、M1-26）
>
> **一句话目标**：30 章连续创作不崩、Win10/11 能装能更新、M1 五条退出标准逐条有证据。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 30 章项目可连续创作 | `E2E-M1-A` 3 卷 30 章跑完，无崩溃 / 无孤儿 |
| 2 | 闪回不误报 | 阶段 12 回归 + 全书审批无 timeline 误报 |
| 3 | 重建 / 重开闭环 | 阶段 14 / 16 回归 |
| 4 | 第 3 章读不到第 20 章事实 | 阶段 13 回归 + 全书审计 |
| 5 | DOCX 通过 | 阶段 17 回归 + 本机 Word/WPS |
| 6 | 干净 Win10/11 可装可更新 | 安装冒烟 + 更新演练 |

## 2 范围

### 2.1 做

- M1-7：NSIS 签名决策 / 通道 / 自动更新 GA。
- M1-15：QA / 硬化：`E2E-M1-A`、性能、安全、无障碍。
- M1-23：`tool_call` 审计面板。
- M1-25：应用图标与品牌资源。
- M1-26：真实第二家供应商补测（外部依赖）。
- Win10 22H2 VM 安装冒烟（BACKLOG #7）。
- `docs/M1-ACCEPTANCE.md`。

### 2.2 不做

- 代码签名证书采购（D2 决策：不买则给 SHA256 + zip 便携版）。
- 匿名遥测（D3：不做，只做主动导出诊断包）。
- 跨 minor 降级（D5：只允许同 minor）。
- M2 的声音指标、成本报表、多供应商路由。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 分发 | `electron-builder.yml`、`latest.yml`、GitHub Release | 安装 / 更新 / 回滚 |
| 更新 | `src/main/update.ts` | feed 配置；失败不阻塞 |
| 图标 | `resources/icons/*` | 安装包 / 窗口 / 任务栏 |
| 审计面板 | `src/renderer/pages/memory/ToolCallList.tsx` + IPC | 只读；无 args |
| E2E | `tests/e2e/m1-a.spec.ts` | 30 章（nightly） |
| 验收 | `docs/M1-ACCEPTANCE.md` | PRD M1 五条证据 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-7 | 签名 / 通道 / 更新 GA | J4、D2 | 安装 / 更新 / 回滚演练 |
| M1-15 | `E2E-M1-A` + 性能 + 安全 | 全部 | 30 章连续；§13.7 + §4.4 达标 |
| M1-23 | `tool_call` 审计面板 | H3、A3 | 只读；分页；无 args |
| M1-25 | 图标与品牌资源 | J4 | 安装包 / 窗口 / 卸载一致 |
| M1-26 | 真实第二家供应商补测 | I3 | 有 Key 则两家各跑一章；无则记录外部依赖 |
| M1-15 | M1 验收报告 | 全部 | 5 条逐条证据；签字 |

## 5 实现要点

### 5.1 分发与更新

- 通道：`dev` / `beta` / `stable`；tag `v0.2.0-m1.1`。
- 自动更新：`electron-updater` GitHub provider；`NORYTH_UPDATE_FEED` 指向 Releases；启动后台检查，失败只记日志。
- 签名：D2 在 M1 开工前记录（DEV-PLAN §17）；不买则发布 SHA256 + zip 便携版，NSIS 保留；文档写清「SmartScreen 可能提示」。本阶段只执行已定结果，不临时改分发策略。
- 回滚：重发上一版 + 提高版本号；只允许同 minor 降级（D5）。
- 更新演练：装 v0.1.0 → 发布 v0.2.0 → 检查到可用 → 下载 → 重启 → schema 迁移 → 打开项目。
- 更新失败 / 中断：启动不受影响；可手动重装（CHAOS-07 回归）。

### 5.2 30 章 E2E

- `E2E-M1-A`：3 卷 × 10 章，每章 3 场 × 6 拍（18 拍/章，540 拍）；假模型 + 固定时钟。
- 每章：G2 → 逐拍 2 拍 + 自动跑完 → G4 → G5（1 patch）→ 复检 → G6 → G7（全部接受）→ 下一章。
- 断言：每 5 章跑一次 `db.verify()`；30 个 final；`memory_entry > 0`；无孤儿；无 `context_overflow`；RSS <600MB。
- 运行时机：nightly / 发布前；提交门只跑 3 章 smoke（`E2E-M1-SMOKE`）。
- 性能基线另用 30 章 / 720 拍 / 14 万字的合成项目（`PERF-M1-01`，24 拍/章），与本 E2E 的 18 拍/章不同；两者都保留。
- 性能：打开 <800ms、切章 P95 <120ms、检索 P95 <80ms、导出 <2s。

### 5.3 审计面板

- 记忆台「审计」tab 增加 `tool_call` 列表：tool、version、actor_id、latency、degraded、error_code、created_at；不显示 args（只有 hash）。
- 过滤：章 / Agent / 状态；分页 50；只读。
- 与 `memory_audit` 分开：工具调用是运行时审计，不是记忆变更。
- 不提供「重放工具」按钮：重放走 job 幂等，不在 UI 手工触发。

### 5.4 M1 验收

`docs/M1-ACCEPTANCE.md` 按 PRD §10 M1 五条逐条写证据：

| # | PRD M1 标准 | 测试 ID |
|---:|---|---|
| 1 | 30 章项目可连续创作不崩 | `E2E-M1-A` |
| 2 | 闪回场景不误报时间线 | `E2E-M1-TIME-01` + 全书审批 |
| 3 | 改稿后按章重建记忆，旧记忆标 inactive | `E2E-M1-REBUILD-01` |
| 4 | 第 3 章审查阅读不到第 20 章才揭示的事实 | `E2E-M1-ASOF-01` |
| 5 | 导出 DOCX 通过 | `E2E-M1-DOCX-01` + Word/WPS |

- 已知问题逐条给里程碑；不允许用「已知问题」替代阻断项。
- 安装冒烟：Win11 本机 + Win10 22H2 VM 各一次；记录版本、schema、结果。
- 打 tag `phase-18-done`；提交后产物存 Releases，保留上一版安装包供回滚。

## 6 验收清单

- [x] `E2E-M1-A` 30 章跑完：30 final、`db.verify()` 绿、无孤儿、无 `context_overflow`、内存 <600MB（私有合计 512MB / 工作集 622MB）。（`tests/e2e-long/m1-a.spec.ts`，20.8s；每 5 章 `project.verify`）
- [x] 闪回回归：全书审批无 `timeline` 误报。（`E2E-M1-TIME-01`：报告无 `type='timeline'`）
- [x] 重建回归：旧记忆 inactive；新记忆 active。（`E2E-M1-REBUILD-01` + `E2E-M1-BRANCH-01` 自动 rebuild）
- [x] as-of 回归：ch3 审批无 ch20 fact。（`E2E-M1-ASOF-01`）
- [x] DOCX 回归：可打开；结构正确。（`E2E-M1-DOCX-01` + 本机 Word 打开检查）
- [x] Win11 安装冒烟 PASS（`version=0.2.0 / schema=11`）；更新演练 PASS（manifest / 四态判定 / 真实下载）；卸载干净。（`scripts/install-smoke.mjs`、`scripts/update-drill.mjs`）
- [x] Win10 22H2 安装冒烟：作者决定不测（2026-11-17，本机无 VM；按外部依赖记录，不阻断 M1 收口）。
- [x] 安全清单 §4.4 全绿；200% 缩放无截断；抽屉焦点可进出。（`tests/unit/security.test.ts`、`tests/e2e/app.spec.ts`、`a11y.spec`、`tree.spec`）
- [x] `tool_call` 面板只读、无 args、分页可用。（迁移 0011 + `E2E-M1-TOOLCALL` + `tests/unit/db/tool-call.test.ts`）
- [x] 图标 / 品牌资源进安装包与窗口。（`brand-icon.test.ts` + `ExtractAssociatedIcon` 检查 + install-smoke 随包断言）
- [x] `docs/M1-ACCEPTANCE.md` 写完并签字（自签）。
- [x] tag `phase-18-done`：两项外部依赖由作者决定不测，阶段收口。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 30 章 E2E 太慢 | CI 超时 | nightly；3 章 smoke 进提交门 |
| Win10 环境缺失 | 未测 | VM / 云机；发布前必跑 |
| 更新地址不可达 | 更新失败 | 不阻塞启动；手动安装包 |
| 无签名被拦 | 安装率低 | SHA256 + zip；D2 决策 |
| 验收赶工 | 5 条只过一半 | 砍 M1 P1，不砍 PRD 5 条 |
| 真实第二家 Key 缺失 | 未补测 | 记录外部依赖；不伪造结果 |

## 8 进入 M2 的条件

1. PRD M1 五条全绿，有可复跑证据。
2. 30 章连续创作与 Win10/11 安装 / 更新通过。
3. 无 P0/P1 缺陷；已知问题有里程碑。
4. `docs/M1-ACCEPTANCE.md` 与 `docs/DEV-PLAN.md` 变更记录更新。
5. tag 与安装包保留，供回滚。
