# ADR-0003 供应商预设：OpenAI 兼容 + DeepSeek，S3 仍待验证

- 状态：**未关闭**（等待真实 API Key）
- 日期：2026-11-14
- 对应：PHASE-01 S3、DEV-PLAN §7.5–§7.6、§12.3.1

## 背景

M0 要求「至少两家预设可切换；一个 Agent 绑第二家仍能完成一章」，并且 S3 要求两家都能流式返回正文、拼装 `tool_calls` 与 `usage`。

## 现状

| 项 | 状态 |
|---|---|
| 供应商清单 | `openai` / `deepseek` / `tongyi`，默认 `deepseek`（PRD 允许的三家） |
| 协议形态 | OpenAI-compatible：`/chat/completions` + SSE `data:` 行 + `tool_calls` 增量 |
| 真实 Key | **未提供**，无法发起真实请求 |
| 本地假服务器 | 阶段 04 的 J1 交付；本阶段尚未实现 |
| S3 结论 | **未通过（未执行）** |

在没有 Key 的前提下宣称「两家流式可用」会是伪造证据；因此本 ADR 保持未关闭，S3 作为阶段 01 的开放门列出。

## 临时决定

- 项目默认预设写 `deepseek`；`model_binding` 表与设置页在阶段 10 落地。
- 适配器在阶段 04 实现，先对本地 SSE 假服务器验证：正文增量、`tool_calls` 按 `index` 拼装、`usage`、错误归一化（401/429/5xx/protocol）。
- 真实供应商验证需要用户提供至少两家的 Key（或明确授权使用其已有 Key），并在 `docs/PROGRESS.md` 记录运行日期与模型名。

## 关闭条件

1. 两家预设各完成一次流式正文 + 至少一次工具调用；
2. `usage.prompt_tokens/total_tokens` 被记录到 `turn_metric`；
3. 错误码归一化测试覆盖 `auth` / `rate_limit` / `timeout` / `protocol`；
4. 结论补进本文件并把状态改为「已决定」。
