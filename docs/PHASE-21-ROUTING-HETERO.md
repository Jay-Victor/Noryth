# 阶段 21 · 多供应商路由与异构复检

> 阶段 21 / 24（M2 第 3 阶段）｜ 依赖：20 ｜ 下游：22–24
> 对应：`docs/DEV-PLAN.md` §12.6（M2-4、M2-8）、§17（D4）、`docs/PRD.md` §9.3、§5.6
>
> **一句话目标**：供应商故障时能按作者显式配置切换，而不是静默降级；异构复检是否默认开启由实测数据决定。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 备用供应商是显式配置，切换可见、可审计 | 设置里配 fallback；`turn_metric.context_json.routing` 有 from/to/reason；状态栏有徽标 |
| 2 | `auth` / `content_filter` / `protocol` 不触发切换 | 假服务器分别注入，断言不切换、按原错误暂停 |
| 3 | 同一拍不中途换模型 | 故障拍仍失败/暂停；下一拍或下一 job 才用备用 |
| 4 | 连续故障会熔断，冷却后半开探测 | 3 次可重试失败后跳过该家；冷却后一次成功恢复 |
| 5 | 异构复检的默认值有数据依据 | 校准报告给出费用差与阻断代理指标；满足 D4 才改默认 |
| 6 | 校准不引入作者评分负担 | 只读 `approval_report` / `patch` / `gate_record`，不新增打分 UI |

## 2 范围

### 2.1 做

- M2-4：`routing` 设置（总开关、触发条件、冷却、逐 Agent 备用家）+ 路由器 + 内存熔断 + 状态栏/设置 UI。
- M2-4：审批异构与路由的优先级：先异构，再健康检查；不允许「异构切换」被 fallback 悄悄换回生成同家。
- M2-8：`review/calibration.ts` + 校准脚本 + `docs/M2-HETERO-CALIBRATION.md`；按 D4 规则决定 `review.hetero` 默认值。
- ADR-0008（路由与故障切换）与 ADR-0009（异构默认值决策）。
- 不新增数据库迁移；路由健康状态在内存，重启清空并允许一次探测。

### 2.2 不做

