# M2 验收报告

> 阶段 24 交付物（`docs/PHASE-24-DELIVERY-M2.md` §3 / §5.3）｜日期：2026-11-24｜签字：**Agent 代审（作者委托，2026-11-24）**；作者本人可随时抽查（§5.2）
>
> 结论：**PRD §10 M2 的四条退出标准全部有可复跑证据**（§1）；全量门禁、10 万字长跑、
> 0.3.0 安装包、安装冒烟与更新演练均已在本机执行。**内测的「作者 100k 项目连续使用 7 天 /
> 至少完成一卷」是人工项，作者于 2026-11-24 委托 Agent 按机器证据代审（§5.2）**：以
> `E2E-M2-A` 的 30 章 / 142,344 字长跑与可复跑门禁替代人工 7 天；**这不是人工签字，也不是
> 真实 7 天使用的结论**，作者可随时补跑/抽查。据此收口，标签 `phase-24-done`。

## 0 环境与版本

| 项 | 值 |
|---|---|
| 仓库 | `E:\ALL_FOR_MY_PROJECTS\Noryth`，分支 `dev` |
| 版本 | Noryth **0.3.0**，Electron 45.2.3，Chromium 156，Node 26.12.1（本机）/ 24（CI） |
| 数据库 | `LATEST_SCHEMA_VERSION = 14`（0001–0014；阶段 23/24 未新增迁移，0015 未使用） |
| 安装包 | `release/Noryth-0.3.0-setup.exe`（167,340,425 B ≈ 159.6MB）+ `latest.yml` + blockmap |
| 运行系统 | Windows 11 x64（本机）；Windows 10 22H2 作者决定不测（§8） |
| 模型 | 全部假适配器/本地假服务器（`NORYTH_*_FAKE=1`）；CI 不调用真实 API |
| 夹具模式 | 阶段 24 新增 `NORYTH_WRITE_FAKE_LONG=1`：每拍 ≥150 字、按角色分句长/口头禅（仅未打包构建） |
| 阶段标签 | `phase-24-done` → `f637b60`（CI run `45425757554`；annotated tag `b707193`） |

## 1 PRD §10 M2 退出标准 → 证据（4 条）

