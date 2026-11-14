# 阶段 03 · 工具层与授权边界

> 阶段 3 / 10 ｜ 依赖：01、02 ｜ 下游：04–10
> 对应：`docs/DEV-PLAN.md` §6、§4.10、§4.11、§12.3（C1–C7）
>
> **一句话目标**：把 42 个工具做成唯一能力出口：未授权不下发、身份不由模型传、写操作必须凭令牌、每次调用可审计。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 42 个 manifest 能从代码生成，且与 PRD 表格一致 | `check_tool_spec.py` + `gen:check` |
| 2 | 未授权工具不出现在模型 `tools` 列表 | 六个 Agent 的快照比对 |
| 3 | 角色实例拿不到 `character_id` 参数 | schema 收窄测试 |
| 4 | 提案/执行工具重放不双写 | 同幂等键两次调用 |
| 5 | 闸门令牌只能用一次，失败不消费 | 过期/错实体/复用三类测试 |

## 2 范围

### 2.1 做

- C1：`defineTool`、registry、codegen、构建期五断言。
- C2：授权解析（基线 ∩ 实例收窄 ∩ 项目策略）+ 快照。
- C3：调用流水线、预算、超时、截断、降级。
- C4：闸门令牌、幂等、`tool_call` 审计。
- C5：42 个 manifest 契约（36 个实现 + 6 个里程碑开关）。
- C6：36 个工具实现（读/校验/提案/执行）。
- C7：契约 harness + fixture。

### 2.2 不做

- Agent 提示词与信封校验 → 阶段 04。
- 工具的 UI 展示；只做只读的调用日志面板（可选）。
- T22/T23/T25/T26/T29/T40 的实现：只保留 manifest，`enabled=false`，不进白名单。
- 第三方工具/MCP/插件：M0–M2 不开放。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 工具定义 | `src/main/tools/define.ts` | A1–A5 五条断言在构建期生效 |
| 注册表 | `src/main/tools/registry.ts` | 名称唯一、版本 semver、失败剔除 |
| 授权 | `src/main/tools/resolve.ts` | 六角色数量与 PRD 一致 |
| 调用 | `src/main/tools/invoke.ts` | 九步顺序不可换 |
| 闸门/幂等 | `src/main/tools/gates.ts`、`idempotency.ts` | 单次消费；重放 `duplicate:true` |
| 审计 | `src/main/tools/audit.ts` | 只存 `args_hash`，不存原文 |
| 清单 | `docs/tools/*.json`、`src/main/tools/generated/*` | 与源码 0 diff |
| 测试 | `tests/contract/**` | 36 × 6 + 注册表 12 条 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| C1 | `defineTool`、registry、codegen、构建期五断言 | A1 | 42 个 manifest 生成 JSON；A1–A5 全绿 |
| C2 | 授权解析 + 角色实例收窄 + 快照 | C1 | 角色 schema 无 `character_id` |
| C3 | 调用流水线、预算、超时、截断 | C2 | 六类契约测试通过 |
| C4 | 闸门令牌、幂等、审计 | C3 | 令牌单次消费；重放不双写 |
| C5 | 42 个 manifest 契约（含 6 个未实现） | C1 | 与 PRD §4.10 名称/actors 一致 |
| C6 | 36 个工具实现 | C3、B2 | 逐工具契约测试 |
| C7 | 契约 harness + fixtures | C5 | 缺测试的 manifest 即 CI 失败 |

## 5 实现要点

### 5.1 manifest 与生成

- TS 内部用 camelCase，生成的 JSON 用 PRD 字段名：`side_effect`、`agent_callable`、`requires_gate`、`input_schema`、`max_calls_per_turn` 等。
- 构建期断言：`commit → !agent_callable`；`injected ∩ input = ∅`；`input/output` strict；名称唯一；`requires_gate` 不用于只读工具。
- `toolset_version` = 全部 `name@version` 排序后 sha256，写进 job 与 `turn_metric`。

### 5.2 授权解析

```
有效工具集 = 角色基线白名单 ∩ 实例收窄 ∩ 项目策略
```