- 不做自动降级到弱模型；不做跨供应商负载均衡；不做按价格自动选家。
- 不在同一拍中途换模型；不因 fallback 改变 `expected_revision` 或已确认拍。
- 不购买/申请第二家 Key；没有真实 Key 时用本地假服务器与预设计价，结论标注为模拟。
- 不做分支合并、模型摘要、项目模板。
- 不做遥测；校准报告只在本地文档与设置页只读展示。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 路由设置 | `src/shared/schema/settings.ts`、`src/renderer/pages/settings/BindingTable.tsx`、`ProviderSettingsCard.tsx` | 总开关、触发条件、冷却、逐 Agent 备用家 |
| 路由器 | `src/main/model/router.ts` | 解析顺序、触发分类、健康检查、快照 |
| 熔断 | `src/main/model/health.ts` | 3 次失败开、冷却半开、成功复位 |
| 计量留痕 | `src/main/agents/turn.ts`、`src/main/model/usage.ts` | `context_json.routing` 与 provider 记录 |
| 状态栏 | `src/renderer/app/StatusBar.tsx` | 「备用」徽标与原因；不弹模态 |
| 校准 | `src/main/review/calibration.ts`、`scripts/m2-calibration.mjs` | 费用差、阻断接受率、维度分布 |
| 决策文档 | `docs/M2-HETERO-CALIBRATION.md`、`docs/adr/0008-routing.md`、`docs/adr/0009-hetero-default.md` | 数据、规则、结论、回退 |
| 测试 | `tests/unit/model/routing.test.ts`、`tests/integration/routing.spec.ts`、`tests/e2e/routing.spec.ts`、`tests/unit/review/calibration.test.ts` | `E2E-M2-ROUTING-01`、`E2E-M2-CALIBRATION-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M2-4 | 路由与故障切换 | D6、I2 | 显式 fallback；错误分类；熔断；不中途换模型 |
| M2-8 | 异构默认值与评分校准 | M1-22、M2-4 | 校准报告；D4 判定；默认变更或记录不变更 |
| 设置契约 | `routing` schema + UI | I2、M2-4 | 旧设置文件可读；默认关闭 |
| 审批优先级 | 异构 vs 路由 | M1-22、M2-4 | 不把审批换回生成同家；报告 provider 可解释 |
| 决策记录 | ADR-0008 / 0009 | M2-4、M2-8 | 结论、数据、回退、外部依赖写清 |

## 5 实现要点

### 5.1 路由策略

设置形状（工程细节，最终以 Zod 为准）：

```ts
type RoutingSettings = {
  enabled: boolean                    // 默认 false
  fallbackOn: Array<'rate_limit' | 'server' | 'timeout'>  // 默认 rate_limit + server
  cooldownMs: number                  // 默认 60000
  agents: Partial<Record<AgentKey, { preset: Preset; model?: string }>>
}
```

- 只有满足以下全部条件才允许作为备用：预设 enabled、已通过测试连接、有 Key（或 E2E 假模型）、模型能力满足该 Agent（需要工具的角色不能绑无工具模型）、与主绑定不是同一家。
- `routing` 是设置契约变更：先补 `docs/UI-DESIGN.md` §8.2/§11 与 `docs/PRD.md` §5.6 的变更记录，再加 schema；旧 `settings.json` 缺字段时默认关闭，不报错。
- 解析顺序：`character:<id>` → `character` → 项目默认；得到主绑定后，若 `routing.enabled` 且该 Agent 配了 fallback，再查主家健康状态。健康则用主家；不健康则用备用。
- 触发分类只认适配器归一化后的错误：`rate_limit`、`server`、`timeout` 可切换；`auth`、`content_filter`、`protocol`、`context_overflow`、`stale_revision` 不切换。`context_overflow` 先走裁剪重试，不换家。
- 切换发生在**回合开始前**，不在同一拍中途；同一 job 的下一拍可按健康状态切到备用，`turn_metric` 逐拍记录实际 provider/model；作者在设置里改绑定仍只影响下一 job。失败的那一拍不落盘，按下暂停处理；恢复后的下一拍或下一 job 才用备用。`job.payload_json.bindings` 保留 job 开始时的初始绑定快照，实际 provider/model 以 `turn_metric` 为准，回放时不把初始快照当成实际调用。
- 主家熔断打开时，下一拍直接用备用；备用也熔断 → 按原错误暂停，`degraded='routing_exhausted'`，不无限重试。
- 所有切换写 `turn_metric.context_json.routing = {from, to, reason, at}`（`context_json` 是 JSON，不破坏现有 `degraded_json` 数组语义）；日志 `routing_fallback`；状态栏徽标「DeepSeek → OpenAI（429）」。不改 `gate_record`，不新增闸门。

### 5.2 熔断

- 内存 `Map<projectId:preset, {failures, openedUntil, lastError}>`；只统计可重试错误；成功一次清零。
- 连续 3 次可重试失败（同家、5 分钟窗口）→ 打开 `cooldownMs`；冷却内直接跳过；冷却后允许一次探测（半开），成功关闭、失败重新打开。
- 重启清空：宁可多试一次，也不把一家永久拉黑；日志记录 `health_reset`。
- 测试注入时钟，不 sleep；`cooldownMs` 可配小值用于 E2E。
- 熔断不改变绑定审计：`model_binding_audit` 只记录作者改绑定，不记录故障切换；故障切换属于运行时度量。

### 5.3 审批异构与路由的优先级

```
reviewer 绑定
  → 若 review.hetero=prefer：按 M1 规则选第二家（生成家 ≠ 审批家）
  → 再检查被选中家的健康状态
      ├─ 健康：使用
      ├─ 不健康且 fallback 不是生成家：用 fallback
      └─ 不健康且 fallback 会等于生成家：不切换，标 hetero_unavailable
