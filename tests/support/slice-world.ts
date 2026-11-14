import { openTestDb, type TestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'
import fixtureJson from '../fixtures/slice/project.json'
import { parseSliceFixture } from '../../src/main/slice/fixture'
import { seedSlice } from '../../src/main/slice/seed'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import type { Repos } from '../../src/main/db/repos'

/** 单元/集成测试用的切片世界：真实 SQLite + 1 章 1 场 2 拍 5 角色。 */
export interface SliceTestWorld {
  dir: string
  handle: TestDb
  repos: Repos
  projectId: string
  chapterId: string
  sceneId: string
  beatIds: string[]
  cleanup: () => void
}

export const sliceFixture = parseSliceFixture(fixtureJson)

export function openSliceWorld(prefix = 'noryth-slice-'): SliceTestWorld {
  const temp = tempDir(prefix)
  const handle = openTestDb(temp.path)
  const project = handle.repos.project.create({
    title: sliceFixture.project.title,
    genre: sliceFixture.project.genre,
    pov: sliceFixture.project.pov,
    targetWords: sliceFixture.project.targetWords,
    embeddingModel: sliceFixture.project.embeddingModel,
    embeddingDim: sliceFixture.project.embeddingDim,
    defaultPreset: sliceFixture.project.defaultPreset,
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  const seeded = seedSlice(handle.db, handle.repos, sliceFixture)
  return {
    dir: temp.path,
    handle,
    repos: handle.repos,
    projectId: project.id,
    chapterId: seeded.chapterId,
    sceneId: seeded.sceneId,
    beatIds: seeded.beatIds,
    cleanup: () => {
      handle.db.close()
      temp.cleanup()
    }
  }
}
