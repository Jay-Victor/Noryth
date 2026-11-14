# ADR-0003 供应商预设：OpenAI 兼容 + DeepSeek，S3 由作者手动验证

- 状态：**已决定**（2026-11-14：M0 以 DeepSeek 一家收口，第二家顺延到阶段 04 D1 前补测）
- 日期：2026-11-14
- 对应：PHASE-01 S3、DEV-PLAN §7.5–§7.6、§12.3.1

## 背景

M0 要求「至少两家预设可切换；一个 Agent 绑第二家仍能完成一章」，并且 S3 要求两家都能流式返回正文、拼装 `tool_calls` 与 `usage`。

## 现状

| 项 | 状态 |
|---|---|
| 供应商清单 | `openai` / `deepseek` / `tongyi`，默认 `deepseek`（PRD 允许的三家） |
| 协议形态 | OpenAI-compatible：`/chat/completions` + SSE `data:` 行 + `tool_calls` 增量 |
| 真实 Key | 由作者在本机手动测试；Key 不进入仓库、不进入应用、不由 Agent 读取 |
| 本地假服务器 | 阶段 04 的 J1 交付；本阶段尚未实现 |
| S3 结论 | **部分通过**：DeepSeek 已实测；第二家待测 |

在没有实测结论前宣称「两家流式可用」会是伪造证据；因此本 ADR 保持未关闭，S3 作为阶段 01 的开放门列出。

## 手动验证清单（作者执行，Key 只在本机）

在 Git Bash 中执行；`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` 只作为环境变量，不写进任何文件。

### 1. 非流式连通（两家各一次）

```bash
curl -sS https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"只回复 ok"}],"max_tokens":16}'

curl -sS https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"只回复 ok"}],"max_tokens":16}'
```

通过线：HTTP 200；响应含 `choices[0].message.content` 与 `usage.prompt_tokens/completion_tokens`。

### 2. 流式正文（两家各一次）

```bash
curl -sS -N https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"用一句话描述雨声"}],"stream":true,"stream_options":{"include_usage":true}}'

curl -sS -N https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"用一句话描述雨声"}],"stream":true,"stream_options":{"include_usage":true}}'
```

通过线：多行 `data: {...}`，每行 `choices[0].delta.content` 有增量；最后出现 `data: [DONE]`；若供应商返回 usage，记录它在哪一块（最后一个 delta 还是独立 chunk）。

### 3. 工具调用增量（两家各一次）

```bash
curl -sS -N https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"北京现在天气如何？必须调用工具"}],"stream":true,"tools":[{"type":"function","function":{"name":"get_weather","description":"查询天气","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}}],"tool_choice":"auto"}'
```

DashScope 把 URL 与 model 换成 `qwen-plus`、Key 换成 `DASHSCOPE_API_KEY` 再跑一次。

通过线：`choices[0].delta.tool_calls[]` 出现 `index`、`id`、`function.name` 与分片的 `function.arguments`；拼接后是合法 JSON（如 `{"city":"北京"}`）。

### 4. 错误归一化（至少 401）

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer invalid-key" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"x"}]}'
```

通过线：401/403；记录响应体是否可用于区分 `auth` 与 `rate_limit`。

### 结果回填

| 检查 | DeepSeek | DashScope | 备注 |
|---|---|---|---|
| 非流式 200 + usage | ✅ 2026-11-14 | 待填 | `deepseek-flash`，0.74s |
| 流式增量 + `[DONE]` | ✅ 98 个事件 | 待填 | 正文 34 字；另有 `reasoning_content` 104 字 |
| `tool_calls` 分片可拼接 | ✅ `{"city":"北京"}` | 待填 | 11 个事件，`finish_reason=tool_calls` |
| 401 可识别 | ✅ `authentication_error` | 待填 | 响应体含 `type`，可映射 `model_auth` |
| 其他差异（reasoning、finish_reason、限流） | ✅ 见下 | 待填 |  |

DeepSeek 实测细节（模型 ID：`deepseek-flash`；`/v1/models` 同时返回 `deepseek-v4-pro`）：

- 非流式：`usage` 含 `prompt_tokens/completion_tokens/total_tokens`，另有 `completion_tokens_details.reasoning_tokens` 与 `prompt_cache_hit_tokens`。
- 流式：正文在 `delta.content`；`delta.reasoning_content` 是独立字段（104 字），**不能拼进 body**，最多进 trace 的 `thought`。
- `usage` 出现在最后一个仍带 `choices` 的 chunk（`choices` 为空数组），适配器不能假设 usage chunk 没有 `choices` 键。
- 工具调用：`delta.tool_calls[]` 带 `index` / `id` / `function.name` / `function.arguments` 分片，拼接后 `{"city":"北京"}` 合法；`finish_reason=tool_calls`。
- 401：响应体 `error.type=authentication_error`，可映射 `model_auth`；错误信息只显示 Key 末四位。

回填后把本 ADR 状态改为「已决定」，并在 `PROGRESS.md` 的 S3 行写日期、模型名与结论。

## 决定（2026-11-14 作者确认）

- M0 阶段 01 的 S3 以 **DeepSeek 一家**收口：流式正文、`tool_calls`、`usage`、401 均已实测通过。
- 第二家（DashScope `qwen-plus` 或 Moonshot）不再阻塞阶段 01；**在阶段 04 的 D1 适配器完成前补测**，并把结果追加到本文件。
- 这是范围豁免，不是「两家都通过」：`PROGRESS.md` 与阶段文档都按「一家收口」记录，避免后续误判。
- 供应商预设仍保留 `openai` / `deepseek` / `tongyi` 三个枚举；设置页只对已实测的预设标「已验证」。

## 关闭条件

1. DeepSeek 已完成：流式正文 + 至少一次工具调用 + `usage` 记录 + 401 归一化（2026-11-14）。
2. 第二家预设（DashScope 或 Moonshot）在阶段 04 D1 完成前补测，覆盖同一组四项。
3. 两家结果都写入本文件后，状态从「已决定（一家收口）」改为「已决定（两家验证）」。