| # | PRD M2 标准 | 测试 ID | 证据（命令 → 实际结果） |
|---:|---|---|---|
| 1 | 10 万字项目可稳定推进并完成至少一卷 | `E2E-M2-A` | `pnpm build && pnpm test:e2e:m2a` → ok（**27.8s**）。3 卷 × 10 章 × 3 场 × 8 拍 = 30 章 / 720 拍；**142,344 字确认正文**（含重生成/补丁的 `beat` 合计 160,887 字）；30 final / 30 final revision；每 5 章 `project.verify()` 绿；**三卷全部逐章走完 G2 → 2 拍（含 1 次重生成）→ 自动 → G4 → G5（2 接受 1 拒绝）→ 复检 → G6 → G7**（抽样要求由更严格的全量完成覆盖）；0 孤儿 / 0 双活拍 / 0 failed job / 0 `context_overflow`；240 条 active 记忆 / 240 向量 / 30 份章末摘要；151 行声音指标覆盖 30 章 / 90 场景 / 91 revision（测试 stats 收尾前为 150；G4 同步 + 关账预热，派生表按 revision 累积）；`turn_metric` 覆盖 6 个 Agent；伏笔 3 埋设 / 2 回收 / 1 open；私有内存 514–520MB（ch5 399MB → ch30 519MB，1.29× < 1.5×） |
| 2 | 自动模式在预算内跑完一场并正确收束 | `E2E-M2-BUDGET-01` | `pnpm test:e2e` → ok：¥0.01 预算 → 费用暂停（`write-pause-banner[data-reason=budget_exceeded]`）→ 提高预算 → 恢复 → `draft_complete`；已确认拍逐字不变、无重复暂停账本；`job.result_json.budget` 有 `tokens_limit=120000 / tokens_used>0 / cost_limit=0.01 / cost_used≥0.01 / reason=cost`。出口优先由 `tests/integration/budget.spec.ts` 覆盖（预算 500 tokens、出口 `beats(1)`：1 拍后 `draft_complete`、无 paused 事件、`scene_closed(reason=exit_satisfied)`）。`E2E-M2-A` 的第 1 章另带 ¥2 章预算整章跑完：无 `auto_budget_pause`、实际花费 ¥0.1248 < ¥2 |
| 3 | 声音区分度与伏笔回收率有基线报告 | `E2E-M2-METRICS-01` | `pnpm test:e2e` → ok；`docs/M2-METRICS-BASELINE.md`：阈值 `zh-v1` / 0.252（语料 sha256 `c469b5…4712`，20 场 / 50 实例，FPR 2.0% / TPR 97.5%）；30 章长跑复测（`docs/M2-METRICS-BASELINE.md` §3.1）：90/90 场景有指标、270 对、0 对低于阈值、最低一对 0.4333；伏笔 3 埋设 / 2 回收 / 1 open、回收率 0.667、超期 1。同构夹具（3/3 低于阈值、最低 0.00）与分风格夹具（0/270 低于阈值）覆盖告警两侧 |
| 4 | 每万字成本可归因到章/Agent | `E2E-M2-COST-01` | `pnpm test:e2e` → ok（报表与 IPC/DB 对账、空态与费用下限）；30 章长跑（`scripts/m2-cost-baseline.mjs`，只读）：**¥3.67252 / 142,344 字 = ¥0.2580 每万字**；分章 ¥0.12208–0.1248（29–30 次调用，`costPer10k` 0.2569–0.2640）；按 Agent：角色 42.22% / 审批 33.72% / 旁白 13.33% / 记忆 10.46% / 规划 0.20% / 编排 0.07%；项目级规划费用 ¥0.0074 单列（`chapter_id IS NULL`）；872 次有计价调用 / 0 次无计价 |

**判定**：4/4 通过，均有命令、测试 ID 与实际输出。第 1 条的机器替代与代审口径见 §5.2。

## 2 阶段 24 任务验收（M2-10）

| 任务 | 交付物 | 证据 |
|---|---|---|
| M2-10 QA / 内测 / M2 验收 | `tests/e2e/m2-flow.ts`、`tests/e2e/m2-smoke.spec.ts`、`tests/e2e-long/m2-a.spec.ts`、`playwright.m2a.config.ts`、`pnpm test:e2e:m2a`、`NORYTH_WRITE_FAKE_LONG`、`docs/M2-ACCEPTANCE.md`、0.3.0 安装包 | §1 / §3 / §4 / §6；全量门禁与打包均执行 |
| 子项：`E2E-M2-A` 100k 长跑 | 同上 | §3：30 章 / 142,344 字 / 30 final / 每 5 章 verify / 0 孤儿 / 0 双活 / 0 failed / 0 overflow |
| 子项：`E2E-M2-SMOKE` 3 章 | `tests/e2e/m2-smoke.spec.ts` | `pnpm test:e2e` 内：**3.6s**（提交门 < 4 分钟）；覆盖预算、声音徽标、成本对话框、归档候选面板（不执行） |
| 子项：全量 QA | §4 表 | typecheck / lint / depcruise / unit 878 / integration 61 / chaos 8 / e2e 42 / perf 4 / M1-A 30 章 / build / gen:check / 规格脚本 / 图标 |
| 子项：内测 | §5 | 机器可测项已完成；作者 2026-11-24 委托 Agent 代审（§5.2：机器 1/2/5 通过、4 部分、3 无法代审、6 未执行）；人工 7 天/秒表/外部试用仍建议作者抽查（外部依赖，不阻断 PRD 四条） |
| 子项：0.3.0 安装包 / 更新 / 标签 | §6 | `release/Noryth-0.3.0-setup.exe`（159.6MB）+ `latest.yml`；安装冒烟 PASS；更新演练 PASS；标签 `phase-24-done` → `f637b60`（CI `45425757554`） |
| 本报告 | `docs/M2-ACCEPTANCE.md` | 本文件 |