```

- 异构的目的是「审的人不是写的人」；不能为了可用性把审批换回生成同家，否则指标失真。
- 报告写 `provider`、`model`、`degraded`；`degraded` 可为 `hetero_unavailable` / `routing_exhausted`，两者优先级在报告中保留原因。
- 讨论与 patch 模式仍用配置的 reviewer 绑定；异构只针对「审」。
- 路由切换不改变 `approval_report` 的判定；只改变 provider 归因。

### 5.4 异构默认值与评分校准

数据源只读：`approval_report`（verdict、dimensions、provider、model）、`patch`（accepted/rejected/applied）、`gate_record`（G6）。`review/calibration.ts` 输出：

```ts
type CalibrationReport = {
  reports: number
  blocking: { total; accepted; rejected; acceptanceRate }
  suggestions: { total; accepted; rejected; acceptanceRate }
  byDimension: Array<{ dimension; meanScore; acceptedMean; rejectedMean; samples }>
  cost: { reviewCny; generationCny; heteroDeltaPct: number | null }
  limitations: string[]
}
```

- 代理指标：阻断被作者接受（patch 应用）视为「有用」；被拒绝视为「误报」；没有作者决策的报告不计入分母。不能把它冒充人工标注的召回率，报告必须写「代理指标」。
- 校准数据来自 30 章夹具的固定报告与 patch 决策；没有真实第二家 Key 时，`heteroDeltaPct` 用预设计价模拟，标注「模拟」。
- D4 判定：费用增加 <20%，且阻断代理指标（接受率不降、漏报代理下降）改善 → 允许把 `review.hetero` 默认改为 `prefer`；否则保持 `off`。没有足够真实数据 → 保持 `off`，记录外部依赖，不伪称默认开启。
- 若改默认：先写 PRD / DEV-PLAN D4 变更记录，再改 `ReviewSettingsSchema` 默认值与设置页文案；已有设置文件保留用户显式值，不强制迁移。
- 评分校准只出报告，不自动改提示词或分数；维度偏差超过阈值时，把结论交给 M2-9 的提示词优化，不在本阶段悄悄调 prompt。

### 5.5 测试矩阵

| 场景 | 注入 | 断言 |
|---|---|---|
| 主家 429 | 假服务器 429 + 备用成功 | 当前拍暂停；下一拍用备用；`routing` 留痕 |
| 主家 500 | 连续 3 次 500 | 熔断打开；跳过主家；备用成功 |
| 主家 401 | 401 | 不切换；`model_auth`；状态栏不显示备用 |
| 内容过滤 | `content_filter` | 不切换；转人工提示 |
| 两家都失败 | 主备均 500 | `routing_exhausted`；不无限重试；已确认拍不动 |
| 冷却恢复 | 注入时钟推进 | 半开一次成功；健康复位 |
| 异构 + 主家故障 | prefer + 第二家 | 审批仍不同家；fallback 不把审批换回生成家 |
| 无第二家 | prefer + 仅一家 | `hetero_unavailable`；报告照常；不阻断 G6 |

## 6 验收清单

- [ ] `routing` 设置可保存、可回滚到关闭；旧设置文件缺字段时默认关闭，不报错（`tests/unit/settings/*`）。
- [ ] `E2E-M2-ROUTING-01`：主家 429 → 当前拍暂停 → 下一拍备用 → 状态栏徽标 → 报告/度量 provider 正确 → 已确认拍逐字不变。
- [ ] `auth` / `content_filter` / `protocol` 不切换；两家都失败 → `routing_exhausted` 且不无限重试（`tests/integration/routing.spec.ts`）。
- [ ] 熔断：3 次失败打开、冷却半开、成功复位；时钟注入，无 sleep（`tests/unit/model/routing.test.ts`）。
- [ ] 同一拍内不换模型；同一 job 的下一拍可因熔断切到备用并逐拍留痕；作者改绑定只影响下一 job（`tests/integration/routing.spec.ts`）。
- [ ] 异构优先级：prefer 时 fallback 不把审批换回生成同家；`hetero_unavailable` 与 `routing_exhausted` 原因可读（`tests/unit/review/hetero.test.ts` 扩展）。
- [ ] `E2E-M2-CALIBRATION-01`：校准脚本输出 reports/blocking/suggestions/byDimension/cost；`docs/M2-HETERO-CALIBRATION.md` 记录数据与局限。
- [ ] D4 决策：满足规则才改 `review.hetero` 默认；不满足保持 `off`；ADR-0009 记录结论与外部依赖。
- [ ] 不新增迁移；`LATEST_SCHEMA_VERSION` 仍为 13（若后续阶段有迁移，与本阶段无关）。
- [ ] 门禁：typecheck / lint / depcruise / unit / integration / e2e / build / gen:check。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 故障切换掩盖故障 | 主家长期 429，作者以为正常 | 状态栏常驻徽标 + 日志 + 报表 provider 列；不静默 |
| auth 也切换 | Key 错却换家，账单异常 | 错误分类硬编码；401/403 不切换；测试守 |
| 异构被 fallback 破坏 | 审批换回生成同家 | 优先级规则；宁可 `hetero_unavailable` 也不假异构 |
| 无真实第二家 | 校准只有模拟数据 | 保持 `off`；ADR 标外部依赖；不伪造默认开启 |
| 设置过复杂 | 作者不会配 | 默认关闭；提供「主家故障时用备用」一键模板；逐 Agent 可留空 |
| 冷却太长 | 写作中断 | 默认 60s；可配；状态栏给「立即重试」按钮（只重试，不改绑定） |

## 8 进入下一阶段的条件

1. 备用供应商显式配置，切换可见、可审计；没有静默降级。
2. 错误分类、熔断、半开与两家都失败的路径有测试。
3. 异构优先级正确；不把审批换回生成同家。
4. 校准报告与 D4 决策记录完成；默认值变更或保持 `off` 都有依据。
5. 不新增未记录的契约变更；旧设置文件可读。
