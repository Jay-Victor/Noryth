import { z } from 'zod'

/**
 * 导出契约（PRD §5.5 / PHASE-10 J2 / PHASE-17 M1-6、M1-14）。
 *
 * 只读操作：不产生 revision、不改正文；只读锁下仍可导出。
 * 三档格式共用同一份 revision 清单；DOCX 额外带排版选项（字号 / 行距 / 字体 / 目录）。
 */

export const EXPORT_FORMATS = ['md', 'txt', 'docx'] as const
export const ExportFormatSchema = z.enum(EXPORT_FORMATS)
export type ExportFormat = z.infer<typeof ExportFormatSchema>

/** 中文字体只给两档：系统自带的宋体、随包可用的思源宋体；不做字体市场（PHASE-17 §2.2）。 */
export const EXPORT_FONTS = ['宋体', '思源宋体'] as const
export const ExportFontSchema = z.enum(EXPORT_FONTS)
export type ExportFont = z.infer<typeof ExportFontSchema>

/** 字号（pt）与行距三档（PHASE-17 §5.2）；只影响导出文件，不写 `settings.json`。 */
export const ExportFontSizeSchema = z.union([z.literal(10.5), z.literal(12), z.literal(14)])
export type ExportFontSize = z.infer<typeof ExportFontSizeSchema>

export const ExportLineSpacingSchema = z.union([z.literal(1.15), z.literal(1.5), z.literal(2)])
export type ExportLineSpacing = z.infer<typeof ExportLineSpacingSchema>

/**
 * `scope` 缺省时按 `chapterId` 推断：给了 = 本章，没给 = 全书。
 * 显式写 `scope: 'chapter'` 却没给 `chapterId` 一律 `invalid_args`，不猜「第一章」。
 */
export const ExportInputSchema = z.strictObject({
  chapterId: z.string().min(1).optional(),
  format: ExportFormatSchema.default('docx'),
  scope: z.enum(['chapter', 'book']).optional(),
  /** false = 仅正文；true = 正文 + 修订建议（最近一份审批报告）。 */
  includeNotes: z.boolean().default(false),
  /** 仅 DOCX：章节目录（Word 打开时会更新页码）。 */
  toc: z.boolean().default(true),
  /** 仅 DOCX：中文字体。 */
  font: ExportFontSchema.default('宋体'),
  /** 仅 DOCX：正文号。 */
  fontSize: ExportFontSizeSchema.default(12),
  /** 仅 DOCX：行距倍率。 */
  lineSpacing: ExportLineSpacingSchema.default(1.5),
  /** 标题页作者名；只进导出文件，不落库、不写设置（PHASE-17 §5.1）。 */
  author: z.string().max(60).optional()
})
export type ExportInput = z.infer<typeof ExportInputSchema>
/** 调用方（renderer / preload）的入参：带默认值的字段可省略，由 IPC 侧的 schema 补默认。 */
export type ExportRequest = z.input<typeof ExportInputSchema>

export const ExportResultSchema = z.strictObject({
  format: ExportFormatSchema,
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  chapters: z.number().int().positive(),
  beats: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  /** 导出时实际读取的 revision（定稿章是 final，未定稿章是当前 draft）。 */
  revisionIds: z.array(z.string()),
  /** 未定稿章数（文件里标「草稿」）。 */
  drafts: z.number().int().nonnegative()
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