## 3 10 万字长跑记录（`E2E-M2-A`）

- 命令：`pnpm build && pnpm test:e2e:m2a`（本地 2026-11-24；配置 `playwright.m2a.config.ts`，
  `testIgnore` 把 M1 长跑与成本夹具排除，`pnpm test:e2e:m1a` 也不会跑本用例）。
- 夹具：`tests/e2e/m2-flow.ts` 的 `seedLongrun`（devSeed 3 卷 / 30 章 / 5 角色 → 逐章
  `write.saveStoryboard` 覆盖为 3 场 × 8 拍、角色 A/B/C/旁白轮换；意图含章-场-拍号，
  正文由假适配器按角色风格生成，每拍唯一）。
- 流程：项目级 1 次规划对话（planner 成本行）→ 章 1 预置 ¥2 章预算 + 1 次编排对话 →
  每章 G2 → 2 拍（第 2 拍重生成 1 次）→ 自动 → G4 → G5（2 接受 1 拒绝）→ 复检 →
  G6 → G7。
- 实际输出（测试末尾的 `E2E-M2-A stats`）：

```json
{"chapters":30,"finals":30,"confirmedWords":142344,"allWords":160887,
 "memories":240,"vectors":240,"summaries":30,"voiceRows":150,"voiceChapters":30,
 "agents":6,"firstChapterCostCny":0.1248,"toolCalls":180,"plannerToolCalls":2,
 "workingSetMb":649,"privateMb":520,"slowestChapterMs":1001,
 "bestPairScore":0.454,"thresholdVersion":"zh-v1"}
```

- 逐章耗时：ch5 0.71s → ch30 0.91s（每 5 章采样），最慢章 1.26s；总时长 27.8s。
- 数据库：`job` 900 条全部 `succeeded`；`beat` 720 confirmed + 810 superseded（G2 占位、
  重生成旧版、补丁旧稿）；`revision` 810 draft + 30 final；`outbox` 810 条。
- 伏笔：3 条作者标注（第 1/10/15 章），跑完后回收第 20 / 25 章的两条，留 1 条 open；
  `scripts/m2-baseline.mjs` → 回收率 0.667、超期 1。
- 说明：`stats.voiceRows=150` 是测试收尾调用 `voice.scene` 之前的行数；随后同一场景按 final revision 再算一行，DB 最终 151 行（90 场景 / 91 revision）。
- 说明：首跑在 `tool_call` 归章断言上失败（2 条规划工具调用 `chapter_id=NULL`，这是
  PHASE-20 的既定口径）；断言改为「非 planner 的 NULL = 0」后重跑通过，产品代码未改。
  这条记录保留，避免以后把项目级规划调用误判成归属缺失。

## 4 全量门禁（本地，2026-11-24）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| Lint | `pnpm lint` | 通过（新增 m2-flow / m2-a / m2-smoke / 长文本假适配器） |
| 依赖边界 | `pnpm depcruise` | 345 modules / 1,733 deps，0 违规 |
| 单元 + 契约 | `pnpm test:unit` | 878 passed（111 文件） |
| 集成 | `pnpm vitest run tests/integration` | 61 passed |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | **42 passed（4.1m，含 `E2E-M2-SMOKE` 3.6s）** |
| M1 长跑 | `pnpm test:e2e:m1a` | 1 passed（21.6s）/ 1 skipped（成本夹具，默认 skip）；30 章 / 540 拍，私有 514MB |
| 性能 | `pnpm test:perf` | 4 passed：`PERF-01` 打开 2ms / 切章 1ms / 检索 P95 3ms / 导出 13ms（148,104 字）/ DOCX 111ms / RSS 307MB；`PERF-M1-01` 打开 3ms / 切章 1ms / 摘要 1ms / RSS 150MB；`PERF-M2-01` 打开 P95 31.1ms / 切章 1.2ms / T23 0.4ms / 检索 8.7ms / 装配 5.2ms / 报表 1.6ms / 声音 1.1ms / 归档 29.9ms / MD 14.9ms / DOCX 207.1ms / RSS 258.5MB / 查询 8-9-9-8-4 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 图标 | `node scripts/gen-icons.mjs --check` | `icons ok: 9 files` |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS（§6） |
| 更新演练 | `node scripts/update-drill.mjs` | PASS（§6） |

