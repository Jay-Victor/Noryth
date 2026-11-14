# 阶段 10 · 设置、测试与 M0 交付

> 阶段 10 / 10 ｜ 依赖：09 ｜ 下游：M1
> 对应：`docs/DEV-PLAN.md` §5.6、§9.1、§13、§14、§16、§12.3（I1–I4、J1–J6）
>
> **一句话目标**：两家预设可切换、逐 Agent 绑定生效、E2E 黄金路径全绿、NSIS 能装，PRD M0 的 11 条退出标准逐条有证据。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 两家预设都能独立完成一章 | `E2E-M0-PROVIDER` |
| 2 | 绑定只影响下一拍，不换运行中的模型 | job 内绑定快照 |
| 3 | Key 只进 safeStorage，不进项目/日志 | 扫描测试 |
| 4 | 崩溃重启已确认拍零丢失 | `CHAOS-01..08` |
| 5 | 干净 Windows 能安装、启动、更新不阻塞 | 安装冒烟 |

## 2 范围

### 2.1 做

- I1：供应商预设（OpenAI/DeepSeek/通义）、safeStorage、Key UI。
- I2：逐 Agent 绑定、继承链、审计、回滚上一套。
- I3：测试连接、能力/计价展示。
- I4：外观与基础偏好（M0 只亮色 + token 就绪）。
- J1：假 LLM 服务器 + fixture。
- J2：E2E M0-A 黄金路径。
- J3：混沌/崩溃恢复。
- J4：NSIS 打包 + 原生模块 + 自动更新。
- J5：性能基线 + 诊断导出。
- J6：安全清单 + 无障碍 + 200% 缩放。

### 2.2 不做

- DOCX、多项目切换、成本报表、关系图 → M1/M2。
- 代码签名证书采购 → M1 决策（D2）。
- 第三方工具/MCP、导入旧稿、协作/云同步。
- 真实 API 的 CI；只用假模型，真模型限 nightly 冒烟。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 设置窗口 | `src/renderer/pages/settings/*` | M0 四类（常规/Agent/提供方/外观）可导航，其余置灰 |
| 供应商 | `src/main/settings/providers.ts` | Key 只显末 4 位 |
| 绑定 | `src/main/settings/bindings.ts` | 继承链 + 版本审计 |
| 假模型 | `tests/fake-llm/server.ts` | 按 agent/beat 返回固定流 |
| E2E | `tests/e2e/m0-a.spec.ts` | 14 步全绿 |
| 打包 | `electron-builder.yml`、`release/*.exe` | 干净 Win10/11 可装 |
| 验收 | `docs/M0-ACCEPTANCE.md` | 11 条逐条证据 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| I1 | 供应商预设、safeStorage、Key UI | A1 | 项目目录无 Key 明文 |
| I2 | 绑定表 + 继承 + 审计 + 回滚 | I1、D6 | 改绑定只影响下一 job |
| I3 | 测试连接 + 能力/计价展示 | I1、D2 | 失败给错误码与建议 |
| I4 | 外观与基础偏好（亮色 + token） | A4 | 切换即时生效 |
| J1 | 假 LLM 服务器 + fixture | D1 | 可注入文本/工具/错误/延迟 |
| J2 | E2E M0-A 黄金路径 | F、G、H | 全链路无手工改库 |
| J3 | 混沌：强杀、outbox 中断、apply 中断 | F4、H3 | 已确认拍零丢失 |
| J4 | NSIS 打包 + 原生模块 + 自动更新 | A1 | 安装、启动、卸载通过 |
| J5 | 性能基线 + 诊断导出 | 全部 | 记录 P50/P95；诊断无正文 |
| J6 | 安全清单 + 无障碍 + 200% 缩放 | A4 | §4.4 全绿 |

## 5 实现要点

### 5.1 Key 与绑定

- `safeStorage.encryptString` → `%APPDATA%/noryth/secrets.bin`；项目目录与日志不出现 Key。
- 绑定解析：`character:<id>` → `character` → 项目默认；其他 Agent 直接项目默认。
- job 创建时快照；改绑定只影响下一个 job；`model_binding_audit` 可回滚。
- 测试连接返回延迟与首个可用模型；失败给错误码（auth/network/region）。

### 5.2 假 LLM 与 E2E

- fixture 按 `agent + beat` 匹配，可返回流式切片、工具调用、错误码、延迟。
- 同 fixture 同请求序列 → 同输出；CI 不烧钱、不抖动。
- `E2E-M0-A` 14 步：新建 → 规划 → G1 → 分镜 → 逐拍/自动 → 送审 → patch → 定稿 → G7 → 第 2 章检索 → 导出 → 重启。
- 断言 DB 快照 + 关键 UI 状态，不做全文快照。

### 5.3 混沌

- 生成中强杀、落盘事务中强杀、outbox 中断、apply 中断、数据库锁、磁盘满、更新中断。
- 启动扫描 `running` job → `interrupted`；`generating` 拍 → `interrupted`；outbox 重试。
- 已确认拍逐拍比对 hash，必须零丢失。

### 5.4 打包

- `asarUnpack`：`**/*.node`、`sqlite-vec*`、`resources/models/**`。
- 模型放 `extraResources`；`app.isPackaged` 时从 `process.resourcesPath` 解析。
- `electron-rebuild` + `npmRebuild`；CI 锁 Electron 版本。
- 自动更新失败不阻塞启动；提供手动安装包。

### 5.5 验收

- 按 PRD §10 M0 的 11 条逐条写证据：测试 ID、命令、输出、日期。
- 安装冒烟：Win10 22H2 + Win11 各一次（或 VM）。
- 安全：IPC 白名单、CSP、Key 扫描、日志脱敏。
- 性能：打开 30 章 < 800ms、检索 P95 < 80ms、导出 < 2s。
- 通过后打 tag `v0.1.0-m0.1`，产物存 GitHub Releases。

## 6 验收清单

- [ ] PRD M0 11 条全部有证据（§16.1 映射）。
- [ ] `E2E-M0-PROVIDER`：两家预设各完成一章；审批绑第二家仍能跑通。
- [ ] Key 只存 safeStorage；项目目录/日志/诊断包无明文。
- [ ] 绑定继承链正确；改绑定只影响下一 job。
- [ ] `CHAOS-01..08` 通过；已确认拍零丢失。
- [ ] NSIS 在干净 Win10/11 安装、启动、卸载；更新失败不阻塞。
- [ ] 安全清单全绿；200% 缩放不截断；抽屉焦点可进出。
- [ ] 性能基线记录完整；诊断包不含正文。
- [ ] `docs/M0-ACCEPTANCE.md` 写完并签字（自己签）。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 打包原生模块失败 | 安装后崩 | 锁版本 + electron-rebuild；先出 zip 版 |
| E2E 不稳定 | 随机失败 > 5% | 假模型 + 固定时钟 + 条件等待，不用 sleep |
| 真实 API 费用 | 频繁跑全章 | CI 全假模型；真模型限 nightly |
| 无签名被 SmartScreen 拦 | 用户不敢装 | M1 评估证书；内测给校验值 |
| 验收赶工 | 11 条只过一半 | 砍 M1 范围，不砍 M0 阻断项 |

## 8 进入 M1 的条件

1. M0 验收表 11 条全绿，无「已知问题」替代阻断项。
2. 安装包可在干净 Windows 上安装并完成一章。
3. 崩溃恢复、隔离、grounding、闸门四类硬门都有测试证据。
4. `docs/M0-ACCEPTANCE.md` 与 `docs/DEV-PLAN.md` 的变更记录更新。
5. 打 tag 并保留上一版安装包，供回滚。
