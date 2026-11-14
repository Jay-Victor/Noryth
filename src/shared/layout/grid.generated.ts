// 由 docs/scripts/check_ui_spec.py --emit-json 生成，不要手改。
// 重新生成：pnpm gen:layout

export const SHELL = {
  nav: 56,
  divider: 1,
  titleBar: 40,
  statusBar: 24
} as const

export const BREAKPOINTS = {
  W1: 1600,
  W2: 1360,
  W3: 1280
} as const

export const GRID = {
  W1: { sessions: 248, tree: 224, treeMode: 'pane', ratio: 1.2 },
  W2: { sessions: 248, tree: 44, treeMode: 'rail', ratio: 1.2 },
  W3: { sessions: 64, tree: 44, treeMode: 'rail', ratio: 1.2 }
} as const

export const PROSE = {
  fontSize: 15,
  pad: 64,
  maxColumn: 630,
  minChars: 32,
  maxChars: 42
} as const

export const PANE_MIN = {
  chat: 420,
  preview: 520
} as const

export type LayoutMode = keyof typeof GRID
