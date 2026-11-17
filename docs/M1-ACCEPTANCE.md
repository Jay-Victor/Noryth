# M1 验收报告

> 阶段 18 交付物（`docs/PHASE-18-DELIVERY-M1.md` §3/§5.4）｜日期：2026-11-17｜签字：作者本人（自签）
>
> 结论：**PRD §10 M1 的五条退出标准全部有可复跑的证据**（§1）。阶段 18 的四项代码任务
> （M1-7 / M1-15 / M1-23 / M1-25）完成并本地验证；安装包在 Windows 11 x64 完成
> 安装 → 启动 → 建项目 → 卸载冒烟，更新演练完成「检查 → 判定 → 下载」。
> **作者于 2026-11-17 决定不执行两项外部依赖**：Windows 10 22H2 安装冒烟（无 VM）与
> 真实第二家供应商补测（无 Key），见 §6 第 1/2 条；二者不改变 PRD M1 五条的判定，
> 阶段 18 据此收口，标签 `phase-18-done`。

## 0 环境与版本

| 项 | 值 |
|---|---|
| 仓库 | `E:\ALL_FOR_MY_PROJECTS\Noryth`，分支 `dev` |
| 版本 | Noryth 0.2.0，Electron 45.2.3，Chromium 156，Node 24（CI）/ 26（本机） |
| 数据库 | `LATEST_SCHEMA_VERSION = 11`（0001–0011；0011 为 `tool_call.chapter_id`） |
| 安装包 | `release/Noryth-0.2.0-setup.exe`（167,298,203 bytes ≈ 159.6MB）+ `latest.yml` + blockmap |
| 运行系统 | Windows 11 x64（本机）；Windows 10 22H2 作者决定不测（§6） |
| 模型 | 全部用假适配器/本地假服务器；CI 不调用真实 API |
| 图标 | `resources/icon.ico`（16–256，7 个 BMP 条目）+ `resources/icons/noryth-*.png`（16–512） |
| 阶段标签 | `phase-18-done` → `1f2b668`（2026-11-17，CI `44049244747` 全绿） |

## 1 PRD §10 M1 退出标准 → 证据（5 条）

| # | PRD 标准 | 测试 ID | 证据（命令 → 实际结果） |
|---:|---|---|---|
| 1 | 30 章项目可连续创作不崩 | `E2E-M1-A` | `pnpm build && pnpm test:e2e:m1a` → ok（20.8s）：3 卷 × 10 章，每章 3 场 × 6 拍（540 拍），每章 G2 → 2 拍 → 自动跑完 → G4 → G5（2 接受 1 拒绝）→ 复检 → G6 → G7。每 5 章 `project.verify` 绿；30 final / 30 final revision / 无孤儿拍 / 无 `context_overflow` / 无 failed job；记忆 active > 0、30 份章末摘要；内存私有合计 512MB（< 600MB，ch5 之后基本平台期），工作集合计 622MB（参考值，Electron 进程间共享 DLL 页不重复计入私有值） |
| 2 | 闪回场景不误报时间线 | `E2E-M1-TIME-01` | `tests/e2e/time.spec.ts` → ok：第 1 章「民国二十三年 三月初七 夜」、第 3 章「闪回 · 民国二十年 冬」；T23 返回 `idx=3`、`scenes[0].timeline='flashback'`、每拍 `storyTime='民国二十年 冬'`；**审批报告无 `type='timeline'` 条目**；DB 1 main + 1 flashback、0 跨章拍。`E2E-M1-SCENE-01` 再证引用场不参与本章顺序 |
| 3 | 改稿后按章重建记忆，旧记忆标 inactive | `E2E-M1-REBUILD-01` | `tests/e2e/memory-m1.spec.ts` → ok（16.4s）：14 提案 → G7 应用 8 条 → 按章重建（author_confirm）→ 旧 8 条 `inactive`、新 8 条 `active`、`rebuild` 审计；世界事实 1 author + 3 memory live + 3 closed；关系边 1 live + 1 closed；索引重建 8/8 归零。`E2E-M1-BRANCH-01` 再证「重开定稿 → 再定稿 → 自动 `memory.rebuild`」 |
| 4 | 第 3 章审查阅读不到第 20 章才揭示的事实 | `E2E-M1-ASOF-01` | `tests/e2e/asof.spec.ts` → ok：第 3 章审批的 `world.get_objective` 工具结果 as_of=24，含「早夭的名字」（旧事实、读者未知）、不含「祠堂夹层」（第 20 章才产生）；第 20 章审批 as_of=92 且看得到；`covered=0` 章复审 `invalid_args` 且零模型请求。`tests/integration/asof.spec.ts` 6 条同口径 |
| 5 | 导出 DOCX 通过 | `E2E-M1-DOCX-01` | `tests/e2e/export.spec.ts` → ok：3 章各 G2 + 生成确认一拍 → 全书 DOCX；XML 含 3 章标题与首段 + 「草稿 · 尚未定稿」+ 目录；无 Key / 日志 / secrets；两次直连导出 sha256 相同。本机 Word（Office16）打开 `OPEN_OK pages=6 words=1130 tocEntries=3`（阶段 17 记录） |

