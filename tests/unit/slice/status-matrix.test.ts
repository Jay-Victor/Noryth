import { describe, expect, it } from 'vitest'
import {
  SLICE_BEAT_STATUSES,
  SLICE_BUSY_STATUSES,
  SLICE_STATUS_LABELS,
  SliceBeatStatusSchema
} from '../../../src/shared/schema/slice'
import { ERROR_CODES } from '../../../src/shared/domain/errors'

/**
 * 状态矩阵 fixture（AGENTS「完成标准 3」/ PHASE-05 §5.3）：
 * 每个 beat 状态都必须有 UI 文案与 busy 归属；新增状态不能只改 DB CHECK。
 */
describe('切片状态矩阵', () => {
  it('11 个 beat 状态全部有文案，且 schema 与矩阵同源', () => {
    expect(SLICE_BEAT_STATUSES).toHaveLength(11)
    for (const status of SLICE_BEAT_STATUSES) {
      expect(SLICE_STATUS_LABELS[status], status).toBeTruthy()
      expect(SliceBeatStatusSchema.safeParse(status).success, status).toBe(true)
    }
    expect(Object.keys(SLICE_STATUS_LABELS).sort()).toEqual([...SLICE_BEAT_STATUSES].sort())
  })

  it('busy 状态只能是生成中的两个，且都在状态表里', () => {
    expect([...SLICE_BUSY_STATUSES].sort()).toEqual(['generating', 'regenerating'])
    for (const status of SLICE_BUSY_STATUSES) {
      expect(SLICE_BEAT_STATUSES).toContain(status)
    }
    expect(SLICE_STATUS_LABELS.generating).toContain('生成')
    expect(SLICE_STATUS_LABELS.waiting_for_human).toBe('待确认')
  })

  it('切片 IPC 的错误码都在统一错误表里', () => {
    for (const code of ['invalid_args', 'stale_revision', 'schema_invalid', 'project_locked']) {
      expect(ERROR_CODES).toContain(code)
    }
  })
})
