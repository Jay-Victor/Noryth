import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import type { Repos } from '../../src/main/db/repos'
import { registerRoster } from '../../src/main/agents/roster'
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

/** G1 之后的项目形状（PHASE-15 影响分析/变更流程的测试夹具）。 */
export interface PostG1World {
  mainId: string
  volumeId: string
  chapter1NodeId: string
  chapter1Id: string
  chapter2NodeId: string
  chapter2Id: string
  characterId: string
  otherCharacterId: string
  memoryOnChapter1: string
  edgeOnMemory: string
}

/**
 * 造一个「已 G1 + 两章 + 一条记忆 + 一条关系边」的项目。
 * - 第 1 章有一个场景与一拍（发言人 = characterId）；
 * - 记忆来源 = 第 1 章；关系边来源 = 该记忆（source_type=memory）。
 */
export function seedPostG1(world: PlanTestWorld): PostG1World {
  const seeded = seedBlueprint(world)
  const characterIds = seedCharacters(world, ['沈昼', '沈砚'])
  const characterId = characterIds[0]!
  const otherCharacterId = characterIds[1]!
  const chapter2Node = world.repos.outline.insert({
    projectId: world.projectId,
    parentId: seeded.volumeId,
    kind: 'chapter',
    ord: 1,
    title: '第二章 旧账'
  })
  world.repos.project.lockBlueprint(world.projectId)
  // 正式 character 行：记忆/关系边/拍的外键都指向它（G1 的 registerRoster 同一路径）。
  registerRoster(world.repos, world.projectId)

  const chapter1 = world.repos.chapter.insert({
    projectId: world.projectId,
    outlineNodeId: seeded.chapterId,
    ord: 1
  })
  const chapter2 = world.repos.chapter.insert({
    projectId: world.projectId,
    outlineNodeId: chapter2Node.id,
    ord: 2
  })

  const scene = world.repos.scene.insert({
    projectId: world.projectId,
    ord: 1,
    location: '沈家祠堂',
    participantsJson: JSON.stringify([characterId, otherCharacterId]),
    goal: '确认匣子的下落',
    entry: '雨夜',
    exitJson: JSON.stringify({ resolved: true, hook: null }),
    status: 'open'
  })
  world.repos.scene.linkToChapter(chapter1.id, scene.id, 1)
  const revision = world.repos.revision.insert({
    chapterId: chapter1.id,
    parentRevisionId: null,
    kind: 'draft',
    contentHash: 'hash_seed',
    createdBy: 'author'
  })
  world.repos.chapter.setCurrentRevision(chapter1.id, revision.id)
  world.repos.beat.insert({
    chapterId: chapter1.id,
    sceneId: scene.id,
    ord: 1,
    seq: 1,
    speakerType: 'character',
    speakerId: characterId,
    body: '「匣子在供桌下面。」',
    status: 'confirmed',
    createdRevisionId: revision.id
  })

  const memory = world.repos.memory.insert({
    projectId: world.projectId,
    characterId,
    kind: 'experience',
    text: '她在祠堂看见了黑漆匣子',
    learnedSeq: 1,
    sourceChapterId: chapter1.id,
    sourceRevisionId: revision.id,
    embeddingModel: 'hash-bigram-v1'
  })
  const edge = world.repos.relationship.insert({
    projectId: world.projectId,
    fromId: characterId,
    toId: otherCharacterId,
    axis: 'trust',
    value: 0.5,
    sinceSeq: 1,
    sourceType: 'memory',
    sourceId: memory.id
  })

  return {
    mainId: seeded.mainId,
    volumeId: seeded.volumeId,
    chapter1NodeId: seeded.chapterId,
    chapter1Id: chapter1.id,
    chapter2NodeId: chapter2Node.id,
    chapter2Id: chapter2.id,
    characterId,
    otherCharacterId,
    memoryOnChapter1: memory.id,
    edgeOnMemory: edge.id
  }
}