**判定**：5/5 通过，均有可复跑命令与 DB/文件级断言。

## 2 阶段 18 任务验收

| 任务 | 交付物 | 证据 |
|---|---|---|
| M1-7 签名 / 通道 / 更新 GA | `src/main/update.ts`（dev/beta/stable、semver 比较、同 minor 才允许回退）、`src/shared/schema/update.ts`、`AppInfo.update`、设置页「更新」卡、`scripts/update-drill.mjs`、`docs/adr/0006-release-channel.md`（D2/D3/D5） | `tests/unit/update.test.ts` 7 条：通道清单（latest.yml/beta.yml/dev.yml）、预发布排序、stable 忽略预发布、同 minor `downgrade` / 跨 minor `downgrade_blocked`、HTTP 500 → failed 不阻塞、状态文案含「不阻塞」；`node scripts/update-drill.mjs` → PASS（§4）；`CHAOS-07` 更新中断仍绿 |
| M1-15 QA / 硬化 | `tests/e2e/m1-flow.ts`（一章闭环）、`tests/e2e/m1-smoke.spec.ts`（3 章，提交门）、`tests/e2e-long/m1-a.spec.ts` + `playwright.m1a.config.ts`（30 章，nightly）、`project.verify`（dev 通道） | §1 第 1 条；`pnpm test:e2e` 32 条全绿（含 `E2E-M1-SMOKE` 2.5s / 私有 393MB）；`pnpm test:perf` 见 §3；安全/无障碍见 §5 |
| M1-23 `tool_call` 审计面板 | 迁移 0011（`chapter_id` + 两条回填 + 两个索引）、`ToolCallRepo.listByProject/countByProject/distinctActors`、`memory.toolCalls` IPC、`ToolCallList.tsx`、记忆台「审计 → 工具调用」 | `tests/unit/db/tool-call.test.ts` 3 条（章/Agent/状态过滤、50 条分页与上限、记录无 args 字段）；`tests/unit/migrator.test.ts` 0011（拍与 job 两条回填、无归属为 NULL、`verifyDatabase` 绿）；`tests/e2e/audit.spec.ts` → ok：真实审批回合落库、按章/Agent 过滤、失败空态、无「重放」按钮、API/UI 均无参数原文、`args_hash` 为 64 位十六进制 |
| M1-25 图标与品牌资源 | `scripts/gen-icons.mjs`（4× 超采样 + 手写 PNG/ICO）、`resources/icon.png` / `icon.ico` / `icons/*`、`electron-builder.yml`（`win.icon` + extraResources）、`src/main/brand.ts`、`window.ts` 图标参数 | `tests/unit/brand-icon.test.ts` 4 条（512 PNG、各尺寸 PNG、ICO 7 个 32 位 BMP 条目且偏移在文件内、`--check` 与脚本一致）；`pnpm dist` 打包时 rcedit 无报错；`ExtractAssociatedIcon(release/win-unpacked/Noryth.exe)` 取到 32×32 品牌图标（不是 Electron 默认）；`install-smoke` 断言 `resources/icons/*` 随包 |
| M1-26 真实第二家供应商补测 | —（外部依赖） | 未执行：无 DashScope/Moonshot Key。ADR-0003 已记录；`E2E-M0-PROVIDER` 用本地假服务器证明两家协议的切换与路由 |
| Win10 22H2 VM 安装冒烟 | —（外部环境） | 未执行：本机无 Win10 VM；Win11 见 §3。复跑命令：`node scripts/install-smoke.mjs` |
| `docs/M1-ACCEPTANCE.md` | 本文件 | PRD M1 五条逐条证据 + 已知问题里程碑 |

