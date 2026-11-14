import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import type { Repos } from '../../src/main/db/repos'
import type { DraftScene } from '../../src/shared/schema/storyboard'
import { confirmG2 } from '../../src/main/scheduler/g2'
import { saveStoryboardDraft } from '../../src/main/scheduler/storyboard'
import { openTestDb, type TestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'

/**
 * 创作台的测试世界：G1 完成 + 一章 + 分镜 + G2 物化。
 *
 * 与切片世界不同：这里走 F1 的真实路径（草案 → G2 → scene/beat），
 * 所以调度器测试不需要手工插 scene/beat。
 */

export interface WriteTestWorld {
  dir: string
  handle: TestDb
  repos: Repos
  projectId: string
  chapterId: string
  characterIds: string[]
  sceneIds: string[]
  beatIds: string[]
  cleanup: () => void
}

export interface WriteWorldOptions {
  sceneCount?: number
  beatsPerScene?: number
  budgetTokens?: number | null
  /** 把场景出口改成这个 DSL；默认 all(fact("black_box","location"), beats(2))。 */
  exit?: string
}

function buildScenes(options: WriteWorldOptions, characterIds: string[]): DraftScene[] {
  const sceneCount = options.sceneCount ?? 2
  const beatsPerScene = options.beatsPerScene ?? 2
  const exit = options.exit ?? 'all(fact("black_box","location"), beats(2))'
  return Array.from({ length: sceneCount }, (_, sceneIndex) => ({
    location: `地点 ${sceneIndex + 1}`,
    participants: characterIds,
    goal: `第 ${sceneIndex + 1} 场目标`,
    entry: '',
    exit,
    max_beats: Math.max(beatsPerScene, 4),
    beats: Array.from({ length: beatsPerScene }, (_, beatIndex) => {
      const isNarrator = beatIndex % 2 === 1
      return {
        speaker_type: isNarrator ? ('narrator' as const) : ('character' as const),
        speaker_id: isNarrator ? 'narrator' : characterIds[0]!,
        intent: `s${sceneIndex + 1}-b${beatIndex + 1} 的意图`,
        max_words: 200
      }
    })
  }))
}

export function openWriteWorld(options: WriteWorldOptions = {}): WriteTestWorld {
  const temp = tempDir('noryth-write-')
  const handle = openTestDb(temp.path)
  const repos = handle.repos
  const project = repos.project.create({
    title: '黑漆匣子 · 创作台',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 100_000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  repos.project.setSetupState(project.id, 'complete')
  repos.project.lockBlueprint(project.id)

  const characters = [
    { id: 'chr_lin', name: '沈昼' },
    { id: 'chr_yan', name: '沈砚' }
  ]
  for (const character of characters) {
    repos.character.insert({ id: character.id, projectId: project.id, name: character.name, cardJson: '{}' })
  }

  const root = repos.outline.insert({
    id: 'out_write_main',
    projectId: project.id,
    parentId: null,
    kind: 'main',
    ord: 0,
    title: '主线',
    content: '账本与匣子',
    status: 'approved'
  })
  const node = repos.outline.insert({
    id: 'out_write_ch_01',
    projectId: project.id,
    parentId: root.id,
    kind: 'chapter',
    ord: 1,
    title: '祠堂夜谈',
    content: '沈昼第一次听见匣子',
    status: 'approved'
  })

  const chapter = repos.chapter.insert({
    id: 'ch_write_01',
    projectId: project.id,
    outlineNodeId: node.id,
    ord: 1,
    status: 'planned'
  })
  if (options.budgetTokens !== undefined) repos.chapter.setBudgetTokens(chapter.id, options.budgetTokens)

  repos.world.insert({
    id: 'fact_box_location',
    projectId: project.id,
    subject: 'black_box',
    predicate: 'location',
    object: '祠堂供桌下面',
    truth: 'objective',
    visibility: 'public',
    validFromSeq: 0,
    sourceType: 'author'
  })

  const scenes = buildScenes(options, characters.map((character) => character.id))
  saveStoryboardDraft(repos, { chapterId: chapter.id, scenes, updatedBy: 'author' })
  confirmG2(handle.db, repos, { chapterId: chapter.id, actor: 'author' })

  const sceneIds = repos.scene.listByChapter(chapter.id).map((entry) => entry.scene.id)
  const beatIds = repos.beat.listLiveByChapter(chapter.id).map((beat) => beat.id)

  return {
    dir: temp.path,
    handle,
    repos,
    projectId: project.id,
    chapterId: chapter.id,
    characterIds: characters.map((character) => character.id),
    sceneIds,
    beatIds,
    cleanup: () => {
      handle.db.close()
      temp.cleanup()
    }
  }
}