## 5 内测

### 5.1 机器可测项（已完成）

| 项 | 数值 / 结论 |
|---|---|
| 每拍确认耗时 | P50 **23ms** / P95 **30ms**（60 个作者确认样本；自动确认 690 拍计缺失，不补 0） |
| 30 章连续使用（机器） | `E2E-M2-A` 27.8s 内完成 30 章；无崩溃、无 failed job、无孤儿、无 overflow |
| 内存 | 私有 514–520MB（门槛 600MB）；ch5 → ch30 1.29×（门槛 1.5×） |
| 长跑重复使用同一项目 | 收尾 `page.reload()` + `project.verify()` 绿（会话不残留锁/半条正文） |

### 5.2 作者委托 Agent 代审（2026-11-24）

作者决定：**7 天人工自测由 Agent 按现有机器证据代审**，记录为「Agent 代审（作者委托）」。
代审只回答「清单里每一项是否已有可复跑的机器证据」，**不冒充人工 7 天使用，也不冒充签字**。

| # | 内测清单项 | 证据来源 | 代审结论 |
|---:|---|---|---|
| 1 | 100k 项目连续使用 7 天 / 至少完成一卷 | `E2E-M2-A` 30 章 / 3 卷 / 142,344 字 / 27.8s；每章 G2→G7；`job` 900 条全 succeeded | **代审通过（机器替代）**：系统在 10 万字规模下可连续推进并完成三卷；真实 7 天的人工使用未执行 |
| 2 | 每拍确认耗时 | 长跑 `scheduler_event` 聚合：P50 23ms / P95 30ms（60 样本；自动确认 690 拍计缺失） | **通过（机器）** |
| 3 | 每千字作者净操作时间（秒表） | 无埋点（ADR-0006 D3 不做遥测），本轮没有秒表数据 | **无法代审**：该项只能由作者本人执行，不进入 PRD M2 四条判定 |
| 4 | 卡点 / 崩溃 / 困惑点 | 30 章长跑 0 崩溃、0 failed job、0 孤儿、0 overflow、`project.verify()` 每 5 章与收尾均绿；困惑点（UI 文案/交互）无数据 | **部分代审**：运行时稳定性通过；主观困惑点无法代审 |
| 5 | P0/P1 清零 | 全量门禁与长跑未发现 P0/P1；P2/P3 已登记 `docs/BACKLOG.md` #15–#17 | **通过（机器）** |
| 6 | 外部试用（2–3 位作者） | 未执行；无试用作者名单 | **未执行（外部依赖）**：`docs/BACKLOG.md` #17，首次公开发布前做 |

确定性计分：6 项中 **3 项通过（1/2/5）**、**1 项部分（4）**、**1 项无法代审（3）**、**1 项未执行（6）**。
结论：机器可测面已闭合；第 3 项与第 6 项保留为**未执行的人工/外部项**，不写成通过。
**建议作者在真实项目上抽查**：打开长跑项目看一章正文与审批报告、按一次自动模式、导出一次
DOCX，确认主观体验；若发现 P0/P1，按 `docs/PHASE-24-DELIVERY-M2.md` §7 回退并重开阶段。

### 5.3 当前问题清单

