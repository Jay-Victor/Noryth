import { useEffect } from 'react'
import { useApp, type Toast } from '../stores/app'

function ToastItem({ toast }: { toast: Toast }): React.JSX.Element {
  const dismiss = useApp((state) => state.dismissToast)
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), 4200)
    return () => window.clearTimeout(timer)
  }, [dismiss, toast.id])

  return (
    <button type="button" className={`toast is-${toast.tone}`} onClick={() => dismiss(toast.id)}>
      <strong>{toast.title}</strong>
      {toast.detail ? <span>{toast.detail}</span> : null}
    </button>
  )
}

export function Toasts(): React.JSX.Element {
  const toasts = useApp((state) => state.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
