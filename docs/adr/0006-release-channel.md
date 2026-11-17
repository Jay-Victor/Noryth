# ADR-0006 分发：不买 Authenticode，发 NSIS + SHA256；通道与回退边界

- 状态：已决定（阶段 18，M1）
- 日期：2026-11-17
- 对应：DEV-PLAN §14.3、§17 D2/D3/D5、PHASE-18 §5.1

## 背景

M1 要面向真实作者分发（NSIS 安装包 + 自动更新）。DEV-PLAN §17 留了三个待定：
D2 是否购买 Authenticode 证书、D3 是否收集匿名遥测、D5 自动更新是否允许跨 minor 降级。
阶段 18 需要在发布前把边界写死，避免临时改分发策略。

## 决定

1. **不购买 Authenticode 证书（D2）**：内测阶段安装成功率的证据只有本机与 CI 的
   `scripts/install-smoke.mjs`，没有「<80% 或 SmartScreen 拦截率高」的触发条件。继续以
   NSIS 安装包发布，并在 Releases 里附 `SHA256`（`latest.yml` 的 sha512 同时可用）；
   `release/**` 不入库，产物永久保留在 Releases。
2. **不收集匿名遥测（D3）**：只保留用户主动导出的诊断包（`diagnostics.export`，不含正文与 Key）。
3. **自动更新只允许同一 minor 回退（D5）**：`0.2.2 → 0.2.1` 允许，`0.3.0 → 0.2.9` 拒绝
   （`downgrade_blocked`），避免 schema 回退。实现见 `src/main/update.ts` 的 `decideUpdate`。
4. **通道**：`stable`（根目录 `latest.yml`）/ `beta`（`beta.yml`）/ `dev`（`dev.yml`）；
   默认 stable，`NORYTH_UPDATE_CHANNEL` 覆盖；`NORYTH_UPDATE_FEED` 指向 feed 根。
   stable 通道忽略预发布版本（`0.3.0-m2.1` 不会推给正式用户）。
5. **回滚**：重发上一版并把版本号调高（`0.2.2 → 0.2.3`），客户端按普通升级处理；
   不允许跨 minor 的版本号回退。

## 后果

- 首次安装可能出现 SmartScreen「未知发布者」提示；Releases 说明里给出 SHA256 与校验方法。
- 没有遥测，PRD §11 的「每拍确认耗时 / 每千字净操作时间」不在 M1 采集范围；
  成本/延迟只能从 `turn_metric` 与 `tool_call` 审计本地聚合（M2-5 报表）。
- 版本号是回滚的唯一杠杆：发布流程必须先升版本再发，不能复用旧 tag。

## 回滚方式

若决定购买证书：只改构建流水线（签名证书 + 时间戳服务），不改应用代码；
`electron-builder.yml` 的 `win.certificateFile` 从环境变量读取，密钥不入库。
若决定开启遥测：必须先改 PRD（D3 与 §11 口径），再写 ADR 增补，不在本阶段临时加。
