// 由 src/main/tools/tool-catalog.json 生成 docs/tools/*.json（阶段 1 只含契约外壳）。
// 阶段 3 的 C5 补齐 input_schema / output_schema 并把 contract_complete 置 true。
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(root, 'src/main/tools/tool-catalog.json'), 'utf8'))

const DEFAULTS = {
  structure: { timeout_ms: 800, max_result_tokens: 2000, max_calls_per_turn: 2 },
  knowledge: { timeout_ms: 800, max_result_tokens: 2000, max_calls_per_turn: 2 },
  verify: { timeout_ms: 2000, max_result_tokens: 3000, max_calls_per_turn: 2 },
  propose: { timeout_ms: 5000, max_result_tokens: 2000, max_calls_per_turn: 1 },
  interaction: { timeout_ms: 10000, max_result_tokens: 1000, max_calls_per_turn: 1 }
}

const DEGRADE = {
  structure: ['full', 'summary', 'empty'],
  knowledge: ['full', 'summary', 'facts_only', 'empty'],
  verify: ['full', 'summary'],
  propose: ['full', 'summary', 'fail'],
  interaction: ['full', 'fail']
}

function toManifest(entry, system = false) {
  const base = DEFAULTS[entry.family] ?? DEFAULTS.structure
  const limits = { ...base, ...(entry.limits ?? {}) }
  return {
    name: entry.name,
    version: entry.version,
    family: entry.family,
    summary: entry.summary,
    actors: entry.actors,
    side_effect: entry.sideEffect,
    agent_callable: entry.agentCallable,
    requires_gate: entry.requiresGate,
    idempotency: entry.idempotency,
    injected: [],
    limits: {
      timeout_ms: entry.limits?.timeoutMs ?? limits.timeout_ms,
      max_result_tokens: limits.max_result_tokens,
      max_calls_per_turn: limits.max_calls_per_turn
    },
    degrade: DEGRADE[entry.family] ?? DEGRADE.structure,
    audit: {
      log_args: entry.sideEffect === 'none' ? 'hash' : 'full',
      log_result_ids: true
    },
    input_schema: null,
    output_schema: null,
    contract_complete: false,
    milestone: entry.milestone,
    m0: entry.m0,
    tool_id: entry.id,
    ...(system ? { system: true } : {})
  }
}

export function buildArtifacts() {
  const files = new Map()
  files.set('_index.json', JSON.stringify({
    generated_by: 'scripts/gen-tools.mjs',
    phase: 1,
    contract_complete: false,
    tool_count: catalog.tools.length,
    system_count: catalog.system.length,
    m0_tool_count: catalog.tools.filter((tool) => tool.m0).length,
    allowlist: Object.fromEntries(
      ['planner', 'orchestrator', 'character', 'narrator', 'reviewer', 'memory'].map((agent) => [
        agent,
        catalog.tools.filter((tool) => tool.m0 && tool.actors.includes(agent)).map((tool) => tool.name).sort()
      ])
    )
  }, null, 2) + '\n')

  for (const entry of catalog.tools) {
    files.set(`${entry.name}.json`, JSON.stringify(toManifest(entry, false), null, 2) + '\n')
  }
  for (const entry of catalog.system) {
    files.set(`${entry.name}.json`, JSON.stringify(toManifest(entry, true), null, 2) + '\n')
  }
  return files
}

export function writeArtifacts(targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const artifacts = buildArtifacts()
  for (const name of readdirSync(targetDir)) {
    if (name.endsWith('.json')) rmSync(join(targetDir, name))
  }
  for (const [name, content] of artifacts) {
    writeFileSync(join(targetDir, name), content, 'utf8')
  }
  return artifacts.size
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = writeArtifacts(join(root, 'docs/tools'))
  console.log(`gen-tools: ${count} files -> docs/tools`)
}
