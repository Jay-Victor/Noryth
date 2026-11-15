import type { Appearance } from '../../shared/schema/settings'

/**
 * 外观应用（PHASE-10 I4 / UI-DESIGN §8.3）。
 *
 * 唯一实现：把偏好写到 <html> 的 data-* 与 CSS 变量上。
 * 组件不读偏好、不各自算主题；导出走主进程，不受这里影响。
 */

export function resolveTheme(theme: Appearance['theme']): 'light' | 'dark' {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyAppearance(appearance: Appearance): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = resolveTheme(appearance.theme)
  root.dataset.accent = appearance.accent
  root.dataset.prose = appearance.fontScale
  root.style.setProperty('--prose-leading', String(appearance.lineHeight))
}

/** system 主题要跟随系统切换；返回取消订阅函数。 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = (): void => onChange()
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
