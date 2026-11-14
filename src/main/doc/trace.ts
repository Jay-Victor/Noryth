import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Envelope } from '../../shared/schema/envelope'
import type { ContextBundle } from '../context/budget'

/**
 * 轨迹归档（DEV-PLAN §7.2）：trace 不写 beat 表，写
 * `logs/trace/<jobId>/<turnId>.json`，`beat.trace_ref` 只存相对路径。
 *
 * 文件里只有思考、工具调用、grounding 与装配摘要；**不复制 body**——
 * 正文以 DB 为唯一真相，轨迹可单独归档/清理。
 * 写入走临时文件 + rename，进程被杀不会留下半份 JSON。
 */

export interface TraceWriteInput {
  projectDir: string
  jobId: string
  turnId: string
  beatId: string
  envelope: Envelope
  /** 装配摘要：块 ID / token / 裁剪 / 降级；不写块正文。 */
  context?: Pick<ContextBundle, 'blocks' | 'totalTokens' | 'trimmed' | 'degraded'>
  binding?: { provider: string; model: string; version: number }
  recordedAt?: string
}

export interface TraceDocument {
  version: 1
  turn_id: string
  job_id: string
  beat_id: string
  speaker: Envelope['speaker']
  recorded_at: string
  trace: Envelope['trace']
  grounding: Envelope['grounding']
  meta: Envelope['meta']
  binding: { provider: string; model: string; version: number } | null
  context: {
    total_tokens: number
    blocks: Array<{ id: string; layer: string; tokens: number; role: string }>
    trimmed: string[]
    degraded: string[]
  } | null
}

function traceRelativePath(jobId: string, turnId: string): string {
  return `logs/trace/${jobId}/${turnId}.json`
}

/** 返回相对项目根的路径（forward slash），与 `beat.trace_ref` 的存储口径一致。 */
export function writeTurnTrace(input: TraceWriteInput): string {
  const document: TraceDocument = {
    version: 1,
    turn_id: input.turnId,
    job_id: input.jobId,
    beat_id: input.beatId,
    speaker: input.envelope.speaker,
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    trace: input.envelope.trace,
    grounding: input.envelope.grounding,
    meta: input.envelope.meta,
    binding: input.binding ?? null,
    context: input.context
      ? {
          total_tokens: input.context.totalTokens,
          blocks: input.context.blocks.map((block) => ({
            id: block.id,
            layer: block.layer,
            tokens: block.tokens,
            role: block.role
          })),
          trimmed: [...input.context.trimmed],
          degraded: [...input.context.degraded]
        }
      : null
  }

  const relative = traceRelativePath(input.jobId, input.turnId)
  const absolute = join(input.projectDir, relative)
  mkdirSync(join(input.projectDir, 'logs', 'trace', input.jobId), { recursive: true })
  const tmp = `${absolute}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, absolute)
  return relative
}

export function tracePathFor(jobId: string, turnId: string): string {
  return traceRelativePath(jobId, turnId)
}
