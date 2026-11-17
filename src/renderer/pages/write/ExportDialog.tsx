import { useEffect, useMemo, useState } from 'react'
import type {
  ExportFont,
  ExportFontSize,
  ExportFormat,
  ExportLineSpacing
} from '../../../shared/schema/export'
import { useOverlayDismiss } from '../../hooks'
import { getBridge } from '../../lib/bridge'
import { useApp } from '../../stores/app'

/**
 * 导出对话框（PHASE-17 §3 / §5.2 / UI-DESIGN §5）。
 *
 * 三档格式（Markdown / TXT / DOCX）+ 范围（本章 / 全书）+ 批注 + DOCX 排版选项。
 * 选项只影响这一次导出文件，不写 `settings.json`；导出是只读快照：
 * 不产生 revision，同名文件追加序号，不覆盖已有导出。
 */

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'docx', label: 'Word（DOCX）', hint: '可投稿；标题页 + 目录 + 章标题' },
  { value: 'md', label: 'Markdown', hint: '带 revision / content_hash 注释' },
  { value: 'txt', label: '纯文本', hint: '无任何标记，便于粘贴' }
]

const FONT_SIZES: ExportFontSize[] = [10.5, 12, 14]
const LINE_SPACINGS: ExportLineSpacing[] = [1.15, 1.5, 2]
const FONTS: ExportFont[] = ['宋体', '思源宋体']

function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

export interface ExportDialogProps {
  open: boolean
  projectTitle: string
  chapterId: string | null
  chapterTitle: string
  onClose: () => void
}

export function ExportDialog({ open, projectTitle, chapterId, chapterTitle, onClose }: ExportDialogProps): React.JSX.Element | null {
  const overlayRef = useOverlayDismiss(open, onClose)
  const toast = useApp((store) => store.toast)
  const [format, setFormat] = useState<ExportFormat>('docx')
  const [scope, setScope] = useState<'chapter' | 'book'>('book')
  const [includeNotes, setIncludeNotes] = useState(false)
  const [toc, setToc] = useState(true)
  const [font, setFont] = useState<ExportFont>('宋体')
  const [fontSize, setFontSize] = useState<ExportFontSize>(12)
  const [lineSpacing, setLineSpacing] = useState<ExportLineSpacing>(1.5)
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setScope('book')
  }, [open])

  const estimatedName = useMemo(() => {
    const base = (scope === 'chapter' && chapterId !== null ? chapterTitle : projectTitle).trim() || 'export'
    const safe = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)
    return `exports/${safe}-${stamp(new Date())}.${format}`
  }, [scope, chapterId, chapterTitle, projectTitle, format])

  if (!open) return null

  const run = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) return
    setBusy(true)
    try {
      const result = await bridge.manuscript.export({
        chapterId: scope === 'chapter' && chapterId !== null ? chapterId : undefined,
        format,
        scope,
        includeNotes,
        toc,
        font,
        fontSize,
        lineSpacing,
        author: author.trim().length > 0 ? author.trim() : undefined
      })
      if (!result.ok) {
        toast({ tone: 'error', title: result.error.message, detail: result.error.code })
        return
      }
      const draftNote = result.data.drafts > 0 ? `（含 ${result.data.drafts} 章草稿）` : ''
      toast({
        tone: 'success',
        title: `已导出 ${result.data.chapters} 章 · ${result.data.words} 字${draftNote}`,
        detail: result.data.path,
        key: 'export-manuscript'
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="plan-modal" ref={overlayRef} data-testid="export-dialog">
      <div className="plan-modal__card export-card" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <h3 id="export-title">导出稿件</h3>
        <p>导出是只读快照：不生成新版本、不改正文；同名文件追加序号，不覆盖已有导出。</p>

        <div className="export-section">
          <span className="export-label">格式</span>
          <div className="export-choices" role="radiogroup" aria-label="导出格式">
            {FORMATS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={format === item.value}
                className={`export-choice${format === item.value ? ' is-active' : ''}`}
                data-testid={`export-format-${item.value}`}
                onClick={() => setFormat(item.value)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-section">
          <span className="export-label">范围</span>
          <div className="export-choices" role="radiogroup" aria-label="导出范围">
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'book'}
              className={`export-choice${scope === 'book' ? ' is-active' : ''}`}
              data-testid="export-scope-book"
              onClick={() => setScope('book')}
            >
              <strong>全书</strong>
              <span>按章序；每章前分页</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'chapter'}
              className={`export-choice${scope === 'chapter' ? ' is-active' : ''}`}
              data-testid="export-scope-chapter"
              disabled={chapterId === null}
              title={chapterId === null ? '先在左侧选择一章' : undefined}
              onClick={() => setScope('chapter')}
            >
              <strong>本章</strong>
              <span>{chapterId === null ? '未选择章节' : chapterTitle}</span>
            </button>
          </div>
        </div>

        <div className="export-section">
          <span className="export-label">批注</span>
          <div className="export-choices" role="radiogroup" aria-label="批注">
            <button
              type="button"
              role="radio"
              aria-checked={!includeNotes}
              className={`export-choice${!includeNotes ? ' is-active' : ''}`}
              data-testid="export-notes-off"
              onClick={() => setIncludeNotes(false)}
            >
              <strong>仅正文</strong>
              <span>可直接投稿</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={includeNotes}
              className={`export-choice${includeNotes ? ' is-active' : ''}`}
              data-testid="export-notes-on"
              onClick={() => setIncludeNotes(true)}
            >
              <strong>正文 + 修订建议</strong>
              <span>章末小节，仅建议、未改正文</span>
            </button>
          </div>
        </div>

        {format === 'docx' ? (
          <>
            <div className="export-section export-section--inline">
              <label className="export-field">
                <span>中文字体</span>
                <select
                  data-testid="export-font"
                  value={font}
                  onChange={(event) => setFont(event.target.value as ExportFont)}
                >
                  {FONTS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="export-field">
                <span>字号</span>
                <select
                  data-testid="export-font-size"
                  value={fontSize}
                  onChange={(event) => setFontSize(Number(event.target.value) as ExportFontSize)}
                >
                  {FONT_SIZES.map((item) => (
                    <option key={item} value={item}>
                      {item} pt
                    </option>
                  ))}
                </select>
              </label>
              <label className="export-field">
                <span>行距</span>
                <select
                  data-testid="export-line-spacing"
                  value={lineSpacing}
                  onChange={(event) => setLineSpacing(Number(event.target.value) as ExportLineSpacing)}
                >
                  {LINE_SPACINGS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="export-section export-section--inline">
              <label className="export-field export-field--check">
                <input
                  type="checkbox"
                  data-testid="export-toc"
                  checked={toc}
                  onChange={(event) => setToc(event.target.checked)}
                />
                <span>生成目录（Word 打开时更新页码）</span>
              </label>
              <label className="export-field export-field--wide">
                <span>标题页作者（可选）</span>
                <input
                  type="text"
                  data-testid="export-author"
                  maxLength={60}
                  value={author}
                  placeholder="例如：沈昼"
                  onChange={(event) => setAuthor(event.target.value)}
                />
              </label>
            </div>
          </>
        ) : null}

        <div className="export-name" data-testid="export-filename">
          <span>预计文件名</span>
          <code className="mono">{estimatedName}</code>
        </div>

        <div className="plan-modal__actions">
          <button type="button" className="plan-mini-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="export-run"
            disabled={busy || (scope === 'chapter' && chapterId === null)}
            onClick={() => void run()}
          >
            {busy ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
    </div>
  )
}
