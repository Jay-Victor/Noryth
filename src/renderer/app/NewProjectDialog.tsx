import { useEffect, useState } from 'react'
import type { PathCheck } from '../../shared/schema/project'
import { getBridge } from '../lib/bridge'
import { useApp } from '../stores/app'
import { useOverlayDismiss } from '../hooks'

const STEPS = ['位置', '作品', '确认']

function formatBytes(bytes: number): string {
  if (!bytes) return '未知'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(0)} GB 可用` : `${(bytes / 1024 ** 2).toFixed(0)} MB 可用`
}

export function NewProjectDialog(): React.JSX.Element | null {
  const open = useApp((state) => state.newProjectOpen)
  const setOpen = useApp((state) => state.setNewProjectOpen)
  const createProject = useApp((state) => state.createProject)
  const busy = useApp((state) => state.busy)
  const toast = useApp((state) => state.toast)

  const [step, setStep] = useState(0)
  const [parentDir, setParentDir] = useState('')
  const [folderName, setFolderName] = useState('')
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState('悬疑')
  const [targetPreset, setTargetPreset] = useState<'100000' | '300000' | 'none' | 'custom'>('100000')
  const [customTarget, setCustomTarget] = useState('150000')
  const [pov, setPov] = useState<'first' | 'third_limited' | 'third_omniscient'>('third_limited')
  const [boundaries, setBoundaries] = useState('')
  const [check, setCheck] = useState<PathCheck | null>(null)
  const [localErrors, setLocalErrors] = useState<string[]>([])

  const close = (): void => setOpen(false)
  const overlayRef = useOverlayDismiss(open, close)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setCheck(null)
    setLocalErrors([])
    setFolderName('')
    setTitle('')
    setBoundaries('')
  }, [open])

  if (!open) return null

  const pickParent = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) return
    const result = await bridge.dialog.pickDirectory()
    if (!result.ok) {
      toast({ tone: 'error', title: result.error.message })
      return
    }
    if (result.data.path) setParentDir(result.data.path)
  }

  const validatePath = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) return
    setLocalErrors([])
    if (!parentDir) {
      setLocalErrors(['请选择父目录'])
      return
    }
    if (!folderName.trim()) {
      setLocalErrors(['请填写文件夹名'])
      return
    }
    const result = await bridge.project.validatePath({ parentDir, folderName })
    if (!result.ok) {
      setLocalErrors([result.error.message])
      return
    }
    setCheck(result.data)
    if (result.data.ok) {
      setStep(1)
      if (!title.trim()) setTitle(folderName.trim())
    }
  }

  const targetWords = (): number | null => {
    if (targetPreset === 'none') return null
    if (targetPreset === 'custom') return Number.parseInt(customTarget, 10) || null
    return Number.parseInt(targetPreset, 10)
  }

  const submit = async (): Promise<void> => {
    const errors: string[] = []
    if (!check?.ok) errors.push('位置未通过校验')
    if (!title.trim()) errors.push('作品名不能为空')
    const target = targetWords()
    if (targetPreset === 'custom' && (target === null || target < 10_000)) {
      errors.push('自定义篇幅至少 1 万字')
    }
    if (errors.length > 0) {
      setLocalErrors(errors)
      return
    }
    const created = await createProject({
      parentDir,
      folderName: folderName.trim(),
      title: title.trim(),
      genre: genre.trim(),
      targetWords: target,
      pov,
      boundaries: boundaries.trim()
    })
    if (created) setOpen(false)
  }

  return (
    <div className="overlay" ref={overlayRef}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" data-testid="new-project-dialog">
        <header className="dialog__header">
          <h2 id="new-project-title">新建项目</h2>
          <p>G0 · 作者确认位置与作品信息；创建失败只回滚本次目录。</p>
        </header>
        <div className="dialog__body">
          <div className="steps-indicator">
            {STEPS.map((label, index) => (
              <span key={label} style={{ display: 'contents' }}>
                <span className={step === index ? 'on' : ''}>
                  {index + 1} {label}
                </span>
                {index < STEPS.length - 1 ? <span className="sep" /> : null}
              </span>
            ))}
          </div>

          {step === 0 ? (
            <>
              <div className="field">
                <label htmlFor="parent-dir">父目录</label>
                <div className="field__row">
                  <input
                    id="parent-dir"
                    type="text"
                    value={parentDir}
                    placeholder="例如 E:\\写作"
                    data-testid="input-parent-dir"
                    onChange={(event) => setParentDir(event.target.value)}
                  />
                  <button type="button" className="button" onClick={() => void pickParent()} data-testid="btn-pick-parent">
                    选择…
                  </button>
                </div>
              </div>
              <div className="field">
                <label htmlFor="folder-name">文件夹名</label>
                <input
                  id="folder-name"
                  type="text"
                  value={folderName}
                  placeholder="例如 黑漆匣子"
                  data-testid="input-folder-name"
                  onChange={(event) => setFolderName(event.target.value)}
                />
              </div>
              {localErrors.length > 0 ? (
                <ul className="check-list check-errors" data-testid="path-errors">
                  {localErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              ) : null}
              {check ? (
                <>
                  <div className="mono muted" style={{ marginBottom: 8 }}>
                    {check.targetPath} · {formatBytes(check.freeBytes)}
                  </div>
                  {check.errors.length > 0 ? (
                    <ul className="check-list check-errors">
                      {check.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : null}
                  {check.warnings.length > 0 ? (
                    <ul className="check-list check-warnings">
                      {check.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  {check.ok && check.warnings.length === 0 ? (
                    <ul className="check-list">
                      <li>目录可用，将创建 noryth.db 与五个子目录</li>
                    </ul>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="field">
                <label htmlFor="project-title">作品名</label>
                <input
                  id="project-title"
                  type="text"
                  value={title}
                  data-testid="input-title"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="project-genre">题材</label>
                <input id="project-genre" type="text" value={genre} onChange={(event) => setGenre(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="project-target">目标篇幅</label>
                <select
                  id="project-target"
                  value={targetPreset}
                  data-testid="select-target"
                  onChange={(event) => setTargetPreset(event.target.value as typeof targetPreset)}
                >
                  <option value="100000">10 万字</option>
                  <option value="300000">30 万字</option>
                  <option value="custom">自定义</option>
                  <option value="none">不设目标</option>
                </select>
              </div>
              {targetPreset === 'custom' ? (
                <div className="field">
                  <label htmlFor="project-target-custom">自定义字数</label>
                  <input
                    id="project-target-custom"
                    type="text"
                    value={customTarget}
                    onChange={(event) => setCustomTarget(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="project-pov">视角</label>
                <select
                  id="project-pov"
                  value={pov}
                  data-testid="select-pov"
                  onChange={(event) => setPov(event.target.value as typeof pov)}
                >
                  <option value="third_limited">第三人称限知</option>
                  <option value="first">第一人称</option>
                  <option value="third_omniscient">第三人称全知</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="project-boundaries">内容边界（可选）</label>
                <textarea
                  id="project-boundaries"
                  value={boundaries}
                  placeholder="例如：不写现实中的真实人物；暴力不直写。"
                  onChange={(event) => setBoundaries(event.target.value)}
                />
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                将在下列位置创建项目。路径不可用时可以返回上一步修改；创建失败只清理本次新建的空目录。
              </p>
              <div className="mono" style={{ marginBottom: 10 }}>
                {check?.targetPath}
              </div>
              <ul className="check-list">
                <li>noryth.db（SQLite WAL，schema v1）</li>
                <li>manuscript/ · assets/ · exports/ · backups/ · logs/</li>
                <li>project 行 + gate_record G0（作者、时间、字段快照）</li>
              </ul>
              <div className="kv">
                <span>作品名</span>
                <b>{title || '（未填）'}</b>
              </div>
              <div className="kv">
                <span>目标篇幅</span>
                <b>{targetWords() ? `${targetWords()?.toLocaleString('zh-CN')} 字` : '不设目标'}</b>
              </div>
              {localErrors.length > 0 ? (
                <ul className="check-list check-errors">
                  {localErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="dialog__footer">
          <button type="button" className="button button--ghost" onClick={close}>
            取消
          </button>
          <span className="spacer" />
          {step > 0 ? (
            <button type="button" className="button" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          {step === 0 ? (
            <button type="button" className="button button--primary" onClick={() => void validatePath()} data-testid="btn-next">
              下一步
            </button>
          ) : null}
          {step === 1 ? (
            <button
              type="button"
              className="button button--primary"
              data-testid="btn-preview"
              onClick={() => {
                setLocalErrors([])
                setStep(2)
              }}
            >
              下一步
            </button>
          ) : null}
          {step === 2 ? (
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void submit()}
              data-testid="btn-create"
            >
              {busy ? '创建中…' : '创建项目'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  )
}
