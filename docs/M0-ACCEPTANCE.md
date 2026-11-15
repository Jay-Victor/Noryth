# M0 验收报告

> 阶段 10 交付物（`docs/PHASE-10-DELIVERY.md` §3/§5.5）｜日期：2026-11-15｜签字：作者本人（自签）
>
> 结论：**PRD §10 M0 的 11 条退出标准全部有可复跑的证据**；安装包在本机 Windows 11 x64
> 完成静默安装 → 启动 → 建项目（vec0 加载）→ 卸载冒烟。已知问题集中在「真实第二家供应商」
> 「bge 权重随包」「文件树抽屉」三项，均不阻断 PRD 的 M0 标准，逐条列在 §4。

## 0 环境与版本

| 项 | 值 |
|---|---|
| 仓库 | `E:\ALL_FOR_MY_PROJECTS\Noryth`，分支 `dev` |
| 版本 | Noryth 0.1.0，Electron 45.2.3，Chromium 156，Node 24（CI）/ 26（本机） |
| 数据库 | `LATEST_SCHEMA_VERSION = 7`（0001–0007） |
| 安装包 | `release/Noryth-0.1.0-setup.exe`（132,633,810 bytes ≈ 127MB）+ `latest.yml` |
| 运行系统 | Windows 11 x64（本机）；Windows 10 22H2 未单独测试（见 §4） |
| 模型 | 全部用假适配器/本地假服务器；CI 不调用真实 API |

## 1 PRD §10 M0 退出标准 → 证据（11 条）

| # | PRD 标准 | 测试 ID | 证据（命令 → 实际结果） |
|---:|---|---|---|
| 1 | 空项目到一章 3000+ 字定稿，全程无手工改库/文件 | `E2E-M0-A` | `pnpm test:e2e -- tests/e2e/m0-a.spec.ts` → ok（25.6s）。14 步：新建向导 → 规划 → G1 → 隔离 → 3×8 分镜 → G2 → 4 确认 2 重生成 → 自动跑到出口 → G4（2 阻断/3 建议）→ G5 → 3 patch 接受 2 拒绝 1 → 复检 → G6 定稿 → G7 固化 → 第 2 章写一拍 → 召回第 1 章记忆 → 导出 → 强杀重启。DB 只读断言；结束后 `db.verify()` 在用例内跑 |
| 2 | 默认逐拍确认路径可用 | `E2E-M0-BEAT` | `tests/e2e/write.spec.ts`（E2E-WRITE-01）→ ok：3 场 24 拍，前 6 拍 4 确认 + 2 重生成，重生成产生 superseded、无孤儿；`tests/e2e/m0-a.spec.ts` 第 6 步再跑一次 |
| 3 | 自动模式可显式开启并在出口条件处停 | `E2E-M0-AUTO` | `E2E-WRITE-02` → ok：自动在 `beats(3)` 处停，剩 3 拍 proposed；`E2E-M0-A` 第 7 步 → `draft_complete` |
| 4 | 至少两家预设可切换；一个 Agent 绑第二家仍能完成一章 | `E2E-M0-PROVIDER` | `pnpm test:e2e -- tests/e2e/provider.spec.ts` → ok（9.0s）：规划 DeepSeek；旁白前 3 拍 DeepSeek、改绑后 3 拍通义（真实 OpenAI-compatible 适配器 + 两个 Key，本地假服务器记录 `model` 与 `Authorization`）；审批绑通义后报告照常产出、`review.state().model.provider=tongyi`；`turn_metric` 两家都有真实用量 |
| 5 | 第 2 章检索到第 1 章定稿后的至少一条记忆 | `E2E-M0-MEMORY` | `E2E-M0-A` 第 12 步：第 2 章写一拍后 `memory.recall` 非空，且命中的 `memory_entry.source_chapter_id = 第 1 章`；`tests/e2e/memory.spec.ts`（E2E-MEMORY-01）独立再证一次 |
| 6 | 越权检索返回空 | `SEC-ISO-01` | `tests/unit/memory/retrieve.test.ts`（跨角色 0 命中、pinned 独立、as_of SQL 过滤）+ `E2E-M0-A` 第 4 步 `memory.isolation()` → `verified=true`；`E2E-M0-A` 第 11 步写向量后再跑一次 → 「通过」 |
| 7 | 审批 patch 可逐条接受/拒绝 | `E2E-M0-PATCH` | `E2E-REVIEW-01` → 3 patch：接受 2、拒绝 1，拒绝保留原文；`E2E-M0-A` 第 9 步同样结果；`tests/unit/review/patch-finalize.test.ts` 9 条 |
| 8 | 定稿只能由作者触发 | `SEC-GATE-01` | `tests/unit/review/patch-finalize.test.ts`（无 G6 记录/未勾选阻断拒绝；G5/G6 错实体/过期/复用拒绝）+ `E2E-REVIEW-01`（UI 只能从审批台 header 打开确认框，定稿后写正文 `already_finalized`） |
| 9 | 崩溃重启后已确认拍不丢 | `CHAOS-01` / `CHAOS-08` | `pnpm test:chaos` → ok（7.4s）：`CHAOS-01/02` 真子进程在事务中被 `taskkill /F`，无半条 revision、无孤儿、`integrity_check=ok`；`CHAOS-08` 30 章基线上强杀后逐拍比对 body/hash 零丢失；`E2E-M0-A` 第 14 步强杀安装版同源逻辑（开发版）后再比对 |
| 10 | 未授权工具不出现在模型工具列表 | `SEC-TOOL-01` | `tests/contract/registry.test.ts`（allowlist 零 diff、快照不漂移）+ `tests/contract/tool-contracts.test.ts` 36×6；`tests/integration/turn.spec.ts` 断言旁白/审批工具集与 manifest 一致 |
| 11 | `grounding` 引用全部来自本轮工具返回 | `SEC-GROUND-01` | `tests/unit/agents/validate.test.ts`（伪造 ID → `grounding_not_returned`；改写 quote → `grounding_quote_mismatch`）+ `tests/integration/turn.spec.ts` 伪造 grounding 两次失败 → `rejected` 零落盘 |

