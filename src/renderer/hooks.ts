import { useEffect, useRef, useState, type RefObject } from 'react'
import { modeForWidth, type LayoutMode } from '../shared/layout/grid'

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => modeForWidth(window.innerWidth))
  useEffect(() => {
    const onResize = (): void => setMode(modeForWidth(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return mode
}

/** 焦点陷阱：Tab 在对话框内循环，打开时聚焦第一个可交互元素。 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const focusable = (): HTMLElement[] =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )

    focusable()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          items[items.length - 1]?.focus()
        }
      } else if (index === items.length - 1) {
        event.preventDefault()
        items[0]?.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => node.removeEventListener('keydown', onKeyDown)
  }, [active, ref])
}

/** Esc 关闭 + 焦点回到触发元素。 */
export function useOverlayDismiss(open: boolean, onClose: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  const previous = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previous.current = document.activeElement as HTMLElement | null
    } else if (previous.current) {
      previous.current.focus()
      previous.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useFocusTrap(ref, open)
  return ref
}