## 3 安装冒烟与性能记录（本机 Windows 11 x64）

```
node scripts/install-smoke.mjs
[install-smoke] 静默安装到 C:\...\noryth-install-1794901327016
[install-smoke] 启动安装版
[install-smoke] app.info：version=0.2.0 schema=11 packaged=true
[install-smoke] 嵌入器：{"model":"bge-small-zh-v1.5","source":"model","dim":512}
[install-smoke] 建项目成功：C:\...\安装冒烟
[install-smoke] memory_vec COUNT=0；PRAGMA user_version=11
[install-smoke] 卸载
[install-smoke] 卸载完成，主程序已移除
[install-smoke] PASS
```

检查项：无缺少 DLL、无 asar 路径错误、`resources/native/vec0.dll`、`resources/models/bge-small-zh-v1.5`、
`resources/icons/*` 随包；安装目录可写；卸载移除主程序。无签名（SmartScreen 可能提示，D2 决定不买证书，
发布时给 SHA256 + zip 便携版）。

```
pnpm test:perf
PERF-01    打开=1ms 切章P50=0ms/P95=2ms 检索P50=25ms/P95=26ms 导出=14ms(148104字) DOCX=147ms(20247B) RSS=217MB
PERF-M1-01 打开=2ms 切章P95=1ms 列表摘要P95=1ms RSS=150MB
```

对 §13.7：打开 < 800ms ✓、切章 P95 < 120ms ✓、检索 P95 < 80ms ✓、导出 < 2s ✓、内存 < 600MB ✓。

## 4 更新演练记录

`node scripts/update-drill.mjs`（打包形态 `release/win-unpacked/Noryth.exe` + 本地 feed）：

```
[update-drill] PASS manifest: Noryth-0.2.0-setup.exe · 0.2.0 · sha512 ok · 167298203 B
[update-drill] PASS boot: version=0.2.0 channel=stable status=up_to_date
[update-drill] PASS check:same: status=up_to_date version=0.2.0
[update-drill] PASS check:newer: status=available version=99.0.0
[update-drill] PASS check:older-minor: status=downgrade_blocked version=0.1.9
[update-drill] PASS check:error: status=failed version=null error=HTTP 500
[update-drill] PASS download: C:\Users\...\AppData\Local\noryth-updater\installer.exe（sha512 与清单一致）
[update-drill] RESULT: PASS
```

覆盖：通道目录（stable → 根 / beta、dev → 子目录）、semver 判定、跨 minor 回退拒绝、HTTP 失败不阻塞、
真实下载与 sha512 校验。

**未自动执行**（人工步骤，发布前在干净机执行一次）：
安装 v0.2.0 → 发布 v0.3.0 的 feed → 启动 → 检查到可用 → 下载 → 重启 → schema 迁移 → 打开旧项目。
自动安装会替换本机应用并需要人工确认，脚本不越权；同一份 `latest.yml` 格式已由上表验证。

## 5 安全与无障碍（DEV-PLAN §4.4 / UI-DESIGN §11）

