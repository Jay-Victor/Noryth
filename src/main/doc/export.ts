import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'

/**
 * 导出（PRD §5.5 P0 / PHASE-10 J2 第 13 步）。
 *
 * 只读：从当前 live 拍与最新 revision 生成 Markdown / TXT，写到 `exports/`。
 * 导出文件带 `revision` 与 `content_hash`，作者可以用它核对「导出的就是这一版」。
 * 「正文 + 批注」把最近一份审批报告的建议附在文末，不改正文。
 */

export interface ExportInput {
  chapterId?: string
  format: 'md' | 'txt'
  /** false = 仅正文；true = 正文 + 批注（审批建议）。 */
  includeNotes: boolean
}

export interface ExportResult {
  path: string
  bytes: number
  sha256: string
  chapters: number
  beats: number
  words: number
  revisionIds: string[]
}

interface ChapterBlock {
  chapterId: string
  title: string
  ord: number
  revisionId: string | null
  contentHash: string | null
  scenes: Array<{ heading: string; beats: string[] }>
  notes: string[]
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
function parseIssues(json: string, level: '阻断' | '建议'): Array<{ type: string; beat_id: string; why: string; level: string }> {
  try {
    const parsed = JSON.parse(json) as Array<{ type?: string; beat_id?: string; why?: string }>
    return parsed.map((issue) => ({
      type: issue.type ?? 'issue',
      beat_id: issue.beat_id ?? '',
      why: issue.why ?? '',
      level
    }))
  } catch {
    return []
  }
}

function buildChapter(repos: Repos, chapterId: string, includeNotes: boolean): ChapterBlock {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} missing`)
  const node = repos.outline.get(chapter.outlineNodeId)
  const revisions = repos.revision.listByChapter(chapterId)
  const latest = revisions.at(-1) ?? null
  const scenes = repos.scene.listByChapter(chapterId).map((entry) => {
    const beats = repos.beat
      .listLiveByScene(entry.scene.id)
      .filter((beat) => beat.body.trim().length > 0)
      .sort((a, b) => a.ord - b.ord)
      .map((beat) => beat.body.trim())
    return { heading: `${entry.scene.ord} · ${entry.scene.location || '未命名场景'}`, beats }
  })

  const notes: string[] = []
  if (includeNotes) {
    const reports = repos.review.listReportsByChapter(chapterId)
    const report = reports.at(-1)
    if (report) {
      const issues = [
        ...parseIssues(report.blockingJson, '阻断'),
        ...parseIssues(report.suggestionsJson, '建议')
      ]
      for (const issue of issues) {
        const where = issue.beat_id.length > 0 ? `（${issue.beat_id}）` : ''
        notes.push(`- [${issue.level}] ${issue.type}${where}：${issue.why}`)
      }
    }
  }

  return {
    chapterId,
    title: node?.title ?? `第 ${chapter.ord} 章`,
    ord: chapter.ord,
    revisionId: latest?.id ?? null,
    contentHash: latest?.contentHash ?? null,
    scenes,
    notes
  }
}

function renderMarkdown(projectTitle: string, chapters: ChapterBlock[], includeNotes: boolean): string {
  const lines: string[] = [`# ${projectTitle}`, '']
  for (const chapter of chapters) {
    lines.push('---', '')
    if (chapter.revisionId !== null && chapter.contentHash !== null) {
      lines.push(`<!-- revision: ${chapter.revisionId} content_hash: ${chapter.contentHash} -->`)
    }
    lines.push(`## ${chapter.title}`, '')
    for (const scene of chapter.scenes) {
      if (chapter.scenes.length > 1) lines.push(`### ${scene.heading}`, '')
      for (const body of scene.beats) {
        lines.push(body, '')
      }
    }
    if (includeNotes && chapter.notes.length > 0) {
      lines.push('### 批注', '', ...chapter.notes, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderText(projectTitle: string, chapters: ChapterBlock[], includeNotes: boolean): string {
  const lines: string[] = [projectTitle, '']
  for (const chapter of chapters) {
    lines.push(chapter.title, '')
    for (const scene of chapter.scenes) {
      for (const body of scene.beats) lines.push(body, '')
    }
    if (includeNotes && chapter.notes.length > 0) {
      lines.push('[批注]', ...chapter.notes, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export function exportManuscript(repos: Repos, projectDir: string, input: ExportInput, at: Date = new Date()): ExportResult {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project row')

  const chapterIds =
    input.chapterId === undefined
      ? repos.chapter.listByProject(project.id).sort((a, b) => a.ord - b.ord).map((chapter) => chapter.id)
      : [input.chapterId]
  if (chapterIds.length === 0) throw new AppError('invalid_args', '没有可导出的章节')

  const chapters = chapterIds.map((id) => buildChapter(repos, id, input.includeNotes))
  const content =
    input.format === 'md'
      ? renderMarkdown(project.title, chapters, input.includeNotes)
      : renderText(project.title, chapters, input.includeNotes)

  const dir = join(projectDir, 'exports')
  mkdirSync(dir, { recursive: true })
  const base =
    input.chapterId === undefined
      ? safeName(project.title)
      : safeName(chapters[0]!.title)
  const path = join(dir, `${base}-${stamp(at)}.${input.format}`)
  writeFileSync(path, content, 'utf8')

  const beats = chapters.reduce(
    (sum, chapter) => sum + chapter.scenes.reduce((inner, scene) => inner + scene.beats.length, 0),
    0
  )
  return {
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    chapters: chapters.length,
    beats,
    words: chapters.reduce(
      (sum, chapter) => sum + chapter.scenes.reduce((inner, scene) => inner + scene.beats.reduce((n, body) => n + countWords(body), 0), 0),
      0
    ),
    revisionIds: chapters.flatMap((chapter) => (chapter.revisionId === null ? [] : [chapter.revisionId]))
  }
}
