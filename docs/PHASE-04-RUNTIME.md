# 阶段 04 · 模型适配与 Agent 运行时

> 阶段 4 / 10 ｜ 依赖：03 ｜ 下游：05–10
> 对应：`docs/DEV-PLAN.md` §7、§8.1、§12.3（D1–D6）
>
> **一句话目标**：让一次「拍」能按 L0–L3 装配、流式生成、结构校验、grounding 校验，并产出可落盘的合法信封；这一阶段先用假模型验证，落盘在阶段 05 做。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 两家预设的流式与工具调用能被统一适配 | 同一接口跑两家；错误归一化 |
| 2 | 上下文预算可复现 | 同 fixture 两次 `ContextBundle` 完全一致 |
| 3 | 信封能被严格校验，越界引用 100% 拒绝 | 伪造 grounding / quote 改写 |
| 4 | 模型不支持 tool calling 时不裸答 | JSON 回退 + 2 次失败暂停 |
| 5 | job 内绑定不漂移 | 运行中改绑定，当前 job 不变 |

## 2 范围

### 2.1 做

- D1：SSE 适配器、工具调用增量、错误归一化、重试。
- D2：能力探测（stream/tools/jsonMode/contextWindow/pricing）。
- D3：L0–L3 上下文装配、token 预算、裁剪、快照。
- D4：信封 schema、speaker/字数校验、grounding 子集校验。
- D5：6 个 Agent 提示词、JSON 回退协议。
- D6：绑定快照、继承链、路由。

### 2.2 不做

- 六个页面的正式 UI → 阶段 06–09。
- 审批报告与记忆抽取的业务逻辑 → 阶段 08–09。
- 真实 API 的自动化测试；CI 一律用假模型。
- 自动模式；先证明单拍。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 适配器 | `src/main/model/adapter.ts`、`openai-compat.ts`、`sse.ts` | 两家流式 + 工具增量 |
| 能力探测 | `src/main/model/probe.ts` | 结果写 `settings.json` |
| 上下文 | `src/main/context/assemble.ts`、`budget.ts`、`tokens.ts` | 纯函数、确定性 |
| 信封 | `src/shared/schema/envelope.ts`、`src/main/agents/validate.ts` | 非法信封拒绝 |
| 提示词 | `src/main/agents/prompts/*` | 六角色各一份，稳定前缀 |
| 回退 | `src/main/model/json-fallback.ts` | 2 次失败 `tool_protocol_error` |
| 绑定 | `src/main/model/bindings.ts` | 继承链 + 快照 |
| 测试 | `tests/unit/context/*`、`tests/integration/turn.spec.ts` | 假模型跑通一拍 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| D1 | SSE 适配器、工具增量、错误归一化、重试 | A1 | 两家预设流式 + 工具调用通过 |
| D2 | 能力探测 + 设置页测试连接后端 | D1 | 探测结果落 settings |
| D3 | 上下文装配 L0–L3 + 预算 + 确定性 | B2 | 同输入两次 bundle 完全一致 |
| D4 | 信封校验 + grounding 子集校验 | C3 | 越界引用 100% 拒绝 |
| D5 | 6 个 Agent 提示词 + JSON 回退协议 | D1、D3 | 无工具模型走回退不死循环 |
| D6 | 绑定快照、继承链、路由 | D2 | job 内不换模型 |

## 5 实现要点

### 5.1 适配器

```ts
interface ChatAdapter {
  probe(cfg: ProviderConfig): Promise<Capabilities>;
  stream(req: ChatRequest, hooks: StreamHooks): Promise<ChatResult>;
}
```

- SSE 按行缓冲，`data: [DONE]` 结束；工具调用按 `index` 拼 `id/name/arguments`。
- 错误归一化：`auth/rate_limit/timeout/context_overflow/server/protocol/content_filter`。
- 429/5xx/超时重试 2 次（500ms/1500ms + jitter）；401/400 不重试；不静默换弱模型。

### 5.2 上下文预算

```
hardCap = min(contextWindow * 0.5, 12000)
budget  = hardCap - (ceil(maxWords * 1.4) + 400)
固定：L0 ≤ 900，L1 ≤ 600，角色卡核心 ≤ 700，意图 ≤ 160，L3 ≤ 150 × min(在场非发言者, 8)
动态：pinned ≤ 5 → 检索 refs（top_k）→ 最近 N 拍（默认 6）
裁剪：历史拍 → top_k → L3 → pinned → 记忆档位；角色卡核心与意图永不裁
```

- 排序键固定：`(layer, priority, id)`；检索按 `(score desc, id asc)`。
- token 估算 `ceil(cjk*1.05 + latin/3.6 + punct*0.6)`，按 provider 校准 `[0.7,1.6]`。

### 5.3 信封与 grounding

- `speaker.id === beat.speaker_id`；body 字数 ≤ `max_words × 1.3`。
- `grounding` 每项 `(type,id)` 必须在本轮 `turnRefs`；quote 归一化后必须是 ref.quote 的子串。
- 失败重试 1 次，提示只列允许的 ref；二次失败 → 本拍不落盘，`rejected + invalid_grounding`。
- 不静默删不合法的 grounding；不把校验失败伪装成合规。

### 5.4 JSON 回退

- 无 tool calling 但有 JSON mode：要求只输出 `{"tool_calls":[...],"final":{...}}`。
- 解析失败带错误重问一次；连续 2 次 → `tool_protocol_error`，暂停任务。
- 不支持 JSON mode 的模型不允许绑定到需要工具的角色。

### 5.5 绑定快照

- 解析顺序：`character:<id>` → `character` → `project.default_preset`；其他 Agent 直接项目默认。
- job 创建时冻结，写 `job.payload_json.bindings`；job 内所有拍复用。
- 改绑定只影响下一个 job；审计写 `model_binding_audit`。

## 6 验收清单

- [ ] 两家预设都能流式返回正文；至少一家能返回工具调用。
- [ ] 429/500/超时重试 2 次后暂停；401 不重试。
- [ ] 同一 fixture 两次上下文 `blocks` 顺序与总 token 完全一致。
- [ ] 超预算时按顺序裁剪，角色卡核心与意图未被裁。
- [ ] 伪造 grounding ID → `grounding_not_returned`；改写 quote → `grounding_quote_mismatch`。
- [ ] JSON 回退连续 2 次失败 → `tool_protocol_error`，不产生裸答正文。
- [ ] job 运行中改绑定，当前 job 仍用旧绑定。
- [ ] `runTurn` 用假模型能产出一拍合法信封；落盘留给阶段 05 的最小 `commitBeat` 验证。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 供应商工具增量差异 | 参数拼不完整 | 按 provider 写适配分支；M0 只承诺两家 |
| token 估算偏差大 | 频繁 `context_overflow` | 用实际 usage 校准；先压缩历史拍 |
| JSON 回退死循环 | 模型反复输出非 JSON | 2 次即停，转人工换模型 |
| 提示词注入 | 工具结果含指令 | 结果只作材料注入，不拼 system；加分隔符 |

## 8 进入下一阶段的条件

1. 假模型能跑通「装配 → 生成 → 校验」一拍，信封可交给阶段 05 落盘。
2. grounding 伪造与 quote 改写都被拒绝。
3. 上下文预算在同 fixture 上可复现。
4. 两家预设的流式与错误处理都有记录。
5. 绑定快照在 job 内不漂移。
