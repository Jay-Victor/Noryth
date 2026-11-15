# 假 LLM fixture（阶段 10 J1）

`startFixtureLlm()` 按「最先命中」匹配请求，同一 fixture 默认可重复使用。
请求文本里可以带三种标记（只在测试里由提示词或测试代码注入）：

| 标记 | 匹配字段 | 用途 |
|---|---|---|
| `[AGENT:planner]` 或 `agent:planner` | `match.agent` | 同一个服务器服务多个 Agent |
| `[BEAT:plan.blueprint]` | `match.beat` | 按拍/按任务脚本化 |
| 任意子串 | `match.contains` | 用提示词里的固定锚点（如「本拍意图」） |

`match.model` 与请求的 `model` 精确比较；多个条件同时给出时是「与」关系。

## 字段

```json
{
  "match": { "agent": "planner", "beat": "plan.blueprint", "model": "deepseek-flash", "contains": "蓝图" },
  "response": {
    "stream": ["第一段", "第二段"],
    "tool_calls": [{ "tool": "blueprint.propose_patch", "args": { "ops": [] } }],
    "usage": { "in": 1800, "out": 420 },
    "finish_reason": "stop",
    "delay_ms": 5,
    "error": { "status": 500, "body": "{\"error\":\"boom\"}" }
  },
  "repeat": false
}
```

- `stream` 是切片文本，服务器仍按 SSE 逐片发送；`tool_calls` 会按两段增量拼装。
- `usage` 用于预算测试；`delay_ms` 用于观察流式；`error` 注入 HTTP 错误（不进入协议）。
- `repeat: false` 表示只命中一次，用于「第一次失败、第二次成功」的场景。
- 未命中的请求记在 `unmatched`，命中名记在 `matched`；E2E 可以断言没有漏配。
