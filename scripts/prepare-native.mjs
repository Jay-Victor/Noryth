// 把 sqlite-vec 的 loadable extension 复制到 resources/native，打包后从 resourcesPath 解析。
// 不依赖 node_modules 的 asar 布局，避免 pnpm 符号链接带来的打包差异。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'native')
const dest = join(destDir, 'vec0.dll')

function candidates() {
  const out = []
  out.push(join(root, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'))
  const store = join(root, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (entry.startsWith('sqlite-vec-windows-x64@')) {
        out.push(join(store, entry, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'))
      }
    }
  }
  return out
}

const source = candidates().find((candidate) => existsSync(candidate))
if (!source) {
  console.error('prepare-native: 找不到 sqlite-vec 的 vec0.dll，请先 pnpm install')
  process.exit(1)
}
mkdirSync(destDir, { recursive: true })
copyFileSync(source, dest)
const bytes = statSync(dest).size
console.log(`prepare-native: ${source} -> ${dest} (${bytes} bytes)`)