- 本轮自动化与代审未发现 P0/P1。
- P2/P3 已登记：长跑内存余量（BACKLOG #15）、`voice_metric` 按 revision 累积（#16）、
  外部内测未执行（#17）；其余沿用 M1 已知问题（§8）。

## 6 安装 / 更新 / 版本

```
pnpm dist
release/Noryth-0.3.0-setup.exe  167,340,425 B（≈159.6MB）+ latest.yml + blockmap

node scripts/install-smoke.mjs
[install-smoke] 静默安装到 C:\...\noryth-install-1795533206259
[install-smoke] app.info：version=0.3.0 schema=14 packaged=true
[install-smoke] 嵌入器："model":"bge-small-zh-v1.5","source":"model","dim":512
[install-smoke] 建项目成功：C:\...\安装冒烟
[install-smoke] memory_vec COUNT=0；PRAGMA user_version=14
[install-smoke] 卸载完成，主程序已移除
[install-smoke] PASS
```

```
node scripts/update-drill.mjs
[update-drill] PASS manifest: Noryth-0.3.0-setup.exe · 0.3.0 · sha512 ok · 167340425 B
[update-drill] PASS boot: version=0.3.0 channel=stable status=up_to_date
[update-drill] PASS check:same: status=up_to_date version=0.3.0
[update-drill] PASS check:newer: status=available version=99.0.0
[update-drill] PASS check:older-minor: status=downgrade_blocked version=0.1.9
[update-drill] PASS check:error: status=failed version=null error=HTTP 500
[update-drill] PASS download: ...\installer.exe（sha512 与清单一致）
[update-drill] RESULT: PASS
```

- 版本三处一致：`package.json` 0.3.0、安装包文件名 `Noryth-0.3.0-setup.exe`、`app.info` 0.3.0。
- 未签名（ADR-0006 D2 不买证书）：SmartScreen 可能提示；发布时附 SHA256。
- **未自动执行**（人工步骤，发布前在干净机执行一次）：安装 0.3.0 → 用上一版 feed
  检查到可用 → 下载 → 重启 → schema 迁移 → 打开旧项目。

## 7 安全与无障碍

| 项 | 结果 |
|---|---|
| `contextIsolation` / `nodeIntegration` / `sandbox` | `SECURE_WEB_PREFERENCES` + 启动断言；`tests/unit/security.test.ts` 与 `tests/e2e/app.spec.ts`（渲染层无 `require`/`process`） |
| CSP / 导航 / 外链 | 生产 CSP 禁网络；`fetch` 被阻断、`window.open` 外部地址返回 null（e2e 复跑绿） |
| Key 与日志 | `tests/unit/settings/secrets.test.ts` 5 条；设置 E2E 扫描目录无明文；诊断包全文无 `sk-` |
| 只读锁 | 双开只读 + 写 IPC 在 main 侧拒绝（e2e） |
| 工具审计 | `E2E-M1-TOOLCALL`：API/UI/DB 三层都无参数原文，只有 `args_hash` |
| 无障碍 / 200% | `a11y.spec`（几何 + `elementFromPoint`）、`tree.spec`（焦点进出）复跑绿 |

## 8 已知问题（逐条给里程碑）

