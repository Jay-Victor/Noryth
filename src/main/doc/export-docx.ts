import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LeaderType,
  PageBreak,
  PageNumber,
  Paragraph,
  Packer,
  TableOfContents,
  TextRun,
  type FileChild,
  type ISectionOptions
} from 'docx'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ExportFont, ExportFontSize, ExportLineSpacing } from '../../shared/schema/export'

/**
 * DOCX 生成（PHASE-17 M1-6 / M1-14）。
 *
 * 结构：标题页（书名 / 作者 / 日期）→ 目录（可选）→ 每章标题 + 场景分隔 + 拍正文段落。
 * 只读：调用方给的是 revision 清单，这里不碰数据库、不写 outbox、不产生 revision。
 *
 * 可复现（PHASE-17 §5.3）：`docx` 打包时用当前时间做 zip 条目时间与 core 属性时间，
 * 同一份清单两次导出字节不同。这里统一归一化：zip 条目固定 2000-01-01，
 * core 的 created/modified 固定为导出日零点，于是同一天同一份清单两次导出 sha256 相同。
 */

/** zip 条目固定时间（PHASE-17 §5.3）。DOS 时间下限是 1980；2000-01-01 足够早且合法。 */
export const DOCX_ZIP_EPOCH = new Date(Date.UTC(2000, 0, 1, 0, 0, 0))

export interface DocxChapterInput {
  title: string
  ord: number
  /** 未定稿章的草稿快照：文件里标「草稿」，不冒充定稿。 */
  draft: boolean
  revisionId: string | null
  contentHash: string | null
  scenes: Array<{ heading: string; beats: string[] }>
  /** 「修订建议」条目（已格式化的 `[阻断] type（bt_001）：why`）。 */
  notes: string[]
  /** 报告轮次 / provider 摘要，只出现在「修订建议」小节的说明行。 */
  notesMeta?: string | null
}

export interface DocxExportInput {
  projectTitle: string
  /** 标题页作者名；空 = 不写作者行。 */
  author?: string
  chapters: DocxChapterInput[]
  includeNotes: boolean
  toc: boolean
  font: ExportFont
  fontSize: ExportFontSize
  lineSpacing: ExportLineSpacing
  /** 导出时间：标题页日期 + core 属性归一化基准。 */
  generatedAt: Date
}

const WESTERN_FONT = 'Times New Roman'
const MUTED = '6B6257'

/** 中文首行缩进 2 字符：1 字符 = 字号（pt）× 20 twips。 */
function firstLineTwips(fontSize: number): number {
  return Math.round(fontSize * 20 * 2)
}

/** Word 行距：240 = 单倍。 */
function lineTwips(lineSpacing: number): number {
  return Math.round(240 * lineSpacing)
}

/** 章标题：纲标题已带「第 N 章」时不再重复前缀。 */
export function docxChapterHeading(ord: number, title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return `第 ${ord} 章`
  if (/^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*章/.test(trimmed)) return trimmed
  return `第 ${ord} 章\u3000${trimmed}`
}

function dateLabel(at: Date): string {
  return `${at.getFullYear()} 年 ${at.getMonth() + 1} 月 ${at.getDate()} 日`
}

function run(text: string, input: DocxExportInput, extra: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}): TextRun {
  return new TextRun({
    text,
    bold: extra.bold ?? false,
    italics: extra.italics ?? false,
    size: extra.size ?? Math.round(input.fontSize * 2),
    color: extra.color,
    font: {
      ascii: WESTERN_FONT,
      hAnsi: WESTERN_FONT,
      eastAsia: input.font,
      cs: WESTERN_FONT
    }
  })
}

function bodyParagraph(text: string, input: DocxExportInput): Paragraph {
  return new Paragraph({
    children: [run(text, input)],
    indent: { firstLine: firstLineTwips(input.fontSize) },
    spacing: { line: lineTwips(input.lineSpacing), lineRule: 'auto' },
    alignment: AlignmentType.JUSTIFIED
  })
}

function sceneSeparator(input: DocxExportInput): Paragraph {
  return new Paragraph({
    children: [run('＊　＊　＊', input, { color: MUTED })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 160 }
  })
}

function buildTitlePage(input: DocxExportInput): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [run(input.projectTitle, input, { bold: true, size: 44 })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 3600, after: 480 }
    })
  ]
  if (input.author !== undefined && input.author.trim().length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [run(input.author.trim(), input, { size: 28 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 }
      })
    )
  }
  paragraphs.push(
    new Paragraph({
      children: [run(dateLabel(input.generatedAt), input, { size: 24, color: MUTED })],
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({ children: [new PageBreak()] })
  )
  return paragraphs
}

function buildToc(input: DocxExportInput): FileChild[] {
  return [
    new Paragraph({
      children: [run('目录', input, { bold: true, size: 32 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 }
    }),
    // 目录由 docx 依据 Heading1 生成条目（没有页码，Word 打开时按 beginDirty 更新）。
    new TableOfContents('目录', {
      hyperlink: true,
      headingStyleRange: '1-1',
      tabLeader: LeaderType.DOT
    }),
    new Paragraph({ children: [new PageBreak()] })
  ]
}

function buildChapter(chapter: DocxChapterInput, input: DocxExportInput): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [run(docxChapterHeading(chapter.ord, chapter.title), input, { bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 }
    })
  ]

  if (chapter.draft) {
    paragraphs.push(
      new Paragraph({
        children: [
          run('草稿 · 尚未定稿', input, { italics: true, size: Math.round(input.fontSize * 2) - 2, color: MUTED })
        ],
        spacing: { after: 120 }
      })
    )
  }

  const scenes = chapter.scenes.filter((scene) => scene.beats.length > 0)
  scenes.forEach((scene, index) => {
    if (index > 0) paragraphs.push(sceneSeparator(input))
    for (const body of scene.beats) paragraphs.push(bodyParagraph(body, input))
  })

  if (input.includeNotes && chapter.notes.length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [run('修订建议', input, { bold: true, size: 26 })],
        heading: HeadingLevel.HEADING_2,
        pageBreakBefore: false,
        spacing: { before: 360, after: 100 }
      }),
      new Paragraph({
        children: [
          run(
            chapter.notesMeta !== undefined && chapter.notesMeta !== null && chapter.notesMeta.length > 0
              ? `仅建议，未改正文。来自最近一次审批报告（${chapter.notesMeta}）。`
              : '仅建议，未改正文。来自最近一次审批报告。',
            input,
            { italics: true, size: Math.round(input.fontSize * 2) - 2, color: MUTED }
          )
        ],
        spacing: { after: 120 }
      })
    )
    for (const note of chapter.notes) {
      paragraphs.push(
        new Paragraph({
          children: [run(note, input, { size: Math.round(input.fontSize * 2) - 2 })],
          spacing: { after: 60 }
        })
      )
    }
  }

  return paragraphs
}

