import { describe, expect, it } from 'vitest'
import { SseParser, parseSse } from '../../../src/main/model/sse'

describe('SSE 行缓冲解析（DEV-PLAN §7.8）', () => {
  it('按空行切事件，拼接多行 data，忽略注释', () => {
    const events = parseSse(
      [
        ': keep-alive',
        'event: message',
        'id: 1',
        'data: {"a":1}',
        '',
        'data: 第一行',
        'data: 第二行',
        '',
        ''
      ].join('\n')
    )
    expect(events).toEqual([
      { event: 'message', id: '1', data: '{"a":1}' },
      { event: null, id: null, data: '第一行\n第二行' }
    ])
  })

  it('网络分片切在任意位置也能还原（逐字符喂）', () => {
    const text = 'data: {"content":"雨"}\n\ndata: [DONE]\n\n'
    const parser = new SseParser()
    const events = []
    for (const char of text) events.push(...parser.push(char))
    events.push(...parser.end())
    expect(events.map((event) => event.data)).toEqual(['{"content":"雨"}', '[DONE]'])
  })

  it('CRLF 与没有结尾空行的最后一条事件都能处理', () => {
    expect(parseSse('data: {"a":1}\r\n\r\ndata: tail')).toEqual([
      { event: null, id: null, data: '{"a":1}' },
      { event: null, id: null, data: 'tail' }
    ])
  })

  it('空 data 与只有注释的行不产生事件', () => {
    expect(parseSse(': ping\n\n')).toEqual([])
    expect(parseSse('data:\n\n')).toEqual([{ event: null, id: null, data: '' }])
  })
})
