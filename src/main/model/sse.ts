/**
 * SSE 增量解析（DEV-PLAN §7.8）。
 *
 * 按行缓冲：网络分片可以切在任意位置；空行表示一个事件结束。
 * 多行 `data:` 用换行拼接；`:` 开头是注释；`[DONE]` 由调用方判断。
 * 纯函数式解析器，不读时钟、不读网络，便于按字符切片做确定性测试。
 */

export interface SseEvent {
  event: string | null
  id: string | null
  data: string
}

export class SseParser {
  private buffer = ''
  private dataLines: string[] = []
  private event: string | null = null
  private id: string | null = null

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const rawLine = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      const event = this.line(line)
      if (event) events.push(event)
      index = this.buffer.indexOf('\n')
    }
    return events
  }

  /** 收尾：处理没有以空行结束的最后一条事件。 */
  end(): SseEvent[] {
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ''
      this.line(line)
    }
    const event = this.dispatch()
    return event ? [event] : []
  }

  private line(line: string): SseEvent | null {
    if (line.length === 0) return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        this.dataLines.push(value)
        return null
      case 'event':
        this.event = value
        return null
      case 'id':
        this.id = value
        return null
      default:
        return null
    }
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0 && this.event === null && this.id === null) return null
    const event: SseEvent = {
      event: this.event,
      id: this.id,
      data: this.dataLines.join('\n')
    }
    this.dataLines = []
    this.event = null
    this.id = null
    return event
  }
}

/** 便捷入口：把完整 SSE 文本切成事件（测试与回放用）。 */
export function parseSse(text: string): SseEvent[] {
  const parser = new SseParser()
  return [...parser.push(text), ...parser.end()]
}
