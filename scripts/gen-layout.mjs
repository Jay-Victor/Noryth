import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
const output = process.argv[3]
if (!input) {
  console.error('用法: node scripts/gen-layout.mjs <check_ui_spec --emit-json 输出文件> [输出 TS 路径]')
  process.exit(1)
}

const spec = JSON.parse(readFileSync(resolve(input), 'utf8'))

function entry(mode) {
  const value = spec.modes[mode]
  return `  ${mode}: { sessions: ${value.sessions}, tree: ${value.tree}, treeMode: '${value.treeMode}', ratio: ${value.ratio} }`
}

const content = `// 由 docs/scripts/check_ui_spec.py --emit-json 生成，不要手改。
// 重新生成：pnpm gen:layout

export const SHELL = {
  nav: ${spec.nav},
  divider: ${spec.divider},
  titleBar: ${spec.titleBar},
  statusBar: ${spec.statusBar}
} as const

export const BREAKPOINTS = {
  W1: ${spec.breakpoints.W1},
  W2: ${spec.breakpoints.W2},
  W3: ${spec.breakpoints.W3}
} as const

export const GRID = {
${entry('W1')},
${entry('W2')},
${entry('W3')}
} as const

export const PROSE = {
  fontSize: ${spec.prose.fontSize},
  pad: ${spec.prose.pad},
  maxColumn: ${spec.prose.maxColumn},
  minChars: ${spec.prose.minChars},
  maxChars: ${spec.prose.maxChars}
} as const

export const PANE_MIN = {
  chat: ${spec.chatMin},
  preview: ${spec.previewMin}
} as const

export type LayoutMode = keyof typeof GRID
`

const target = output ? resolve(output) : resolve(root, 'src/shared/layout/grid.generated.ts')
writeFileSync(target, content, 'utf8')
console.log(`gen-layout: ${target}`)
