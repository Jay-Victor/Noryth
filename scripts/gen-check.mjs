// 生成物一致性硬门：重新生成到临时目录，与仓库内容逐字节比较。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArtifacts } from './gen-tools.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function compareTools(committedDir, artifacts) {
  const committed = existsSync(committedDir) ? readdirSync(committedDir).filter((n) => n.endsWith('.json')) : []
  for (const name of artifacts.keys()) {
    if (!committed.includes(name)) {
      problems.push(`缺少生成物 docs/tools/${name}`)
      continue
    }
    const actual = readFileSync(join(committedDir, name), 'utf8')
    if (actual !== artifacts.get(name)) problems.push(`生成物不一致 docs/tools/${name}`)
  }
  for (const name of committed) {
    if (!artifacts.has(name)) problems.push(`多余生成物 docs/tools/${name}`)
  }
}

// 1) 工具清单
compareTools(join(root, 'docs/tools'), buildArtifacts())

// 2) 栅格 token：python --emit-json -> gen-layout（输出到临时文件，绝不改仓库）
const scratch = mkdtempSync(join(tmpdir(), 'noryth-gencheck-'))
try {
  const jsonPath = join(scratch, 'layout.json')
  const tsPath = join(scratch, 'grid.generated.ts')
  const out = execFileSync('python', ['docs/scripts/check_ui_spec.py', '--emit-json'], {
    cwd: root,
    encoding: 'utf8'
  })
  writeFileSync(jsonPath, out, 'utf8')
  execFileSync(process.execPath, ['scripts/gen-layout.mjs', jsonPath, tsPath], { cwd: root, stdio: 'pipe' })
  const generated = readFileSync(tsPath, 'utf8')
  const committed = readFileSync(join(root, 'src/shared/layout/grid.generated.ts'), 'utf8')
  if (generated !== committed) problems.push('src/shared/layout/grid.generated.ts 与脚本生成结果不一致')
} catch (error) {
  problems.push(`布局生成失败: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('gen:check 失败')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`gen:check 通过：${buildArtifacts().size} 个工具清单 + grid.generated.ts`)
