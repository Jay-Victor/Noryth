import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AppError } from '../../shared/domain/app-error'
import type { ExportFont, ExportFontSize, ExportFormat, ExportLineSpacing } from '../../shared/schema/export'
import type { Repos } from '../db/repos'
import { renderDocx, type DocxChapterInput } from './export-docx'

/**
 * 导出（PRD §5.5 P0 / PHASE-10 J2 / PHASE-17 M1-6、M1-14）。
 *
 * 只读：从 revision 清单渲染 Markdown / TXT / DOCX，写到项目 `exports/`。
 * 定稿章取 `final_revision_id` 的清单；未定稿章取当前 draft 并标「草稿」——
 * 导出永远是快照，不是新真相：不建 revision、不写 outbox、不改正文。
 *
 * 三档格式共用同一份清单，所以同一 revision 导出的 md/txt/docx 说的是同一版；
 * 文件属性（revision / content_hash）让作者可以核对「导出的就是这一版」。
 */

export interface ExportInput {
  chapterId?: string
  format: ExportFormat
  /** 缺省按 `chapterId` 推断：给了 = chapter，没给 = book。 */
  scope?: 'chapter' | 'book'
  /** false = 仅正文；true = 正文 + 修订建议（审批报告）。 */
  includeNotes?: boolean
  /** 仅 DOCX。 */
  toc?: boolean
  /** 仅 DOCX。 */
  font?: ExportFont
  /** 仅 DOCX。 */
  fontSize?: ExportFontSize
  /** 仅 DOCX。 */
  lineSpacing?: ExportLineSpacing
  /** 仅 DOCX 标题页；不落库。 */
  author?: string
}

export interface ExportResult {
  format: ExportFormat
  path: string
  bytes: number
  sha256: string
  chapters: number
  beats: number
  words: number
  revisionIds: string[]
  drafts: number
}

export interface ExportChapterBlock extends DocxChapterInput {
  chapterId: string
}

function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'export'
}

function countWords(text: string): number {
  // 与 hash/统计口径一致：去掉空白后的字符数（中文按字）。
  return text.replace(/\s+/g, '').length
}

/** 审批报告里的 issue 是 JSON 文本；导出只取「位置 + 原因」，不回写任何东西。 */
function parseIssues(
  json: string,
  level: '阻断' | '建议'
): Array<{ type: string; beatId: string; why: string; level: string }> {
  try {
    const parsed = JSON.parse(json) as Array<{ type?: string; beat_id?: string; why?: string }>
    return parsed.map((issue) => ({
      type: issue.type ?? 'issue',
      beatId: issue.beat_id ?? '',
      why: issue.why ?? '',
      level
    }))
  } catch {
    return []
  }
}

/**
 * 导出的版本口径（PHASE-17 §5.1 / DEV-PLAN §9.8）：
 * - `finalized` 章只认 `final_revision_id`（旧 final 不冒充当前稿）；
 * - 其余章取 `current_revision_id` 的 draft，标「草稿」；
 * - 两者都没有（只有拍、还没提交过 revision）时导出空章节，不退回 live 拍。
 */
function pickRevision(
  repos: Repos,
  chapterId: string
): { revisionId: string | null; contentHash: string | null; draft: boolean } {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} missing`)
  const final = chapter.finalRevisionId === null ? null : repos.revision.get(chapter.finalRevisionId)
  const current = chapter.currentRevisionId === null ? null : repos.revision.get(chapter.currentRevisionId)
  const chosen = chapter.status === 'finalized' ? (final ?? current) : (current ?? final)
  if (!chosen) return { revisionId: null, contentHash: null, draft: true }
  return { revisionId: chosen.id, contentHash: chosen.contentHash, draft: chosen.kind !== 'final' }
}

function buildChapter(repos: Repos, chapterId: string, includeNotes: boolean): ExportChapterBlock {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} missing`)
  const node = repos.outline.get(chapter.outlineNodeId)
  const picked = pickRevision(repos, chapterId)
  const members = picked.revisionId === null ? [] : repos.revision.manifest(picked.revisionId)

  // 清单按 (scene_ord, beat_ord) 排序；场景名取 scene 行，只用于多场景分隔。
  const order: number[] = []
  const grouped = new Map<number, { sceneId: string; beats: string[] }>()
  for (const member of members) {
    let group = grouped.get(member.sceneOrd)
    if (!group) {
      group = { sceneId: member.sceneId, beats: [] }
      grouped.set(member.sceneOrd, group)
      order.push(member.sceneOrd)
    }
    const body = member.body.trim()
    if (body.length > 0) group.beats.push(body)
  }
  const scenes = order.map((sceneOrd) => {
    const group = grouped.get(sceneOrd)!
    const location = repos.scene.get(group.sceneId)?.location ?? ''
    return { heading: `${sceneOrd} · ${location.trim() || '未命名场景'}`, beats: group.beats }
  })

  const notes: string[] = []
  let notesMeta: string | null = null
  if (includeNotes) {
    const report = repos.review.listReportsByChapter(chapterId).at(-1)
    if (report) {
      const issues = [...parseIssues(report.blockingJson, '阻断'), ...parseIssues(report.suggestionsJson, '建议')]
      for (const issue of issues) {
        const where = issue.beatId.length > 0 ? `（${issue.beatId}）` : ''
        notes.push(`[${issue.level}] ${issue.type}${where}：${issue.why}`)
      }
      const who = report.provider ?? report.model
      notesMeta = [`第 ${report.round} 轮`, who].filter((part): part is string => Boolean(part)).join(' · ')
    }
  }

  return {
    chapterId,
    title: node?.title ?? `第 ${chapter.ord} 章`,
    ord: chapter.ord,
    draft: picked.draft,
    revisionId: picked.revisionId,
    contentHash: picked.contentHash,
    scenes,
    notes,
    notesMeta
  }
}

