import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import type { Repos } from '../../src/main/db/repos'
import { emptyCharacterCard, type CharacterCard } from '../../src/shared/schema/plan'
import { openTestDb, type TestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'

/** 单元/集成测试用的规划世界：真实 SQLite + 空项目（可按需加蓝图/角色/初值）。 */
export interface PlanTestWorld {
  dir: string
  handle: TestDb
  repos: Repos
  projectId: string
  cleanup: () => void
}

export function openPlanWorld(prefix = 'noryth-plan-'): PlanTestWorld {
  const temp = tempDir(prefix)
  const handle = openTestDb(temp.path)
  const project = handle.repos.project.create({
    title: '黑漆匣子',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 120_000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  return {
    dir: temp.path,
    handle,
    repos: handle.repos,
    projectId: project.id,
    cleanup: () => {
      handle.db.close()
      temp.cleanup()
    }
  }
}

export function fullCard(patch: Partial<CharacterCard> = {}): CharacterCard {
  return {
    ...emptyCharacterCard(),
    identity: '替人写遗书的年轻女子',
    appearance: '灰蓝旗袍，袖口有墨迹',
    voice: {
      sentence_length: '短句',
      catchphrase: '「我只问一句。」',
      address_habit: '称长辈「您」',
      banned_words: '「命运」'
    },
    want: '查清父亲的死因',
    fear: '发现自己也是共犯',
    taboo: '不在祠堂提母亲',
    initial_relationships: '沈砚是她唯一愿意求助的长辈',
    initial_known: '父亲留下账本',
    initial_unknown: '匣子的第三把钥匙在谁手里',
    ...patch
  }
}

export function seedBlueprint(world: PlanTestWorld): { mainId: string; volumeId: string; chapterId: string } {
  const main = world.repos.outline.insert({
    projectId: world.projectId,
    parentId: null,
    kind: 'main',
    ord: 0,
    title: '主线：黑漆匣子',
    content: '一封遗书牵出账本。'
  })
  const volume = world.repos.outline.insert({
    projectId: world.projectId,
    parentId: main.id,
    kind: 'volume',
    ord: 0,
    title: '第一卷 · 黑漆匣子',
    content: '沈昼开始查账。'
  })
  const chapter = world.repos.outline.insert({
    projectId: world.projectId,
    parentId: volume.id,
    kind: 'chapter',
    ord: 0,
    title: '第一章 祠堂夜谈',
    content: '雨夜试探沈砚。'
  })
  return { mainId: main.id, volumeId: volume.id, chapterId: chapter.id }
}

export function seedCharacters(world: PlanTestWorld, names: string[]): string[] {
  return names.map((name, index) =>
    world.repos.planCharacter.insert({
      projectId: world.projectId,
      name,
      cardJson: JSON.stringify(fullCard()),
      ord: index + 1
    }).id
  )
}
