# 阶段 11 · 规模底座：多项目、30 章与文件树抽屉

> 阶段 11 / 18（M1 第 1 阶段）｜ 依赖：10 ｜ 下游：12–18
> 对应：`docs/DEV-PLAN.md` §11.8、§12.6（M1-9、M1-12、M1-16、M1-24）
> 状态：`done`（2026-11-15）；验收证据见 `PROGRESS.md`「验证记录（阶段 11，本地）」；CI run `43700004809` 全绿，标签 `phase-11-done` → `c2ef570`
>
> **一句话目标**：把「能写一章」扩到「能管理一部 30 章的书」：项目可切换、章节列表可滚、文件树可开，性能数字有基线。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 多项目切换不串状态 | A 写一拍 → 切 B → 回 A：revision、未确认拍、滚动位置不变 |
| 2 | 30 章列表滚动不掉帧 | Playwright 滚动 1,000 行；无 >50ms 长任务 |
| 3 | 打开/切章仍满足 §11.8 | 打开 30 章 <800ms；切章 P95 <120ms |
| 4 | 文件树抽屉不挤压正文 | 1440×900 开抽屉，正文列宽与关抽屉一致 |
| 5 | 自动打开上次项目不绕过锁 | 上次项目被占用/移动 → 回首页，不自动只读打开 |

## 2 范围

### 2.1 做

- M1-12：多项目切换 + 首页完善（最近项目、关闭项目、无项目空态）。
- M1-9：30 章性能 + 虚拟列表（章节列表、会话列表、文件树）。
- M1-16：文件树抽屉（Ctrl B）+ 焦点进出 + W2/W3 轨道。
- M1-24：启动自动打开上次项目（可在设置关闭）+ 诊断包 zip。
- `PERF-M1-01` 基线：30 章 / 720 拍 / 14 万字。

### 2.2 不做

- 多窗口、同一窗口并行打开两个项目（仍单窗口单项目）。
- 项目模板、导入旧稿（M2 / 产品明确不做）。
- 云同步、跨设备、多人协作。
- 30 章整书 E2E（阶段 18）；本阶段只做性能与切换。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 首页项目列表 | `src/renderer/pages/HomePage.tsx`、`src/main/project/registry.ts` | 最近 10 个；失效路径灰显可移除 |
| 项目切换 | `src/renderer/stores/app.ts`、`src/main/project/service.ts` | 关旧 DB、取消订阅、重置项目相关 store |
| 虚拟列表 | `src/renderer/components/VirtualList.tsx` | 固定行高 32；overscan 8；roving tabindex |
| 文件树抽屉 | `src/renderer/app/FileTreeDrawer.tsx` | 320px overlay；焦点陷阱；Esc 归位 |
| 启动设置 | `src/main/settings/store.ts` | `openLastProject` 开关；路径不进项目 DB |
| 诊断包 | `src/main/observability/diagnostics.ts` | `diagnostics-<date>.zip`；无正文/Key |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-12 | 多项目切换 + 首页完善 | A3、B6 | 切换不串事件；运行中切项目需确认 |
| M1-9 | 30 章性能 + 虚拟列表 | A4、M1-12 | 30 章滚动 60fps；切章 P95 <120ms |
| M1-16 | 文件树抽屉 + 焦点 | A4、A5 | 1440 开抽屉正文列宽不变；焦点可进出 |
| M1-24 | 上次项目 + 诊断 zip | A6、M1-12 | 失败路径不阻塞；zip 无正文/Key |

## 5 实现要点

### 5.1 多项目切换

- 单窗口单项目不变；切换 = `project.close` → `project.open`，不新开窗口。
- 切换前检查 `job.status ∈ {queued, running, paused}`：弹确认，先走各域的 cancel 通道（`write.cancel` / `review.cancel` / …）保留 draft，再关闭；不静默丢。
- 切换后重置 `app / plan / write / review / memory` 五个项目级 store（`settings` 是应用级，不重置），并重建 `bridge.on` 订阅；事件 payload 必须带 `projectId`，renderer 丢弃不匹配事件。
- 首页最近项目来自 `registry`（已有），打开失败保留条目并给 `project_not_found`；「从列表移除」不删盘。
- 不在 renderer 缓存正文；切回 A 时按 DB 投影重拉，避免「两份文本」。

### 5.2 30 章与虚拟列表

