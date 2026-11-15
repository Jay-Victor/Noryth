import { z } from 'zod'

/**
 * 导出契约（PRD §5.5 / PHASE-10 J2 第 13 步）。
 * 只读操作：不产生 revision、不改正文；只读锁下仍可导出。
 */

export const ExportInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  format: z.enum(['md', 'txt']).default('md'),
  includeNotes: z.boolean().default(false)
})
export type ExportInput = z.infer<typeof ExportInputSchema>

export const ExportResultSchema = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  chapters: z.number().int().positive(),
  beats: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  revisionIds: z.array(z.string())
})
export type ExportResult = z.infer<typeof ExportResultSchema>

/**
 * 诊断包导出（PHASE-11 M1-24）。
 * `path` 只在调用方已经选定路径时给出（E2E / 复跑脚本）；正常路径走保存对话框。
 */
export const DiagnosticsExportInputSchema = z.strictObject({
  path: z.string().min(1).max(400).optional()
})
export type DiagnosticsExportInput = z.infer<typeof DiagnosticsExportInputSchema>

export const DiagnosticsExportResultSchema = z.strictObject({
  /** 作者取消保存对话框时为 null。 */
  path: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  entries: z.array(z.string()),
  cancelled: z.boolean()
})
export type DiagnosticsExportResult = z.infer<typeof DiagnosticsExportResultSchema>

