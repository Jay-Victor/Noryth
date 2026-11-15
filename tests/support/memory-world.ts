import { MemoryService } from '../../src/main/memory/service'
import { createHashEmbedder } from '../../src/main/memory/embed/hash'
import type { Embedder } from '../../src/main/memory/embed/types'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { SettingsSchema } from '../../src/shared/schema/project'
import type { MemoryEvent, MemoryState } from '../../src/shared/schema/memory'
import { openTestDb, type TestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'

/**
 * 记忆台的测试世界：空项目 + MemoryService（哈希嵌入 + 假模型）。
 *
 * `devSeed` 走真实原语：G2 物化 → commitBeat 6 拍 → markChapterComplete →
 * G6 定稿 → memory.extract 入队；第 2 章只规划（用于跨章召回）。
 * 只有模型与嵌入是假的，其余与生产一致。
 */

export interface MemoryTestWorld {
  dir: string
  handle: TestDb
  projectId: string
  chapterId: string
  secondChapterId: string
  characterIds: string[]
  service: MemoryService
  events: MemoryEvent[]
  state: () => MemoryState
  cleanup: () => void
}

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
export const MEMORY_GATE_SECRET = 'integration-memory-gate'

export function openMemoryWorld(
  options: { env?: NodeJS.ProcessEnv; embedder?: Embedder } = {}
): MemoryTestWorld {
  const temp = tempDir('noryth-memory-')
  const handle = openTestDb(temp.path)
  const project = handle.repos.project.create({
    title: '黑漆匣子 · 记忆台',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 100_000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })

  const events: MemoryEvent[] = []
  const service = new MemoryService({
    host: () => ({ dir: temp.path, db: handle.db, repos: handle.repos, readOnly: false }),
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    gateSecret: MEMORY_GATE_SECRET,
    send: (event) => events.push(event),
    embedder: options.embedder ?? createHashEmbedder(),
    fakeChunkDelayMs: 0,
    env: options.env ?? { NORYTH_MEMORY_FAKE: '1' }
  })

  const seeded = service.devSeed({ beatsPerScene: 6, extraChapters: 1 })
  const chapters = handle.repos.chapter.listByProject(project.id)
  const cleanup = (): void => {
    handle.db.close()
    temp.cleanup()
  }
  const chapterId = seeded.chapterId
  if (chapterId === null || chapters.length < 2) {
    cleanup()
    throw new Error('memory devSeed 没有生成两章')
  }
  return {
    dir: temp.path,
    handle,
    projectId: project.id,
    chapterId,
    secondChapterId: chapters.find((chapter) => chapter.id !== chapterId)!.id,
    characterIds: handle.repos.character.list(project.id).map((character) => character.id),
    service,
    events,
    state: () => service.state(chapterId),
    cleanup
  }
}
