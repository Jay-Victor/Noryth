import { useEffect, useRef, useState } from 'react'

/**
 * 800ms 自动保存字段（PHASE-06 E2）。
 *
 * 输入 → 800ms 去抖 → 保存；失焦立即保存。保存状态由父级统一显示。
 * G1 后 disabled，而不是静默丢弃输入。
 */

export interface FieldEditorProps {
  label: string
  value: string
  multiline?: boolean
  rows?: number
  disabled?: boolean
  required?: boolean
  placeholder?: string
  testId?: string
  hint?: string
  onSave: (value: string) => Promise<void> | void
}

export function FieldEditor({
  label,
  value,
  multiline = false,
  rows = 4,
  disabled = false,
  required = false,
  placeholder,
  testId,
  hint,
  onSave
}: FieldEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const timer = useRef<number | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!dirty) setDraft(value)
  }, [value, dirty])

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const flush = (next: string): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setDirty(false)
    void saveRef.current(next)
  }

  const schedule = (next: string): void => {
    setDraft(next)
    setDirty(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      if (next !== valueRef.current) {
        setDirty(false)
        void saveRef.current(next)
      } else {
        setDirty(false)
      }
    }, 800)
  }

  const common = {
    value: draft,
    disabled,
    placeholder,
    'data-testid': testId,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => schedule(event.target.value),
    onBlur: () => {
      if (dirty && draft !== value) flush(draft)
    }
  }

  return (
    <label className={`plan-field${disabled ? ' is-disabled' : ''}`}>
      <span className="plan-field__label">
        {label}
        {required ? <em className="plan-field__required">必填</em> : null}
        {hint ? <span className="plan-field__hint">{hint}</span> : null}
      </span>
      {multiline ? <textarea rows={rows} {...common} /> : <input type="text" {...common} />}
    </label>
  )
}