- 基线唯一来源是 manifest 的 `actors`，生成 `allowlist.ts`；CI 与 PRD §4.11 的 10/18/9/5/20/16 比对。
- 角色实例：`character:<id>` 的 `memory.retrieve_own` 无参数；`relationship.get_edges` 裁掉 `character_id`。
- 未授权工具硬调 → `tool_not_found` + `unauthorized_tool_attempt` 审计；不返回「无权限」。

### 5.3 调用流水线（顺序固定）

1. 从 job 快照取工具；未授权即不存在。
2. 参数 strict 校验。
3. 运行时注入 `project_id/actor_id/character_id/as_of/job_id/turn_id/epoch/expected_revision/gate_token?`。
4. 幂等重放（propose/execute）。
5. 单轮预算与单工具上限。
6. 闸门令牌校验。
7. 执行 + 超时 + 降级。
8. 截断（整条丢弃，不切 quote）。
9. 审计 + 登记 `turnRefs`。

### 5.4 闸门令牌

```
payload = { g, et, eid, rev, job, exp, nonce }
token = base64url(JSON) + "." + HMAC-SHA256(secret, base64url(JSON))
```

- TTL 10 分钟；绑定 `gate_id + entity_type + entity_id + revision + job_id`。
- `gate_record.token_hash = sha256(token)`；成功提交后才 `consumed_at`；失败重试复用。
- 实体不匹配统一返回 `stale_revision`，不区分「令牌错」与「稿件变了」。

### 5.5 幂等与截断

- `key = sha256(canonicalJson({project_id, job_id, tool, version, args_hash}))`。
- 重放返回首次结果 + `duplicate:true`；`tool_call.result_json` 只在有幂等键时写。
- 截断按整条丢弃，返回 `truncated:true, total`；不允许静默切半句。

### 5.6 六个未实现工具

| 工具 | 里程碑 | 处理 |
|---|---|---|
| T22 `foreshadow.list_open` | P1 | manifest 存在，`enabled=false` |
| T23 `timeline.query` | M1 | 同上 |
| T25 `voice.metrics` | M2 | 同上 |
| T26 `coverage.check` | P1 | 同上 |
| T29 `impact.analyze` | P1 | 同上 |
| T40 `memory.rebuild` | M1 | 同上 |

它们不在任何 M0 白名单里；调用返回 `tool_not_found`，不返回「未实现」。

## 6 验收清单

- [ ] 42 个 manifest 生成成功，名称/actors 与 PRD §4.10 一致。
- [ ] M0 白名单：规划 8、编排 16、角色 9、旁白 5、审批 17、记忆 13。
- [ ] 旁白 `tools` 列表恰好 5 个；审批恰好 17 个。
- [ ] 角色实例 schema 中不存在 `character_id`；硬塞 → `invalid_args`。
- [ ] 未授权工具硬调 → `tool_not_found` + 审计记录。
- [ ] `memory.apply` 无令牌 → `gate_required`；错实体 → `stale_revision`；复用 → `gate_consumed`。
- [ ] 同幂等键两次 → 一条记录 + `duplicate:true`。
- [ ] `tool_call.args` 不落原文，只有 `args_hash`。
- [ ] 超时返回部分结果并标 `degraded`；空结果 `ok:true, degraded:'empty'`。
- [ ] 36 个实现的六类契约测试全绿。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| manifest 与 PRD 漂移 | `check_tool_spec.py` 失败 | 以 PRD 表格为准改 manifest，不改脚本 |
| 收窄写错 | 角色能查别人 | 停用该工具，修 resolve 后重跑隔离测试 |
| 幂等键不稳定 | 同参数生成不同 key | 固定 canonicalJson 测试；数字/undefined 规则写死 |
| 闸门令牌泄漏 | 日志出现明文 | 只存 hash；日志脱敏测试 |
| 工具实现范围偏大 | 工具实现拖住后续阶段 | 先做闭环必需的工具，其余保留契约 + 空实现，M0 验收前补齐 |

## 8 进入下一阶段的条件

1. 42 个 manifest、36 个实现、6 个开关全部落位。
2. 六角色白名单数量与 PRD 完全一致。
3. 越权、空结果、截断、超时、幂等、闸门六类测试全绿。
4. `docs/tools/*.json` 与源码 0 diff；CI 硬门通过。
5. 没有任何工具直接 import `better-sqlite3`/`node:fs`/`fetch`。