- 章节行只取摘要：`id / ord / title / status / wordCount / updatedAt`，不加载正文。
- 打开项目只加载当前章；切章按需加载；预览 tab 上限 6（UI-DESIGN §2.4）。
- 虚拟列表：固定行高 32、overscan 8、`content-visibility: auto`；焦点用 roving tabindex，J/K 由 store 管，不依赖 DOM 顺序。
- `PERF-M1-01`：30 章 / 720 拍 / 14 万字，打开 <800ms、切章 P95 <120ms、导出 <2s；滚动无 >50ms 长任务。
- 不在 renderer 做全文搜索；搜索走 main 的 `manuscript.search_final`（阶段 13 加 as-of 截断）。

### 5.3 文件树抽屉

- W1 ≥1600：树常驻 224；W2/W3：44px 轨道 + 320px overlay 抽屉（UI-DESIGN §2.6）。
- 抽屉是临时选择器：选中文件即关闭；不常驻、不改变正文列宽（overlay 不参与栅格）。
- `role=dialog` + 焦点陷阱；Esc 关闭并回到 Ctrl B 触发元素；`Ctrl B` 只在工作台 scope 生效。
- 编辑器 composition 期间不打开抽屉，避免中文 IME 被打断。
- 抽屉内容与树同源：项目结构 + 数据库视图（角色卡 / 世界规则 / 记忆 / 世界状态 / 关系图）。

### 5.4 启动自动打开与诊断包

- `settings.openLastProject` 默认 `true`；路径存应用设置，不进 `noryth.db`。
- 启动顺序：读设置 → 校验路径与锁 → `project.open`；超时 1.5s 放弃，失败回首页并 toast，不阻塞首屏。
- 迁移失败 / `integrity_check` 失败 / 只读锁 → 不自动打开，避免把错误放大。
- 诊断包：把现有 JSON（日志、schema 版本、job 摘要、verify 报告）打成 zip；明确排除正文、`secrets.bin`、Key、`exports/`。
- zip 用纯 JS 实现（不引原生模块）；文件名 `noryth-diagnostics-<date>.zip`，导出路径由作者选择。

## 6 验收清单

- [x] 打开 A → 生成/确认一拍 → 切 B → 回 A：A 的 revision、状态、未确认拍不变；无跨项目事件串台（`E2E-M1-SWITCH-01`）。
- [x] 运行中切项目：`project.busy` 先探测；无 `cancelRunning` 被 `project_busy` 拒绝；确认后取消并保留 draft（同一 E2E 第 2 例）。
- [x] 30 章列表滚动 60fps；打开 <800ms、切章 P95 <120ms（`PERF-M1-01`：切章 P95 2ms、列表摘要 P95 1ms；含迁移与 verify 的打开 325ms）。
- [x] 1440×900 开文件树抽屉正文列宽不变；Esc 焦点回到触发元素（`E2E-M1-TREE-01`；UI-DESIGN §11）。
- [x] 200% 缩放抽屉按钮不截断（同一 E2E 的 zoom=2 段）。
- [x] 上次项目被占用/移动 → 首页 + 可读提示，不自动只读打开（`tests/unit/project-service.test.ts` + 自动打开 E2E 第 3 例）。
- [x] 诊断包 zip 可解压；全文扫描无 Key/正文（`tests/unit/observability/zip.test.ts`、`tests/unit/diagnostics.test.ts`、`tests/e2e/diagnostics.spec.ts`）。
- [x] 新增 E2E：`E2E-M1-SWITCH-01`（切换）、`E2E-M1-TREE-01`（抽屉）。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 切换丢状态 | 事件串台、job 跨项目 | 事件带 `projectId`；切换前 cancel；store 重置测试 |
| 虚拟列表破坏键盘 | J/K 跳拍失效 | roving tabindex；焦点由 store 驱动 |
| 抽屉抢焦点 | 输入中断 | overlay + 焦点陷阱；composition 期间不打开 |
| 自动打开拖慢启动 | 首屏 >2.5s | 1.5s 超时；失败回首页 |
| zip 引入原生模块 | 打包失败 | 纯 JS zip；进打包冒烟 |

## 8 进入下一阶段的条件

1. 多项目切换与 30 章性能基线通过，事件无串台。
2. UI-DESIGN §11 文件树抽屉两条勾选。
3. 自动打开失败路径演练过（路径失效 / 锁占用 / 迁移失败）。
4. 诊断包 zip 通过安全扫描（无正文、无 Key）。
5. 没有新增第 7 个 Agent，没有第二写入口。