**判定**：11/11 通过；`E1 闭环` 14 步、`E2 铁律`、`E3 契约`、`E4 恢复`、`E5 回退`（M0 线性 revision 部分）、
`E6 规模`、`E7 安装` 均有对应证据（见 §2/§3）。

## 2 阶段 10 任务验收（I1–I4 / J1–J6）

| 任务 | 交付物 | 证据 |
|---|---|---|
| I1 供应商预设 + safeStorage + Key UI | `settings/secrets.ts`、`settings/service.ts`、`settings/safe-storage.ts`、`pages/settings/*` | `tests/unit/settings/secrets.test.ts` 5 条（文件无明文、换后端解密失败、删除、内存降级、summary 掩码）；`tests/e2e/settings.spec.ts` 扫描用户数据目录与项目目录，确认无 Key 明文；`secrets.bin` 只存密文 + 末 4 位 |
| I2 绑定表 + 继承 + 审计 + 回滚 | `model_binding_audit.batch_id`、`binding_rollback`（迁移 0007）、`settings/service.ts` | `tests/unit/settings/bindings.test.ts` 5 条（六 Agent 继承、实例→角色→项目→预设、批次审计、逐批回滚、同批不可重复回滚）；`tests/integration/provider-settings.spec.ts` 证明「改绑定只影响下一个 job」；`tests/e2e/settings.spec.ts` UI 保存/回滚 |
| I3 测试连接 + 能力/计价 | `model/probe.ts` 复用、`ProviderTestResult` | `tests/integration/provider-settings.spec.ts`：成功写能力快照、401 → `model_auth` + 建议；`tests/e2e/settings.spec.ts` 真实适配器打到假服务器，成功后 provider 卡显示「已连接」 |
| I4 外观 + token | `AppearanceSchema`、`lib/theme.ts`、`styles/tokens.css`、`styles/settings.css` | `tests/unit/settings/store.test.ts`（浅合并 + 补丁不带 default）；`tests/e2e/settings.spec.ts` 切暗色 → `<html data-theme=dark>`，重开应用保持 |
| J1 假 LLM + fixture | `tests/fake-llm/server.ts` + fixtures | `tests/unit/fake-llm/fixture-server.test.ts` 5 条（agent/beat/model/子串匹配、流式+工具+usage、错误注入、repeat:false、目录加载确定性） |
| J2 E2E M0-A | `tests/e2e/m0-a.spec.ts`、`tests/e2e/provider.spec.ts` | 见 §1 第 1/4 条 |
| J3 混沌 CHAOS-01..08 | `tests/chaos/*`、`pnpm test:chaos` | 7 条用例覆盖 8 个场景（01/02 合并）：事务中强杀、outbox 中断、apply 中断、数据库锁（5s → SQLITE_BUSY → `project_locked`）、写失败、更新中断、已确认拍零丢失 |
| J4 NSIS + 原生模块 + 自动更新 | `electron-builder.yml`、`scripts/install-smoke.mjs`、`src/main/update.ts` | `pnpm run dist` → 127MB NSIS + latest.yml；`node scripts/install-smoke.mjs` → PASS（静默安装 → `packaged=true, schema=7` → 建项目 → 只读连接加载安装目录 `resources/native/vec0.dll` 并 COUNT `memory_vec` → 卸载移除主程序）。更新检查后台执行、失败不阻塞（`CHAOS-07`） |
| J5 性能基线 + 诊断 | `tests/unit/perf/m0-baseline.test.ts`、`observability/diagnostics.ts` | PERF-01：30 章 / 720 拍 / 14.0 万字，切章 P95 1ms、检索 P95 27ms（2,000 条记忆 + 完整管线）、导出 14ms、RSS 234MB；打开 30 章的冷启动由 `tests/unit/db/perf.test.ts` 覆盖（约 400ms < 800ms，阶段 02 记录）。诊断包无正文/无 Key（`tests/e2e/diagnostics.spec.ts`） |
| J6 安全清单 + 无障碍 + 200% 缩放 | `tests/e2e/a11y.spec.ts`、`db/busy.ts` | 桥只有命名空间方法（无通用 invoke/send）、无 `require`；所有可见按钮有可读名字；200% 缩放下导航/状态栏/确认条无截断（修复了确认条不换行的真实缺陷） |

