// 把 check_ui_spec.py 的布局算术落到 TS：数字只来自 grid.generated.ts。
import { BREAKPOINTS, GRID, PROSE, SHELL, type LayoutMode } from './grid.generated'

export type { LayoutMode }
export { BREAKPOINTS, GRID, PROSE, SHELL }

export const LAYOUT_MODES: LayoutMode[] = ['W3', 'W2', 'W1']

export function modeForWidth(width: number): LayoutMode {
  if (width >= BREAKPOINTS.W1) return 'W1'
  if (width >= BREAKPOINTS.W2) return 'W2'
  // 窗口最小 1280；更窄时保持 W3，不引入第四种布局
  return 'W3'
}

export function fixedWidth(mode: LayoutMode): number {
  return SHELL.nav + GRID[mode].sessions + GRID[mode].tree + 3 * SHELL.divider
}

export function freeWidth(viewport: number, mode: LayoutMode): number {
  return viewport - fixedWidth(mode)
}

export function chatWidth(viewport: number, mode: LayoutMode): number {
  const free = freeWidth(viewport, mode)
  return free / (1 + GRID[mode].ratio)
}

export function previewWidth(viewport: number, mode: LayoutMode): number {
  return freeWidth(viewport, mode) - chatWidth(viewport, mode)
}

export function columnWidth(preview: number): number {
  return Math.min(Math.max(preview - PROSE.pad, 0), PROSE.maxColumn)
}

export function gridTemplateColumns(mode: LayoutMode): string {
  const { sessions, tree, ratio } = GRID[mode]
  return `${SHELL.nav}px ${sessions}px minmax(0, 1fr) minmax(0, ${ratio}fr) ${tree}px`
}
