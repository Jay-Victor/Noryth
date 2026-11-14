import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import {
  FALLBACK_INSTRUCTION,
  parseFallbackResponse,
  runJsonProtocol
} from '../../../src/main/model/json-fallback'

describe('JSON 回退协议（DEV-PLAN §7.6）', () => {
  it('协议文本要求只输出一个 JSON 对象', () => {
    expect(FALLBACK_INSTRUCTION).toContain('tool_calls')
    expect(FALLBACK_INSTRUCTION).toContain('final')
    expect(FALLBACK_INSTRUCTION).toContain('不得输出 JSON 以外的任何字符')
  })

  it('解析工具轮与最终答复', () => {
    const tools = parseFallbackResponse('{"tool_calls":[{"tool":"memory.retrieve_own","args":{"query":"匣子"}}],"final":null}')
    expect(tools.tool_calls).toHaveLength(1)
    expect(tools.final).toBeNull()

    const minimal = parseFallbackResponse('{"tool_calls":[],"final":{"body":"雨停了。","grounding":[]}}')
    expect(minimal.final).not.toBeNull()
    if (minimal.final && 'body' in minimal.final) expect(minimal.final.body).toBe('雨停了。')

    const envelope = parseFallbackResponse(
      JSON.stringify({
        tool_calls: [],
        final: {
          turn_id: 'turn_1',
          speaker: { type: 'narrator', id: 'narrator' },
          trace: [],
          body: '雨停了。',
          grounding: [],
          meta: { model: 'm', degraded: false, tokens_in: 1, tokens_out: 2 }
        }
      })
    )
    expect(envelope.final && 'turn_id' in envelope.final).toBe(true)
  })

  it('非 JSON、空对象、坏形状都归为 tool_protocol_error', () => {
    for (const text of ['我不是 JSON', '{}', '{"tool_calls":[],"final":null}', '{"final":{"body":""}}']) {
      expect(() => parseFallbackResponse(text)).toThrowError(AppError)
      try {
        parseFallbackResponse(text)
      } catch (error) {
        expect((error as AppError).code).toBe('tool_protocol_error')
      }
    }
  })

  it('解析失败带错误重问一次，第二次成功', async () => {
    const seen: Array<string | null> = []
    const result = await runJsonProtocol({
      ask: async (feedback) => {
        seen.push(feedback)
        return seen.length === 1 ? '我先想想' : '{"tool_calls":[],"final":{"body":"好。","grounding":[]}}'
      },
      parse: parseFallbackResponse
    })
    expect(result.attempts).toBe(2)
    expect(seen[0]).toBeNull()
    expect(seen[1]).toContain('上一次输出无法解析')
    expect(result.value.final).not.toBeNull()
  })

  it('连续 2 次失败 → tool_protocol_error，不产生裸答', async () => {
    let calls = 0
    await expect(
      runJsonProtocol({
        ask: async () => {
          calls += 1
          return '我还是不输出 JSON'
        },
        parse: parseFallbackResponse
      })
    ).rejects.toMatchObject({ code: 'tool_protocol_error' })
    expect(calls).toBe(2)
  })
})