| # | 问题 | 影响 | 里程碑 |
|---:|---|---|---|
| 1 | **Windows 10 22H2 安装冒烟未执行**（本机只有 Win11）。**作者决定不测（2026-11-17）** | 只完成 Win11；PRD M2 四条不受影响 | 外部依赖；有 VM 时跑 `node scripts/install-smoke.mjs` |
| 2 | **真实第二家供应商未补测**（无 DashScope/Moonshot Key）。**作者决定不测** | 异构复检默认 `off`；路由用假服务器证明协议 | 外部依赖（ADR-0003 / M1-26）；有 Key 时按 ADR 清单补测 |
| 3 | 更新演练的「安装 → 重启 → 迁移」是人工步骤 | 脚本只覆盖检查/判定/下载 | 发布前干净机手动一次 |
| 4 | 30 章长跑不进提交门 | 提交门只有 3 章 smoke | 保持 nightly（`.github/workflows/nightly.yml` 的 `m1-a` / `m2-a`） |
| 5 | **GitHub Release 未上传**：`release/` 按规则不入库 | 仓库内只有构建脚本与 `latest.yml`；更新 feed 未配置 | 首个 release tag（`v0.3.0-m2.1`）时上传 NSIS + `latest.yml` + blockmap，并配置 `NORYTH_UPDATE_FEED` |
| 6 | **作者 7 天自测未执行**；作者委托 Agent 代审（2026-11-24，§5.2） | PRD M2 四条不依赖该项；代审以 30 章长跑替代机器面，不冒充人工使用 | 作者可随时补跑/抽查；若发现 P0/P1 按 §7 重开阶段 |
| 7 | 外部内测（2–3 位作者）未执行 | 同上 | 首次公开发布前（BACKLOG #17） |
| 8 | 长跑内存余量（私有 514–520MB，门槛 600MB） | 当前通过，余量约 80–86MB | M2 之后观察（BACKLOG #15） |
| 9 | `voice_metric` 按 revision 累积（90 场景 / 151 行） | 派生数据，不影响正文；100k 项目随改稿增长 | M2 之后评估清理（BACKLOG #16） |
| 10 | 每千字作者净操作时间无埋点 | 无遥测（ADR-0006 D3）；只能秒表 | 随 §5.2 自测记录 |
| 11 | 分支不合并、章末摘要只抽取式、项目模板/自动补旁白不做 | 均为 M2 范围外（PRD / DEV-PLAN §12.5） | M2 之后（未列入 M2-1..M2-10） |

## 9 外部依赖与未执行项（单列，不写成通过）

- Windows 10 22H2 安装冒烟：**未执行**（作者决定不测，2026-11-17）。
- 真实第二家供应商 Key：**未补测**（作者决定不测；ADR-0003 保持「一家收口」）。
- 10 万字真实项目 / 真实模型账单：**未执行**（CI 与本地全部假模型；成本是预设计价折算，不是报价）。
- GitHub Releases 上传与自动更新 feed：**未执行**（首个 release tag 时做）。
- 作者 7 天自测：**未执行**；作者委托 Agent 代审（2026-11-24，§5.2）——机器可测面闭合，
  人工/外部项保留，不写成通过。
- 每千字净操作时间（秒表）与外部试用：**未执行**（§5.2 第 3/6 项）。

## 10 复跑命令

```bash
pnpm typecheck && pnpm lint && pnpm depcruise
pnpm test:unit                          # 878
pnpm vitest run tests/integration       # 61
pnpm test:chaos                         # 8 / CHAOS-01..09
pnpm test:e2e                           # 42（含 E2E-M2-SMOKE）
pnpm build && pnpm test:e2e:m2a         # 30 章 / 10 万字（nightly / 发布前）
pnpm build && pnpm test:e2e:m1a         # M1 30 章回归（nightly / 发布前）
pnpm test:perf                          # 4（PERF-01 / M1-01 / M2-01）
pnpm build && pnpm gen:check
node scripts/gen-icons.mjs --check
python docs/scripts/check_ui_spec.py
python docs/scripts/check_tool_spec.py --tools docs/tools --prd docs/PRD.md
pnpm dist                               # NSIS + latest.yml
node scripts/install-smoke.mjs          # 安装冒烟
node scripts/update-drill.mjs           # 更新演练（manifest + 判定 + 下载）
```

基线脚本（只读，对 `E2E-M2-A` 的 `--keep` 项目目录跑）：

```bash
NORYTH_E2E_KEEP=1 pnpm test:e2e:m2a     # 打印项目路径
node scripts/m2-cost-baseline.mjs <项目目录>
node scripts/m2-baseline.mjs <项目目录>
```