## 3 安装冒烟记录（本机 Windows 11 x64）

```
node scripts/install-smoke.mjs
[install-smoke] 静默安装到 C:\...\noryth-install-1794725900996
[install-smoke] 启动安装版
[install-smoke] app.info：version=0.1.0 schema=7 packaged=true
[install-smoke] 建项目成功：C:\...\安装冒烟
[install-smoke] memory_vec COUNT=0；PRAGMA user_version=7
[install-smoke] 卸载完成，主程序已移除
[install-smoke] PASS
```

检查项：无缺少 DLL、无 asar 路径错误、`resources/native/vec0.dll` 与 `resources/models/` 随包、
安装目录可写、卸载移除主程序；无签名（SmartScreen 可能在别的机器提示，M1 决策 D2）。

## 4 已知问题（不阻断 PRD M0，逐条给里程碑）

| # | 问题 | 影响 | 里程碑 |
|---:|---|---|---|
| 1 | **真实第二家供应商未补测**：DeepSeek 已实测（阶段 01 S3）；通义/OpenAI 只用本地 OpenAI-compatible 假服务器验证协议与路由 | PRD M0 第 4 条以「两家预设 + 路由」证明；真实 Key 缺失属外部依赖 | 作者提供 Key 后补测（ADR-0003） |
| 2 | **bge 权重不随包**：目录与 `extraResources` 已就位（`resources/models/README.md`），M0 用 `hash-bigram-v1`（512 维、确定性、离线） | 语义检索质量低于 bge；每条记忆记录真实模型名，向量通道按模型过滤 | M1：放权重 + T40 按章重建；体积 >250MB 或冷启动 >1.5s 时回退 q4/更小模型（ADR-0004） |
| 3 | **文件树抽屉未实现**：1440 下树区是 44px 图标轨道，Ctrl B 未展开抽屉 | UI-DESIGN §11「打开抽屉不改变正文列宽、焦点可进出」未满足；PRD M0 退出标准不包含此条 | M1（与「上下文检查器」一起做） |
| 4 | Windows 10 22H2 未单独测试 | 只在本机 Win11 做了安装/启动/建项/卸载；CI 是 windows-latest | 发布前找一台 Win10 VM 复跑 `scripts/install-smoke.mjs` |
| 5 | 自动更新通道已接线但无发布地址 | `NORYTH_UPDATE_FEED` 未配置时状态 `disabled`；`latest.yml` 已生成 | 首个 release tag 时配置 feed（GitHub Releases） |
| 6 | `tool_call` 审计面板未做 | PRD 列为 P1（工具调用指标面板） | M1 |
| 7 | 分支树、按章重建、as-of 时间线、关系图 | 均为 M1 范围（PRD §5.7） | M1 |

## 5 复跑命令

```bash
pnpm typecheck && pnpm lint && pnpm depcruise
pnpm test:unit                 # 605（unit+contract，含 PERF-01）
pnpm vitest run tests/integration   # 35
pnpm test:chaos                # 7 条 / 覆盖 CHAOS-01..08
pnpm test:e2e                  # 17（含 E2E-M0-A / E2E-M0-PROVIDER / J6）
pnpm build && pnpm gen:check
python docs/scripts/check_ui_spec.py
python docs/scripts/check_tool_spec.py --tools docs/tools --prd docs/PRD.md
pnpm run dist                  # NSIS
node scripts/install-smoke.mjs # 安装冒烟
```