function buildDocument(input: DocxExportInput): Document {
  // 文件属性写「revision / content_hash」：作者用 Word 的「属性」就能核对导出的版本。
  const revisionNote = input.chapters
    .filter((chapter) => chapter.revisionId !== null)
    .map((chapter) => `${chapter.ord}:${chapter.revisionId}/${chapter.contentHash ?? ''}`)
    .join(' ')

  const sections: ISectionOptions[] = [
    {
      properties: {
        titlePage: true,
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  children: [PageNumber.CURRENT],
                  font: { ascii: WESTERN_FONT, hAnsi: WESTERN_FONT, eastAsia: input.font, cs: WESTERN_FONT },
                  size: Math.round(input.fontSize * 2) - 4
                })
              ],
              alignment: AlignmentType.CENTER
            })
          ]
        }),
        first: new Footer({ children: [new Paragraph('')] })
      },
      children: [
        ...buildTitlePage(input),
        ...(input.toc ? buildToc(input) : []),
        ...input.chapters.flatMap((chapter) => buildChapter(chapter, input))
      ]
    }
  ]

  return new Document({
    creator: input.author !== undefined && input.author.trim().length > 0 ? input.author.trim() : 'Noryth',
    title: input.projectTitle,
    description: `Noryth 导出${revisionNote.length > 0 ? ` · ${revisionNote}` : ''}`,
    lastModifiedBy: 'Noryth',
    features: { updateFields: input.toc },
    styles: {
      default: {
        document: {
          run: {
            size: Math.round(input.fontSize * 2),
            font: {
              ascii: WESTERN_FONT,
              hAnsi: WESTERN_FONT,
              eastAsia: input.font,
              cs: WESTERN_FONT
            }
          },
          paragraph: {
            spacing: { line: lineTwips(input.lineSpacing), lineRule: 'auto' }
          }
        }
      }
    },
    sections
  })
}

/** core 属性时间归一化到「导出日零点」，同一天同一份清单两次导出字节一致。 */
function normalizedCoreDate(at: Date): string {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).toISOString()
}

/**
 * docx 的目录书签名（`_TocN`）与 bookmark 数字 id 来自模块级计数器：
 * 同一进程里生成第二份文档时会接着编号，同清单两次导出字节就不同了。
 * 这里按出现顺序重编号（名字与 id 一一对应，目录超链接与标题书签仍对得上），
 * 于是可复现只取决于清单内容，而不是「这是本次运行的第三份文档」。
 */
function normalizeBookmarks(xml: string): string {
  const names = new Map<string, string>()
  let nameCount = 0
  let out = xml.replace(/_Toc\d+/g, (match) => {
    let mapped = names.get(match)
    if (mapped === undefined) {
      nameCount += 1
      mapped = `_Toc${nameCount}`
      names.set(match, mapped)
    }
    return mapped
  })
  const ids = new Map<string, string>()
  let idCount = 0
  out = out.replace(/(<w:bookmark(?:Start|End)[^>]*w:id=")(\d+)(")/g, (_all, prefix: string, id: string, suffix: string) => {
    let mapped = ids.get(id)
    if (mapped === undefined) {
      idCount += 1
      mapped = String(idCount)
      ids.set(id, mapped)
    }
    return `${prefix}${mapped}${suffix}`
  })
  return out
}

function normalizeArchive(buffer: Buffer, at: Date): Buffer {
  const entries = unzipSync(new Uint8Array(buffer))
  const core = entries['docProps/core.xml']
  if (core !== undefined) {
    const stamp = normalizedCoreDate(at)
    const xml = strFromU8(core)
      .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/g, `$1${stamp}$2`)
      .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/g, `$1${stamp}$2`)
    entries['docProps/core.xml'] = strToU8(xml)
  }
  const document = entries['word/document.xml']
  if (document !== undefined) {
    entries['word/document.xml'] = strToU8(normalizeBookmarks(strFromU8(document)))
  }
  return Buffer.from(zipSync(entries, { mtime: DOCX_ZIP_EPOCH, level: 6 }))
}

export async function renderDocx(input: DocxExportInput): Promise<Buffer> {
  const raw = await Packer.toBuffer(buildDocument(input))
  return normalizeArchive(raw, input.generatedAt)
}