| 项 | 结果 |
|---|---|
| `contextIsolation` / `nodeIntegration` / `sandbox` | `SECURE_WEB_PREFERENCES` + `assertSecurePreferences` 启动断言；`tests/unit/security.test.ts` 断言被改坏的配置会被拒绝；`tests/e2e/app.spec.ts` 断言渲染层无 `require`/`process`、桥是命名空间对象 |
| CSP / 导航 / 外链 | `tests/unit/security.test.ts`（生产 CSP 禁网络、dev CSP 只放行 dev server、`isAllowedNavigation` 只放行 `app://noryth` 与 dev 同源、`javascript:`/`file:` 拒绝）；`tests/e2e/app.spec.ts`（`fetch` 被 CSP 阻断、`window.open` 外部地址返回 null）。应用内当前没有外链入口，未接 `shell.openExternal` |
| Key 保管与日志脱敏 | `tests/unit/settings/secrets.test.ts` 5 条；`tests/e2e/settings.spec.ts` 扫描用户数据与项目目录无明文；诊断包全文扫描无 `sk-` |
| 诊断包 | `tests/e2e/diagnostics.spec.ts`：zip 头/CRC/可解压、无 `secrets.bin`、无正文 |
| 只读锁 | `tests/e2e/app.spec.ts` 双开只读；所有写入 IPC 在 main 侧拒绝 |
| 200% 缩放 / 抽屉焦点 | `tests/e2e/a11y.spec.ts`（几何 + `elementFromPoint` 断言）、`tests/e2e/tree.spec.ts`（焦点进出、Esc 归位） |
| 工具审计无参数原文 | `tests/e2e/audit.spec.ts`（API 字段 / UI 文案 / DB 只有 `args_hash`） |

## 6 已知问题（逐条给里程碑）

| # | 问题 | 影响 | 里程碑 |
|---:|---|---|---|
| 1 | **Windows 10 22H2 安装冒烟未执行**：本机只有 Win11；没有可用的 Win10 VM/云机。**作者决定不测（2026-11-17）** | PHASE-18 §6 的「Win11 + Win10 22H2」只完成 Win11；PRD M1 五条不受影响 | 外部依赖，不阻断 M1 收口；若将来补测，跑 `node scripts/install-smoke.mjs` |
| 2 | **真实第二家供应商未补测**：通义/OpenAI 只有本地 OpenAI-compatible 假服务器证据。**作者决定不测（2026-11-17）** | PRD M0 第 4 条与 M1 的五条不依赖真实第二家；异构复检默认 off | 外部依赖，不阻断 M1 收口；ADR-0003 / M1-26 保留 |
| 3 | 更新演练的「安装 → 重启 → 迁移」是人工步骤 | 自动脚本只覆盖检查/判定/下载；安装器与迁移本身由 install-smoke 与 `E2E-M1-A`/`0001→0011` 迁移测试覆盖 | 发布前在干净机按 §4 手动演练一次 |
| 4 | 30 章长跑不进提交门 | `E2E-M1-SMOKE`（3 章）在提交门；`E2E-M1-A` 在 nightly / 发布前 | 保持 nightly；发布前手动跑并记录 |
| 5 | 内存口径 | 断言用「全部进程私有工作集合计」< 600MB（500MB），工作集合计 628MB 作为参考 | 保持；若后续引入 Chromium 缓存优化再统一口径 |
| 6 | 分支不做合并、异构复检默认 off、摘要抽取式 | 均为 PRD M1 之外的 M2 范围 | M2-8 / M2 分支合并 |
| 7 | PRD §11 的「每拍确认耗时 / 每千字作者净操作时间」未埋点 | 无遥测（ADR-0006 / D3）；当前只有 `turn_metric` 的成本与延迟、`tool_call` 审计 | M2-5 成本/耗时报表（本地聚合，不上报） |

## 7 复跑命令

```bash
pnpm typecheck && pnpm lint && pnpm depcruise
pnpm test:unit                          # 794（unit+contract）
pnpm vitest run tests/integration       # 46
pnpm test:chaos                         # 8 / CHAOS-01..09
pnpm test:e2e                           # 32（含 E2E-M1-SMOKE / E2E-M1-TOOLCALL）
pnpm build && pnpm test:e2e:m1a         # 30 章长跑（nightly / 发布前）
pnpm test:perf                          # PERF-01 + PERF-M1-01
pnpm build && pnpm gen:check
node scripts/gen-icons.mjs --check
python docs/scripts/check_ui_spec.py
python docs/scripts/check_tool_spec.py --tools docs/tools --prd docs/PRD.md
pnpm dist                               # NSIS + latest.yml
node scripts/install-smoke.mjs          # 安装冒烟
node scripts/update-drill.mjs           # 更新演练（manifest + 判定 + 下载）
```
