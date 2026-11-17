import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportManuscript } from '../../../src/main/doc/export'
import { finalizeChapter } from '../../../src/main/doc/finalize'
import { unzip } from '../../support/unzip'
import { openTestDb } from '../db/support/db'
import { seedFixture } from '../db/support/fixture'
import { tempDir } from '../helpers'

/**
 * DOCX 导出（PHASE-17 M1-6 / M1-14 / §5.3）。
 *
 * 断言的是解压后的 XML 与字节层面的事实：能打开（zip 结构 + 正文 XML）、
 * 只读（不新增 revision）、可复现（同清单两次导出字节一致、zip 时间戳归一）、
 * 选项生效（字体 / 字号 / 行距 / 目录）、批注不改正文（两档只差章末小节）。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** 固定导出时间：zip 时间戳与 core 属性都归一化，字节才可复现。 */
const FIXED_AT = new Date('2026-11-17T09:30:00')

function setup() {
  const dir = tempDir('noryth-docx-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { dir: dir.path, handle, seed }
}

function entryText(path: string, name: string): string {
  const found = unzip(readFileSync(path)).find((entry) => entry.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found.data.toString('utf8')
}

function documentText(path: string): string {
  // 只取可见文本（<w:t>），不把域指令（TOC / PAGEREF）算成正文。
  const xml = entryText(path, 'word/document.xml')
  return [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1] ?? '').join('')
}

function chapterTitleOf(handle: ReturnType<typeof openTestDb>, chapterId: string): string {
  const chapter = handle.repos.chapter.get(chapterId)!
  return handle.repos.outline.get(chapter.outlineNodeId)?.title ?? ''
}

/** 每个 zip 条目的 DOS 修改日期（central directory 偏移 14）。 */
function centralDates(buffer: Buffer): number[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD missing')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const dates: number[] = []
  for (let index = 0; index < count; index += 1) {
    dates.push(buffer.readUInt16LE(cursor + 14))
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return dates
}

describe('DOCX 导出（PHASE-17）', () => {
  it('可解压：标题页 + 章标题 + 每章首段；无 Key / 日志字符串', async () => {
    const { dir, handle, seed } = setup()
    const before = seed.chapterIds.map((id) => handle.repos.revision.listByChapter(id).length)

    const result = await exportManuscript(
      handle.repos,
      dir,
      { format: 'docx', includeNotes: false, toc: true, author: '沈昼' },
      FIXED_AT
    )

    expect(result.path.endsWith('.docx')).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(result.format).toBe('docx')
    expect(result.chapters).toBe(seed.chapterIds.length)
    expect(result.drafts).toBe(seed.chapterIds.length)
    expect(result.bytes).toBeGreaterThan(1024)

    const entries = unzip(readFileSync(result.path)).map((entry) => entry.name)
    expect(entries).toContain('[Content_Types].xml')
    expect(entries).toContain('word/document.xml')
    expect(entries).toContain('docProps/core.xml')

    const text = documentText(result.path)
    expect(text).toContain(handle.repos.project.get()!.title)
    expect(text).toContain('沈昼')
    expect(text).toContain('2026 年 11 月 17 日')
    for (const chapterId of seed.chapterIds) {
      expect(text).toContain(chapterTitleOf(handle, chapterId))
      const firstBeat = handle.repos.revision.manifest(
        handle.repos.chapter.get(chapterId)!.currentRevisionId!
      )[0]!
      expect(text).toContain(firstBeat.body.trim())
    }

    // 文件属性：revision 与 content_hash 可核对；不写 Key、日志、secrets
    const core = entryText(result.path, 'docProps/core.xml')
    for (const revisionId of result.revisionIds) expect(core).toContain(revisionId)
    const latest = handle.repos.chapter.get(seed.chapterIds[0]!)!
    expect(core).toContain(handle.repos.revision.get(latest.currentRevisionId!)!.contentHash)
    const everything = entries.map((name) => entryText(result.path, name)).join('\n')
    expect(everything).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(everything).not.toContain('secrets.bin')
    expect(everything).not.toContain('[INFO]')

    // 只读：导出不产生 revision
    expect(seed.chapterIds.map((id) => handle.repos.revision.listByChapter(id).length)).toEqual(before)
  })

  it('同一清单两次导出字节一致，zip 时间戳归一 2000-01-01', async () => {
    const { dir, handle } = setup()
    const first = await exportManuscript(handle.repos, dir, { format: 'docx', toc: true }, FIXED_AT)
    const second = await exportManuscript(handle.repos, dir, { format: 'docx', toc: true }, FIXED_AT)

    expect(first.sha256).toBe(second.sha256)
    expect(first.path).not.toBe(second.path)
    expect(readFileSync(first.path).equals(readFileSync(second.path))).toBe(true)

    // DOS date: (2000-1980)<<9 | 1<<5 | 1 = 0x2821
    const dates = centralDates(readFileSync(first.path))
    expect(dates.length).toBeGreaterThan(5)
    expect(new Set(dates)).toEqual(new Set([0x2821]))

    const core = entryText(first.path, 'docProps/core.xml')
    expect(core).toContain(new Date(2026, 10, 17).toISOString())
    expect(core).not.toContain('2000-01-01')
  })

  it('「仅正文」与「正文 + 修订建议」正文逐字一致，只在章末多出建议', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const revision = handle.repos.revision.listByChapter(chapterId).at(-1)!
    handle.repos.review.insertReport({
      projectId: seed.projectId,
      chapterId,
      revisionId: revision.id,
      round: 2,
      verdict: 'fail',
      provider: 'deepseek',
      blockingJson: JSON.stringify([
        { issue_id: 'is_1', type: 'timeline_error', beat_id: 'bt_001', evidence: '雨夜', why: '时间线冲突' }
      ]),
      suggestionsJson: JSON.stringify([
        { issue_id: 'is_2', type: 'voice', beat_id: 'bt_002', evidence: '茶盏', why: '语气偏旁白' }
      ])
    })

    const plain = await exportManuscript(
      handle.repos,
      dir,
      { format: 'docx', chapterId, includeNotes: false },
      FIXED_AT
    )
    const annotated = await exportManuscript(
      handle.repos,
      dir,
      { format: 'docx', chapterId, includeNotes: true },
      FIXED_AT
    )

    const plainText = documentText(plain.path)
    const annotatedText = documentText(annotated.path)
    expect(plainText).not.toContain('修订建议')
    expect(annotatedText).toContain('修订建议')
    expect(annotatedText).toContain('仅建议，未改正文')
    expect(annotatedText).toContain('第 2 轮 · deepseek')
    expect(annotatedText).toContain('[阻断] timeline_error（bt_001）：时间线冲突')
    expect(annotatedText).toContain('[建议] voice（bt_002）：语气偏旁白')

    // 批注不改变正文：仅正文的输出是「正文 + 批注」的逐字前缀，多出来的只有章末小节
    expect(annotatedText.startsWith(plainText)).toBe(true)
    const extra = annotatedText.slice(plainText.length)
    expect(extra).toContain('修订建议')
    expect(extra).toContain('[阻断] timeline_error（bt_001）：时间线冲突')
    for (const member of handle.repos.revision.manifest(revision.id)) {
      expect(plainText).toContain(member.body.trim())
    }
  })

  it('字体 / 字号 / 行距 / 目录开关写入 XML', async () => {
    const { dir, handle } = setup()
    const styled = await exportManuscript(
      handle.repos,
      dir,
      { format: 'docx', font: '思源宋体', fontSize: 10.5, lineSpacing: 2, toc: false },
      FIXED_AT
    )
    const xml = entryText(styled.path, 'word/document.xml')
    expect(xml).toContain('w:eastAsia="思源宋体"')
    expect(xml).toContain('w:sz w:val="21"')
    expect(xml).toContain('w:line="480"')
    expect(xml).toContain('w:firstLine="420"')
    expect(xml).not.toContain('TOC \\o')

    const withToc = await exportManuscript(handle.repos, dir, { format: 'docx', toc: true }, FIXED_AT)
    const tocXml = entryText(withToc.path, 'word/document.xml')
    expect(tocXml).toContain('TOC \\h \\o')
    // 目录条目由标题生成：章标题在目录与正文各出现一次
    const title = chapterTitleOf(handle, handle.repos.chapter.listByProject(handle.repos.project.get()!.id)[0]!.id)
    expect(tocXml.split(title).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('未定稿章标「草稿」；定稿后只读 final 清单', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const draftExport = await exportManuscript(handle.repos, dir, { format: 'docx', chapterId }, FIXED_AT)
    expect(documentText(draftExport.path)).toContain('草稿 · 尚未定稿')
    expect(draftExport.drafts).toBe(1)
    expect(draftExport.revisionIds[0]).toBe(handle.repos.chapter.get(chapterId)!.currentRevisionId)

    const gate = handle.repos.gate.insert({
      projectId: seed.projectId,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: chapterId,
      decision: 'approve',
      actor: 'author'
    })
    handle.repos.chapter.setStatus(chapterId, 'approved')
    const finalized = finalizeChapter(handle.db, handle.repos, {
      chapterId,
      gateRecordId: gate.id,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })

    const finalExport = await exportManuscript(handle.repos, dir, { format: 'docx', chapterId }, FIXED_AT)
    const text = documentText(finalExport.path)
    expect(text).not.toContain('草稿 · 尚未定稿')
    expect(finalExport.drafts).toBe(0)
    expect(finalExport.revisionIds).toEqual([finalized.finalRevisionId])
    expect(entryText(finalExport.path, 'docProps/core.xml')).toContain(finalized.finalRevisionId)
  })

  it('同名文件追加序号不覆盖；本章导出缺 chapterId 直接拒绝', async () => {
    const { dir, handle } = setup()
    const first = await exportManuscript(handle.repos, dir, { format: 'docx' }, FIXED_AT)
    const second = await exportManuscript(handle.repos, dir, { format: 'docx' }, FIXED_AT)
    const third = await exportManuscript(handle.repos, dir, { format: 'docx' }, FIXED_AT)

    expect(new Set([first.path, second.path, third.path]).size).toBe(3)
    expect(basename(second.path)).toMatch(/-2\.docx$/)
    expect(basename(third.path)).toMatch(/-3\.docx$/)
    for (const path of [first.path, second.path, third.path]) expect(existsSync(path)).toBe(true)

    await expect(
      exportManuscript(handle.repos, dir, { format: 'docx', scope: 'chapter' }, FIXED_AT)
    ).rejects.toMatchObject({ code: 'invalid_args' })

    // 路径固定在项目 exports/ 下
    expect(first.path.startsWith(`${dir}/exports`) || first.path.startsWith(`${dir}\\exports`)).toBe(true)
    expect(first.path).not.toContain('..')
  })
})