function renderMarkdown(projectTitle: string, chapters: ExportChapterBlock[], includeNotes: boolean): string {
  const lines: string[] = [`# ${projectTitle}`, '']
  for (const chapter of chapters) {
    lines.push('---', '')
    if (chapter.revisionId !== null && chapter.contentHash !== null) {
      const kind = chapter.draft ? ' draft' : ''
      lines.push(`<!-- revision: ${chapter.revisionId} content_hash: ${chapter.contentHash}${kind} -->`)
    }
    lines.push(`## ${chapter.title}`, '')
    for (const scene of chapter.scenes) {
      if (chapter.scenes.length > 1) lines.push(`### ${scene.heading}`, '')
      for (const body of scene.beats) lines.push(body, '')
    }
    if (includeNotes && chapter.notes.length > 0) {
      lines.push('### 批注', '', ...chapter.notes.map((note) => `- ${note}`), '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderText(projectTitle: string, chapters: ExportChapterBlock[], includeNotes: boolean): string {
  const lines: string[] = [projectTitle, '']
  for (const chapter of chapters) {
    lines.push(chapter.title, '')
    for (const scene of chapter.scenes) {
      for (const body of scene.beats) lines.push(body, '')
    }
    if (includeNotes && chapter.notes.length > 0) {
      lines.push('[批注]', ...chapter.notes.map((note) => `- ${note}`), '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * 目标路径固定在项目 `exports/` 下（PHASE-17 §5.2）：文件名只由书名/章名 + 时间戳生成，
 * 仍然逐次做一次「解析后必须在 exports/ 内」的校验，作为 `..` / 绝对路径注入的兜底。
 */
function resolveTarget(dir: string, base: string, extension: string): string {
  const root = resolve(dir)
  const candidate = resolve(join(root, `${base}.${extension}`))
  const rel = relative(root, candidate)
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AppError('invalid_args', '导出路径越界')
  }
  if (!existsSync(candidate)) return candidate
  // 同名不覆盖：追加序号（PHASE-17 §5.2 / 验收清单）。
  for (let index = 2; index < 1000; index += 1) {
    const numbered = resolve(join(root, `${base}-${index}.${extension}`))
    if (!existsSync(numbered)) return numbered
  }
  throw new AppError('invalid_args', '导出目录内同名文件过多')
}

export async function exportManuscript(
  repos: Repos,
  projectDir: string,
  input: ExportInput,
  at: Date = new Date()
): Promise<ExportResult> {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project row')

  const scope = input.scope ?? (input.chapterId === undefined ? 'book' : 'chapter')
  if (scope === 'chapter' && input.chapterId === undefined) {
    throw new AppError('invalid_args', '导出本章需要 chapterId')
  }
  const chapterIds =
    scope === 'chapter'
      ? [input.chapterId!]
      : repos.chapter
          .listByProject(project.id)
          .sort((a, b) => a.ord - b.ord)
          .map((chapter) => chapter.id)
  if (chapterIds.length === 0) throw new AppError('invalid_args', '没有可导出的章节')

  const includeNotes = input.includeNotes === true
  const chapters = chapterIds.map((id) => buildChapter(repos, id, includeNotes))

  const dir = join(projectDir, 'exports')
  mkdirSync(dir, { recursive: true })
  const base = safeName(scope === 'chapter' ? chapters[0]!.title : project.title)
  const path = resolveTarget(dir, `${base}-${stamp(at)}`, input.format)

  let bytes: number
  let sha256: string
  if (input.format === 'docx') {
    const buffer = await renderDocx({
      projectTitle: project.title,
      author: input.author,
      chapters,
      includeNotes,
      toc: input.toc !== false,
      font: input.font ?? '宋体',
      fontSize: input.fontSize ?? 12,
      lineSpacing: input.lineSpacing ?? 1.5,
      generatedAt: at
    })
    writeFileSync(path, buffer)
    bytes = buffer.length
    sha256 = createHash('sha256').update(buffer).digest('hex')
  } else {
    const content =
      input.format === 'md'
        ? renderMarkdown(project.title, chapters, includeNotes)
        : renderText(project.title, chapters, includeNotes)
    writeFileSync(path, content, 'utf8')
    bytes = Buffer.byteLength(content, 'utf8')
    sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
  }

  return {
    format: input.format,
    path,
    bytes,
    sha256,
    chapters: chapters.length,
    beats: chapters.reduce(
      (sum, chapter) => sum + chapter.scenes.reduce((inner, scene) => inner + scene.beats.length, 0),
      0
    ),
    words: chapters.reduce(
      (sum, chapter) =>
        sum + chapter.scenes.reduce((inner, scene) => inner + scene.beats.reduce((n, body) => n + countWords(body), 0), 0),
      0
    ),
    revisionIds: chapters.flatMap((chapter) => (chapter.revisionId === null ? [] : [chapter.revisionId])),
    drafts: chapters.filter((chapter) => chapter.draft).length
  }
}
