import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectContext } from '../../src/main/context/sources'
import { assembleContext } from '../../src/main/context/assemble'
import { sha256Hex } from '../../src/main/crypto'
import { hashManifestRows, type ManifestRow } from '../../src/main/db/hash'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import type { Db } from '../../src/main/db/project-db'
import type { MemoryKind } from '../../src/main/db/repos/memory'
import { allocateSeq } from '../../src/main/db/seq'
import { withTransaction } from '../../src/main/db/tx'
import { verifyDatabase } from '../../src/main/db/verify'
import { exportManuscript } from '../../src/main/doc/export'
import { buildArchiveCandidates } from '../../src/main/memory/archive'
import { createHashEmbedder, hashEmbedding } from '../../src/main/memory/embed/hash'
import { invalidateRetrievalCache, retrieveOwn } from '../../src/main/memory/retrieve'
import { buildCostReport } from '../../src/main/report/cost'
import { queryTimeline } from '../../src/main/tools/support/timeline'
import { computeSceneVoice, resolveSceneVoice } from '../../src/main/voice/service'
import { VOICE_THRESHOLD } from '../../src/shared/domain/voice'
import { openTestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'

/**
 * PERF-M2-01（PHASE-23 §5 / M2-6）：10 万字项目的性能基线。
 *
 * 夹具口径：
 *   - 3 卷 × 10 章 = 30 章，每章 3 场 × 8 拍 = 24 拍，共 720 拍；
 *   - 每拍正文带「章-场-拍-角色」唯一前缀，按角色使用不同句长/口头禅/问句，
 *     避免全篇同文让 DOCX 压缩率与缓存命中虚高；
 *   - 5 个角色、3,000 条记忆（含 200 条重复经历与 200 条已归档）、
 *     3,000 条向量 + FTS、30 份章末摘要、30 章 × 3 场的声音指标、
 *     覆盖六个 Agent 的成本行、12 条伏笔（8 回收 / 4 未回收）。
 *
 * 夹具是纯函数计划（`buildPlan`）+ 显式 id：同一计划两次生成逐字段一致
 * （`fixtureDigest`），不依赖随机数与时钟。
 *
 * 目标（PHASE-23 §5.2）：打开 <800ms、切章 P95 <120ms、T23 <100ms、
 * 检索 P95 <80ms、装配 P95 <150ms、报表 P95 <200ms、声音 P95 <100ms、
 * 归档候选 P95 <200ms、MD <2s、DOCX <5s、RSS <600MB。
 *
 * 性能门只在 `pnpm test:perf` / nightly 跑；提交门不跑墙钟断言。
 */

const CHAPTER_COUNT = 30
const SCENES_PER_CHAPTER = 3
const BEATS_PER_SCENE = 8
const MEMORIES_PER_CHARACTER = 600
const FORESHADOW_COUNT = 12
const WARMUP = 3
const SAMPLES = 20
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const PROVIDER = 'deepseek'
const MODEL = 'deepseek-flash'
const EMBEDDING_MODEL = 'hash-bigram-v1'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

// ── 夹具计划（纯函数） ────────────────────────────────────────────────────────

interface CharacterPlan {
  id: string
  name: string
  catchphrase: string
  sentences: string[]
}

/**
 * 五个角色的句长/口头禅/问句率不同：声音两两区分度才有意义。
 * 句子按 4 句拼成 ~150 字，720 拍合计 >100,000 字。
 */
const CHARACTERS: readonly CharacterPlan[] = [
  {
    id: 'chr_m2_1',
    name: '沈昼',
    catchphrase: '茶凉了',
    sentences: [
      '茶凉了。她把茶盏往他那边推了推。',
      '雨落在祠堂的瓦上，檐下滴水一声接一声。',
      '她没有抬头，只把账本翻到最后一页。',
      '灯影在墙上晃，像有人在门外站着。',
      '院里的青石板被雨水洗得发亮。',
      '他听见她把窗闩轻轻扣上。',
      '风从门缝里钻进来，吹动案上的纸。',
      '她数着檐下的水滴，一下，两下，三下。'
    ]
  },
  {
    id: 'chr_m2_2',
    name: '陆停舟',
    catchphrase: '账要一笔一笔算',
    sentences: [
      '陆停舟把伞靠在门边，抖了抖袖口的水，才慢慢落座，像在等一个早已约好的时辰，又像只是路过避雨。',
      '他说话从来不急，一句一句铺开，把祠堂里的旧事、账房里的亏空、渡口上的风声都串在一起，听得人心里发沉。',
      '账要一笔一笔算，人也一样，欠下的总要还，只是早晚不同，利息不同，来的方式也不同。',
      '窗外的雨下得更密了，他抬眼看了一下檐角，又低下头去，把茶盏转了半圈，没有喝。',
      '他说起十年前那个冬天，语气平静得像在念一份与自己无关的旧账，可手指却一直按着桌沿。',
      '祠堂的灯油快尽了，火光一缩，他的影子在墙上忽然长了一截，又慢慢落回去。',
      '他把那页账推回来，指尖在「陆」字上停了一停，像是提醒，又像是在试探。',
      '门外有人咳了一声，他没有回头，只把话头收住，等着屋里另一个人先开口。'
    ]
  },
  {
    id: 'chr_m2_3',
    name: '秦五',
    catchphrase: '你信不信',
    sentences: [
      '你信不信？账本上那页纸，昨夜自己翻过去了。',
      '我就站在门口，看得清清楚楚，谁也没碰它。',
      '雨这么大，祠堂里还有灯，你说怪不怪？',
      '你信不信，渡口那条船，今早又空着回来了。',
      '我数过，账本少了一页，正好是记着名字的那页。',
      '别问我怎么知道的，我秦五在巷子里活了这么多年。',
      '你信不信，灯灭之前，一定有人从后门出去。',
      '要是你不信，今晚就跟我守在祠堂里，看它翻不翻。'
    ]
  },
  {
    id: 'chr_m2_4',
    name: '白露',
    catchphrase: '我记得',
    sentences: [
      '我记得那天的雨，也记得我把账本藏在祠堂的夹层里。',
      '我没有告诉任何人，连他也没有说，我怕说出来就再也收不回去。',
      '我记得灯灭的一瞬间，有人从我身后走过去，脚步很轻。',
      '我把手按在账本上，纸是凉的，可我的掌心全是汗。',
      '我记得他看我的眼神，像是在等我先承认什么。',
      '我没有哭，我只是把窗推开了一条缝，让雨声进来。',
      '我记得那页纸上的名字，可我宁愿自己记错了。',
      '我站在祠堂中央，听见自己的心跳比檐下的水滴还响。'
    ]
  },
  {
    id: 'chr_m2_5',
    name: '周砚',
    catchphrase: '照规矩办',
    sentences: [
      '周砚把账本合上，说照规矩办，先点灯，再验封，最后才看名字。',
      '他不看任何人的脸，只看桌上的物件，像这些东西比人更可信。',
      '照规矩办，祠堂的门只能从里面闩，外面的锁是给活人看的。',
      '雨声压着屋里的沉默，他把封条举到灯下，慢慢转了一圈。',
      '他说这话时没有提高声音，可屋里没有人再动。',
      '账房的钥匙一共两把，一把在他身上，另一把应该在祠堂。',
      '他把笔搁下，等墨迹干透，才把纸折好收进袖里。',
      '照规矩办，今夜谁也不能离开祠堂，天亮再说。'
    ]
  }
]

const NARRATOR_SENTENCES: readonly string[] = [
  '雨从午后就没有停过，祠堂的瓦沟里积着水，一滴一滴落在青石板上。',
  '屋里的灯芯短了一截，火苗贴着灯沿，把几个人的影子拉得很长。',
  '案上摊着账本，纸页被潮气浸得发软，边角卷起来，像被人反复翻过。',
  '门外的巷子很静，只有远处渡口的橹声，隔着雨传过来，闷闷的。',
  '谁也没有先开口，茶盏里的热气一点点散尽，最后连水面也平了。',
  '檐下的水滴越来越慢，像是在数屋里人的呼吸。',
  '风把门缝里的雨丝吹进来，落在账本上，洇开一小片深色。',
  '祠堂深处供着牌位，烛火照不到的地方，黑得像一口井。'
]

const MEMORY_PLACES: readonly string[] = ['祠堂', '渡口', '账房', '雨巷', '灯市']

interface PlanBeat {
  id: string
  ord: number
  speakerType: 'narrator' | 'character'
  speakerId: string
  body: string
}

interface PlanScene {
  id: string
  ord: number
  participants: string[]
  beats: PlanBeat[]
}

interface PlanChapter {
  id: string
  ord: number
  volumeOrd: number
  outlineNodeId: string
  revisionId: string
  scenes: PlanScene[]
}

interface PlanMemory {
  id: string
  characterId: string
  kind: MemoryKind
  text: string
  importance: number
  pinned: number
  learnedSeq: number
  chapterOrd: number
  /** 软归档（PHASE-22）：非空 = 检索默认排除。 */
  archived: boolean
}

interface PlanForeshadow {
  id: string
  text: string
  plantedChapterOrd: number
  plannedPayoffChapterOrd: number | null
  closed: boolean
}

interface FixturePlan {
  chapters: PlanChapter[]
  memories: PlanMemory[]
  foreshadows: PlanForeshadow[]
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function chapterIdOf(ord: number): string {
  return `ch_m2_${pad(ord)}`
}

function sceneIdOf(chapterOrd: number, sceneOrd: number): string {
  return `scn_m2_${pad(chapterOrd)}_${sceneOrd}`
}

function revisionIdOf(chapterOrd: number): string {
  return `rev_m2_${pad(chapterOrd)}`
}

function beatIdOf(chapterOrd: number, sceneOrd: number, beatOrd: number): string {
  return `bt_m2_${pad(chapterOrd)}_${sceneOrd}_${beatOrd}`
}

function speakerAt(chapterOrd: number, sceneOrd: number, beatOrd: number): {
  speakerType: 'narrator' | 'character'
  speakerId: string
  name: string
  sentences: readonly string[]
} {
  const participants = [0, 1, 2].map((offset) => (chapterOrd + sceneOrd + offset) % CHARACTERS.length)
  if (beatOrd === 1) {
    return { speakerType: 'narrator', speakerId: 'narrator', name: '旁白', sentences: NARRATOR_SENTENCES }
  }
  const character = CHARACTERS[participants[(beatOrd - 2) % participants.length]!]!
  return { speakerType: 'character', speakerId: character.id, name: character.name, sentences: character.sentences }
}

/** 6 句拼接：句序按章/场/拍轮转，保证每拍文本唯一且可读。 */
function bodyOf(chapterOrd: number, sceneOrd: number, beatOrd: number): string {
  const speaker = speakerAt(chapterOrd, sceneOrd, beatOrd)
  const lines: string[] = []
  for (let index = 0; index < 6; index += 1) {
    const pick = (chapterOrd * 3 + sceneOrd * 5 + beatOrd * 7 + index) % speaker.sentences.length
    lines.push(speaker.sentences[pick]!)
  }
  return `第${chapterOrd}章第${sceneOrd}场第${beatOrd}拍·${speaker.name}：${lines.join('')}`
}

function memoryTextOf(characterIndex: number, index: number): string {
  const character = CHARACTERS[characterIndex]!
  const place = MEMORY_PLACES[index % MEMORY_PLACES.length]!
  return `记忆 ${characterIndex + 1}-${pad(index, 3)}：${character.name}在${place}记得账本第 ${index + 1} 页的雨声与灯影。`
}

/**
 * 纯函数计划：不读时钟、不用随机数。
 * 记忆重复规则：每个角色前 40 条低重要度经历与第 41–80 条同文（keeper），
 * 归档候选因此有 200 条、被 50 条上限截断；每条角色后 20 条为已归档（共 100）。
 */
function buildPlan(): FixturePlan {
  const chapters: PlanChapter[] = []
  const volumes = 3
  const chaptersPerVolume = CHAPTER_COUNT / volumes

  for (let chapterOrd = 1; chapterOrd <= CHAPTER_COUNT; chapterOrd += 1) {
    const volumeOrd = Math.ceil(chapterOrd / chaptersPerVolume)
    const scenes: PlanScene[] = []
    for (let sceneOrd = 1; sceneOrd <= SCENES_PER_CHAPTER; sceneOrd += 1) {
      const participants = [0, 1, 2].map(
        (offset) => CHARACTERS[(chapterOrd + sceneOrd + offset) % CHARACTERS.length]!.id
      )
      const beats: PlanBeat[] = []
      for (let beatOrd = 1; beatOrd <= BEATS_PER_SCENE; beatOrd += 1) {
        const speaker = speakerAt(chapterOrd, sceneOrd, beatOrd)
        beats.push({
          id: beatIdOf(chapterOrd, sceneOrd, beatOrd),
          ord: beatOrd,
          speakerType: speaker.speakerType,
          speakerId: speaker.speakerId,
          body: bodyOf(chapterOrd, sceneOrd, beatOrd)
        })
      }
      scenes.push({ id: sceneIdOf(chapterOrd, sceneOrd), ord: sceneOrd, participants, beats })
    }
    chapters.push({
      id: chapterIdOf(chapterOrd),
      ord: chapterOrd,
      volumeOrd,
      outlineNodeId: `out_m2_${pad(chapterOrd)}`,
      revisionId: revisionIdOf(chapterOrd),
      scenes
    })
  }

  const memories: PlanMemory[] = []
  for (let characterIndex = 0; characterIndex < CHARACTERS.length; characterIndex += 1) {
    const character = CHARACTERS[characterIndex]!
    for (let index = 0; index < MEMORIES_PER_CHARACTER; index += 1) {
      const duplicateCandidate = index < 40
      const keeperIndex = duplicateCandidate ? index + 40 : index
      const archived = index >= MEMORIES_PER_CHARACTER - 20
      const chapterOrd = (index % CHAPTER_COUNT) + 1
      const kind: MemoryKind =
        duplicateCandidate || archived
          ? 'experience'
          : (['experience', 'fact', 'relationship', 'cognition'] as const)[index % 4]!
      memories.push({
        id: `mem_m2_${characterIndex + 1}_${pad(index, 3)}`,
        characterId: character.id,
        kind,
        text: memoryTextOf(characterIndex, keeperIndex),
        importance: duplicateCandidate ? 0.2 : 0.4 + (index % 7) * 0.05,
        pinned: index % 120 === 0 ? 1 : 0,
        learnedSeq: 1 + Math.floor((index * (CHAPTER_COUNT * BEATS_PER_SCENE - 1)) / (MEMORIES_PER_CHARACTER - 1)),
        chapterOrd,
        archived
      })
    }
  }

  const foreshadows: PlanForeshadow[] = []
  for (let index = 0; index < FORESHADOW_COUNT; index += 1) {
    const closed = index < 8
    foreshadows.push({
      id: `fs_m2_${pad(index + 1)}`,
      text: `伏笔 ${index + 1}：${MEMORY_PLACES[index % MEMORY_PLACES.length]}里那件没有说破的旧事。`,
      plantedChapterOrd: index + 1,
      plannedPayoffChapterOrd: closed ? 15 + index : 25 + (index - 8),
      closed
    })
  }

  return { chapters, memories, foreshadows }
}

/** 计划摘要：同一计划两次生成必须相同（PHASE-23 §5.1）。 */
function fixtureDigest(plan: FixturePlan): string {
  return sha256Hex(JSON.stringify(plan))
}

// ── 测量工具 ─────────────────────────────────────────────────────────────────

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  // 最近秩（PHASE-23 §5.2）：ceil(p × n) - 1。
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return Math.round(sorted[rank]! * 10) / 10
}

interface Timing {
  p50: number
  p95: number
  max: number
  samples: number
}

function timingOf(values: readonly number[]): Timing {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.round(Math.max(...values) * 10) / 10,
    samples: values.length
  }
}

function timeSync(fn: () => void, samples = SAMPLES, warmup = WARMUP): number[] {
  for (let index = 0; index < warmup; index += 1) fn()
  const times: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    fn()
    times.push(performance.now() - started)
  }
  return times
}

async function timeAsync(fn: () => Promise<void>, samples = SAMPLES, warmup = WARMUP): Promise<number[]> {
  for (let index = 0; index < warmup; index += 1) await fn()
  const times: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    await fn()
    times.push(performance.now() - started)
  }
  return times
}

interface QueryCounter {
  count: number
  restore(): void
}

/**
 * 查询计数（PHASE-23 §5.2）：包一层 `prepare`，数「发出多少条语句」。
 * 报表 / 声音 / 归档 / 检索都断言上界：30 章时若按章或按拍发查询会直接超标。
 */
function startQueryCounter(db: Db): QueryCounter {
  const original = db.prepare.bind(db)
  let active = true
  const counter: QueryCounter = {
    count: 0,
    restore: () => {
      if (!active) return
      active = false
      ;(db as unknown as { prepare: typeof original }).prepare = original
    }
  }
  ;(db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
    counter.count += 1
    return original(sql)
  }) as typeof original
  return counter
}

function counted<T>(db: Db, fn: () => T): { value: T; queries: number } {
  const counter = startQueryCounter(db)
  try {
    return { value: fn(), queries: counter.count }
  } finally {
    counter.restore()
  }
}

async function countedAsync<T>(db: Db, fn: () => Promise<T>): Promise<{ value: T; queries: number }> {
  const counter = startQueryCounter(db)
  try {
    return { value: await fn(), queries: counter.count }
  } finally {
    counter.restore()
  }
}

// ── 夹具落库 ─────────────────────────────────────────────────────────────────

interface Seeded {
  dir: string
  db: Db
  repos: ReturnType<typeof openTestDb>['repos']
  projectId: string
  plan: FixturePlan
  words: number
}

const TURN_AGENTS = ['orchestrator', 'character', 'narrator', 'reviewer', 'memory'] as const

function seed(plan: FixturePlan): Seeded {
  const dir = tempDir('noryth-perf-m2-')
  cleanups.push(dir.cleanup)
  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    mkdirSync(join(dir.path, sub), { recursive: true })
  }
  const { db, repos } = openTestDb(dir.path)
  cleanups.push(() => db.close())

  const projectId = 'prj_m2_scale'
  const project = repos.project.create({
    id: projectId,
    title: '黑漆匣子 · 10 万字',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 120_000,
    setupState: 'complete',
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: 512,
    defaultPreset: PROVIDER,
    schemaVersion: LATEST_SCHEMA_VERSION,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  })

  let words = 0
  const memoryRows: Array<{ plan: PlanMemory; seq: number; chapterId: string; revisionId: string }> = []

  withTransaction(db, () => {
    for (const character of CHARACTERS) {
      repos.character.insert({
        id: character.id,
        projectId: project.id,
        name: character.name,
        cardJson: JSON.stringify({
          identity: `${character.name}，黑漆匣子一案的当事人之一`,
          voice: { catchphrase: character.catchphrase, sentence_length: character.id === 'chr_m2_2' ? '长' : '短' },
          want: '查清账本上的名字',
          fear: '旧事被重新翻开',
          taboo: '祠堂后门'
        }),
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      })
    }

    const root = repos.outline.insert({
      id: 'out_m2_root',
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: '主线',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    })
    const volumes = Array.from({ length: 3 }, (_, index) =>
      repos.outline.insert({
        id: `out_m2_vol_${index + 1}`,
        projectId: project.id,
        parentId: root.id,
        kind: 'volume',
        ord: index + 1,
        title: `第 ${index + 1} 卷`,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      })
    )

    for (const chapterPlan of plan.chapters) {
      const volume = volumes[chapterPlan.volumeOrd - 1]!
      repos.outline.insert({
        id: chapterPlan.outlineNodeId,
        projectId: project.id,
        parentId: volume.id,
        kind: 'chapter',
        ord: ((chapterPlan.ord - 1) % 10) + 1,
        title: `第 ${chapterPlan.ord} 章`,
        content: `第 ${chapterPlan.ord} 章：祠堂里的账本与那场没有停过的雨。`,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      })
      const chapter = repos.chapter.insert({
        id: chapterPlan.id,
        projectId: project.id,
        outlineNodeId: chapterPlan.outlineNodeId,
        ord: chapterPlan.ord,
        status: 'drafting'
      })

      const sceneIds: string[] = []
      for (const scenePlan of chapterPlan.scenes) {
        const scene = repos.scene.insert({
          id: scenePlan.id,
          projectId: project.id,
          ord: scenePlan.ord,
          location: MEMORY_PLACES[(chapterPlan.ord + scenePlan.ord) % MEMORY_PLACES.length]!,
          participantsJson: JSON.stringify(scenePlan.participants),
          goal: `第 ${chapterPlan.ord} 章第 ${scenePlan.ord} 场：点灯、验封、看账本上的名字。`,
          entry: '众人进入祠堂',
          exitJson: JSON.stringify({ op: 'beats', cmp: '>=', value: BEATS_PER_SCENE }),
          status: 'closed',
          maxBeats: BEATS_PER_SCENE,
          storyStart: `民国二十三年 三月初${(chapterPlan.ord % 9) + 1}`,
          storyEnd: `民国二十三年 三月初${(chapterPlan.ord % 9) + 1} 夜`,
          timeline: 'main',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT
        })
        sceneIds.push(scene.id)
        repos.scene.linkToChapter(chapter.id, scene.id, scenePlan.ord)
      }

      const manifest: ManifestRow[] = []
      for (const scenePlan of chapterPlan.scenes) {
        for (const beat of scenePlan.beats) {
          manifest.push({
            sceneId: scenePlan.id,
            sceneOrd: scenePlan.ord,
            beatOrd: beat.ord,
            speakerType: beat.speakerType,
            speakerId: beat.speakerId,
            body: beat.body
          })
        }
      }
      const revision = repos.revision.insert({
        id: chapterPlan.revisionId,
        chapterId: chapter.id,
        kind: 'final',
        contentHash: hashManifestRows(manifest),
        createdBy: 'doc_controller',
        note: 'perf',
        createdAt: CREATED_AT
      })

      const members: Array<{ beatId: string; sceneOrd: number; beatOrd: number }> = []
      let maxSeq = 0
      for (const scenePlan of chapterPlan.scenes) {
        for (const beat of scenePlan.beats) {
          const seq = allocateSeq(db, project.id)
          maxSeq = Math.max(maxSeq, seq)
          words += [...beat.body].length
          repos.beat.insert({
            id: beat.id,
            chapterId: chapter.id,
            sceneId: scenePlan.id,
            ord: (scenePlan.ord - 1) * BEATS_PER_SCENE + beat.ord,
            seq,
            speakerType: beat.speakerType,
            speakerId: beat.speakerId,
            intent: `第 ${chapterPlan.ord} 章第 ${scenePlan.ord} 场第 ${beat.ord} 拍`,
            body: beat.body,
            status: 'confirmed',
            createdRevisionId: revision.id,
            wordCount: [...beat.body].length,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
          })
          members.push({ beatId: beat.id, sceneOrd: scenePlan.ord, beatOrd: beat.ord })
        }
      }
      repos.revision.insertMembers(
        revision.id,
        members.map((member) => ({ revisionId: revision.id, ...member }))
      )
      repos.chapter.setCurrentRevision(chapter.id, revision.id)
      repos.chapter.markFinalized(chapter.id, revision.id)
      repos.chapter.setCoveredUntilSeq(chapter.id, maxSeq)

      // 章末摘要（30 份；L0 `summary.prev` 读取）
      repos.chapterSummary.insert({
        revisionId: revision.id,
        chapterId: chapter.id,
        projectId: project.id,
        summary: `第 ${chapterPlan.ord} 章：${MEMORY_PLACES[chapterPlan.ord % MEMORY_PLACES.length]}里点灯验封，账本上的名字被重新提起，雨一直没停。`,
        keyFacts: [
          `第 ${chapterPlan.ord} 章确认了账本第 ${chapterPlan.ord} 页的名字`,
          `第 ${chapterPlan.ord} 章的封条由周砚验过`,
          `雨声掩盖了后门的脚步`
        ],
        tokens: 120,
        createdAt: CREATED_AT
      })

      // 声音指标（30 章 × 3 场，走生产计算路径后落库）
      for (const [sceneIndex, sceneId] of sceneIds.entries()) {
        const computed = computeSceneVoice(repos, sceneId)
        repos.voice.upsert({
          id: `vm_m2_${pad(chapterPlan.ord)}_${sceneIndex + 1}`,
          projectId: project.id,
          chapterId: chapter.id,
          sceneId,
          revisionId: revision.id,
          metricsJson: JSON.stringify(computed.metrics),
          thresholdVersion: VOICE_THRESHOLD.version,
          createdAt: CREATED_AT
        })
      }

      // 成本行：五个 Agent 按章归因 + 每拍确认耗时的事件（2 拍/章）
      for (const [index, agentKey] of TURN_AGENTS.entries()) {
        const tokensIn = 900 + index * 120 + chapterPlan.ord * 7
        const tokensOut = 180 + index * 20 + chapterPlan.ord * 3
        repos.turnMetric.insert({
          turnId: `tm_m2_${pad(chapterPlan.ord)}_${agentKey}`,
          projectId: project.id,
          jobId: `job_m2_${pad(chapterPlan.ord)}_${agentKey}`,
          beatId: beatIdOf(chapterPlan.ord, 1, 2),
          chapterId: chapter.id,
          agentKey,
          provider: PROVIDER,
          model: MODEL,
          bindingVersion: 1,
          tokensIn,
          tokensOut,
          cachedTokens: agentKey === 'reviewer' ? Math.floor(tokensIn * 0.6) : null,
          costCny: Math.round(((tokensIn * 2 + tokensOut * 8) / 1_000_000) * 1_000_000) / 1_000_000,
          latencyMs: 900 + chapterPlan.ord * 11 + index * 37,
          firstTokenMs: 180 + index * 9,
          contextJson: '{"blocks":[],"total_tokens":0,"trimmed":[]}',
          createdAt: CREATED_AT
        })
      }
      for (const beatOrd of [1, 2]) {
        const beatId = beatIdOf(chapterPlan.ord, 1, beatOrd)
        const base = Date.parse('2026-01-02T00:00:00.000Z') + chapterPlan.ord * 60_000
        repos.schedulerEvent.insert({
          id: `evt_m2_${pad(chapterPlan.ord)}_${beatOrd}_c`,
          projectId: project.id,
          chapterId: chapter.id,
          kind: 'beat_committed',
          payloadJson: JSON.stringify({ beatId }),
          createdAt: new Date(base).toISOString()
        })
        repos.schedulerEvent.insert({
          id: `evt_m2_${pad(chapterPlan.ord)}_${beatOrd}_f`,
          projectId: project.id,
          chapterId: chapter.id,
          kind: 'beat_confirmed',
          payloadJson: JSON.stringify({ beatId }),
          createdAt: new Date(base + 1_500 + chapterPlan.ord * 10).toISOString()
        })
      }

      // 记忆来源拍：取本章第 1 场第 2 拍（seq 只读一次，不逐条查）
      const sourceSeq = repos.beat.get(beatIdOf(chapterPlan.ord, 1, 2))?.seq ?? 1
      for (const memory of plan.memories) {
        if (memory.chapterOrd !== chapterPlan.ord) continue
        memoryRows.push({
          plan: memory,
          seq: sourceSeq,
          chapterId: chapter.id,
          revisionId: revision.id
        })
      }
    }

    // 项目级规划费用（chapter_id NULL，报表单列）
    for (let index = 0; index < 3; index += 1) {
      repos.turnMetric.insert({
        turnId: `tm_m2_plan_${index + 1}`,
        projectId: project.id,
        jobId: `job_m2_plan_${index + 1}`,
        beatId: null,
        chapterId: null,
        agentKey: 'planner',
        provider: PROVIDER,
        model: MODEL,
        bindingVersion: 1,
        tokensIn: 4_000 + index * 500,
        tokensOut: 800 + index * 120,
        cachedTokens: null,
        costCny: 0.02 + index * 0.004,
        latencyMs: 2_100 + index * 300,
        firstTokenMs: 260,
        contextJson: '{"blocks":[],"total_tokens":0,"trimmed":[]}',
        createdAt: CREATED_AT
      })
    }
  })

  // 3,000 条记忆 + 向量 + FTS（单事务；向量用 hash 嵌入，perf 不启动 ONNX）
  withTransaction(db, () => {
    for (const row of memoryRows) {
      const memory = row.plan
      repos.memory.insert({
        id: memory.id,
        projectId: project.id,
        characterId: memory.characterId,
        kind: memory.kind,
        text: memory.text,
        learnedSeq: row.seq,
        sourceChapterId: row.chapterId,
        sourceRevisionId: row.revisionId,
        sourceBeatId: beatIdOf(memory.chapterOrd, 1, 2),
        importance: memory.importance,
        pinned: memory.pinned,
        embeddingModel: EMBEDDING_MODEL,
        createdAt: CREATED_AT,
        ...(memory.archived ? { archivedAt: CREATED_AT, archiveReason: 'redundant' } : {})
      })
      repos.memoryIndex.writeVector(memory.id, Array.from(hashEmbedding(memory.text)))
      repos.memoryIndex.writeBigrams(memory.id, memory.characterId, memory.text)
    }

    for (const foreshadow of plan.foreshadows) {
      const record = repos.foreshadow.insert({
        id: foreshadow.id,
        projectId: project.id,
        text: foreshadow.text,
        plantedChapterId: chapterIdOf(foreshadow.plantedChapterOrd),
        plannedPayoffChapterId:
          foreshadow.plannedPayoffChapterOrd === null ? null : chapterIdOf(foreshadow.plannedPayoffChapterOrd)
      })
      if (foreshadow.closed && foreshadow.plannedPayoffChapterOrd !== null) {
        repos.foreshadow.close(record.id, chapterIdOf(foreshadow.plannedPayoffChapterOrd))
      }
    }
  })

  return { dir: dir.path, db, repos, projectId: project.id, plan, words }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────

interface PerfReport {
  generatedAt: string
  machine: {
    platform: string
    release: string
    cpu: string
    cores: number
    memoryGb: number
    node: string
    electron: string
  }
  fixture: {
    chapters: number
    beats: number
    words: number
    memoriesActive: number
    memoriesArchived: number
    summaries: number
    voiceRows: number
    turnMetricRows: number
    foreshadows: number
    dbBytes: number
  }
  metrics: Record<string, Timing>
  queries: Record<string, number>
  exports: { markdownMs: number; markdownBytes: number; docxMs: number; docxBytes: number }
  rssMb: number
  limits: Record<string, number>
}

function electronVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies?: { electron?: string }
    }
    return pkg.devDependencies?.electron ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function writeReport(report: PerfReport): string {
  const outPath = process.env.NORYTH_PERF_OUT ?? join(process.cwd(), 'out', 'perf', 'm2-perf-report.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return outPath
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('PERF-M2-01：10 万字规模基线', () => {
  it('夹具是确定性的：同一计划两次生成逐字段一致', () => {
    const first = buildPlan()
    const second = buildPlan()
    expect(fixtureDigest(first)).toBe(fixtureDigest(second))

    const beats = first.chapters.flatMap((chapter) => chapter.scenes.flatMap((scene) => scene.beats))
    const words = beats.reduce((sum, beat) => sum + [...beat.body].length, 0)
    expect(first.chapters).toHaveLength(CHAPTER_COUNT)
    expect(beats).toHaveLength(CHAPTER_COUNT * SCENES_PER_CHAPTER * BEATS_PER_SCENE)
    expect(words).toBeGreaterThan(100_000)
    // 每拍唯一：否则全篇同文会让 DOCX 压缩率与缓存命中虚高。
    expect(new Set(beats.map((beat) => beat.body)).size).toBe(beats.length)
    expect(first.memories).toHaveLength(CHARACTERS.length * MEMORIES_PER_CHARACTER)
    expect(first.memories.filter((memory) => memory.archived)).toHaveLength(100)
    expect(first.memories.filter((memory) => memory.importance <= 0.3)).toHaveLength(200)
    expect(first.foreshadows.filter((item) => item.closed)).toHaveLength(8)
  })

  it('M2 数据齐全时打开/切章/检索/装配/报表/声音/归档/导出达标', async () => {
    const plan = buildPlan()
    const seeded = seed(plan)
    const { db, repos, projectId } = seeded
    const chapterIds = plan.chapters.map((chapter) => chapter.id)

    // 夹具必须自身一致：verify 的 error 级问题为 0，否则后面的计时没有意义。
    expect(verifyDatabase(db).issues.filter((issue) => issue.severity === 'error')).toEqual([])

    // ── 打开（迁移 + verify + 最近章摘要；不含模型） ──────────────────────────
    for (let index = 0; index < WARMUP; index += 1) {
      const warmed = openTestDb(seeded.dir)
      verifyDatabase(warmed.db)
      warmed.repos.chapter.listSummaries(projectId)
      warmed.db.close()
    }
    const openTimes: number[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      const started = performance.now()
      const reopened = openTestDb(seeded.dir)
      verifyDatabase(reopened.db)
      reopened.repos.chapter.listSummaries(projectId)
      reopened.db.close()
      openTimes.push(performance.now() - started)
    }

    // ── 切章（write.state 的主体：章摘要 + 本章场景/拍，不读全书） ────────────
    let switchIndex = 0
    const switchTimes = timeSync(() => {
      const chapterId = chapterIds[switchIndex % chapterIds.length]!
      switchIndex += 1
      repos.chapter.listSummaries(projectId)
      repos.scene.listByChapter(chapterId)
      repos.beat.listLiveByChapter(chapterId)
      repos.scene.listUsageByProject(projectId)
    })

    // ── T23 时间线 ───────────────────────────────────────────────────────────
    let timelineIndex = 0
    const timelineTimes = timeSync(() => {
      const chapterId = chapterIds[timelineIndex % chapterIds.length]!
      timelineIndex += 1
      queryTimeline(repos, { projectId, chapterId })
    })

    // ── 检索（vec + FTS + RRF；3,000 条记忆，top_k 8） ───────────────────────
    const embedder = createHashEmbedder()
    const retrieveCharacter = CHARACTERS[0]!
    let retrieveIndex = 0
    const retrieveTimes = await timeAsync(async () => {
      retrieveIndex += 1
      invalidateRetrievalCache()
      await retrieveOwn(
        repos,
        embedder,
        { text: `账本 祠堂 雨 记忆 ${retrieveIndex}`, topK: 8 },
        {
          projectId,
          actorId: retrieveCharacter.id,
          characterId: retrieveCharacter.id,
          asOf: CHAPTER_COUNT * BEATS_PER_SCENE
        }
      )
    })

    // ── 上下文装配（collect + assemble；24 拍章节 / 5 角色 / L0–L3） ─────────
    const assembleChapter = plan.chapters.at(-1)!
    const assembleBeat = assembleChapter.scenes[1]!.beats[2]!
    const assembleTimes = timeSync(() => {
      const context = collectContext(repos, {
        projectId,
        chapterId: assembleChapter.id,
        beatId: assembleBeat.id,
        agent: `character:${assembleBeat.speakerId}`
      })
      assembleContext(context.input)
    })

    // ── 成本报表（30 章 + 6 Agent + 项目级） ─────────────────────────────────
    const costTimes = timeSync(() => {
      buildCostReport(repos)
    })

    // ── 声音指标（单场 24 拍，冷计算 + 持久化读取） ──────────────────────────
    const voiceScenes = plan.chapters.flatMap((chapter) =>
      chapter.scenes.map((scene) => ({ chapterId: chapter.id, sceneId: scene.id }))
    )
    let voiceIndex = 0
    const voiceTimes = timeSync(() => {
      const target = voiceScenes[voiceIndex % voiceScenes.length]!
      voiceIndex += 1
      computeSceneVoice(repos, target.sceneId)
    })
    const voiceCachedTimes = timeSync(() => {
      const target = voiceScenes[voiceIndex % voiceScenes.length]!
      voiceIndex += 1
      resolveSceneVoice(repos, { sceneId: target.sceneId }, { persist: false })
    })

    // ── 归档候选（3,000 条，50 条上限） ──────────────────────────────────────
    const archiveTimes = timeSync(() => {
      buildArchiveCandidates(repos, projectId)
    })

    // ── 查询计数（无 N+1：上界与章数/拍数无关） ──────────────────────────────
    const costCount = counted(db, () => buildCostReport(repos)).queries
    const costFilteredCount = counted(db, () =>
      buildCostReport(repos, { chapterId: chapterIds[0] })
    ).queries
    const voiceCount = counted(db, () => computeSceneVoice(repos, voiceScenes[0]!.sceneId)).queries
    const archiveResult = counted(db, () => buildArchiveCandidates(repos, projectId))
    const retrieveCount = await countedAsync(db, async () => {
      invalidateRetrievalCache()
      return retrieveOwn(
        repos,
        embedder,
        { text: '账本 祠堂 雨 计数', topK: 8 },
        {
          projectId,
          actorId: retrieveCharacter.id,
          characterId: retrieveCharacter.id,
          asOf: CHAPTER_COUNT * BEATS_PER_SCENE
        }
      )
    })

    // ── 导出（100k 字；MD + DOCX 含目录） ────────────────────────────────────
    const mdTimes: number[] = []
    let markdownBytes = 0
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now()
      const exported = await exportManuscript(repos, seeded.dir, { format: 'md', includeNotes: true })
      mdTimes.push(performance.now() - started)
      markdownBytes = exported.bytes
      if (index === 0) expect(exported.words).toBeGreaterThan(100_000)
    }
    const docxTimes: number[] = []
    let docxBytes = 0
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now()
      const exported = await exportManuscript(repos, seeded.dir, { format: 'docx', includeNotes: false, toc: true })
      docxTimes.push(performance.now() - started)
      docxBytes = exported.bytes
      if (index === 0) {
        expect(exported.chapters).toBe(CHAPTER_COUNT)
        expect(exported.beats).toBe(CHAPTER_COUNT * SCENES_PER_CHAPTER * BEATS_PER_SCENE)
      }
    }

    // ── 夹具完整性 ───────────────────────────────────────────────────────────
    const fixture = {
      chapters: plan.chapters.length,
      beats: CHAPTER_COUNT * SCENES_PER_CHAPTER * BEATS_PER_SCENE,
      words: seeded.words,
      memoriesActive: Number(
        (db.prepare("SELECT COUNT(*) AS count FROM memory_entry WHERE archived_at IS NULL").get() as { count: number })
          .count
      ),
      memoriesArchived: Number(
        (db.prepare('SELECT COUNT(*) AS count FROM memory_entry WHERE archived_at IS NOT NULL').get() as {
          count: number
        }).count
      ),
      summaries: Number((db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }).count),
      voiceRows: Number((db.prepare('SELECT COUNT(*) AS count FROM voice_metric').get() as { count: number }).count),
      turnMetricRows: Number((db.prepare('SELECT COUNT(*) AS count FROM turn_metric').get() as { count: number }).count),
      foreshadows: Number((db.prepare('SELECT COUNT(*) AS count FROM foreshadow').get() as { count: number }).count),
      dbBytes:
        Number((db.pragma('page_count', { simple: true }) as number)) *
        Number((db.pragma('page_size', { simple: true }) as number))
    }
    expect(fixture.chapters).toBe(30)
    expect(fixture.words).toBeGreaterThan(100_000)
    expect(fixture.memoriesActive).toBeGreaterThanOrEqual(2_800)
    expect(fixture.memoriesArchived).toBe(100)
    expect(fixture.summaries).toBe(30)
    expect(fixture.voiceRows).toBe(90)
    expect(fixture.foreshadows).toBe(12)

    // ── 结果 ─────────────────────────────────────────────────────────────────
    const metrics: Record<string, Timing> = {
      open: timingOf(openTimes),
      switchChapter: timingOf(switchTimes),
      timeline: timingOf(timelineTimes),
      retrieve: timingOf(retrieveTimes),
      assemble: timingOf(assembleTimes),
      costReport: timingOf(costTimes),
      voiceCompute: timingOf(voiceTimes),
      voiceCached: timingOf(voiceCachedTimes),
      archiveCandidates: timingOf(archiveTimes)
    }
    const limits = {
      openMs: 800,
      switchP95Ms: 120,
      timelineP95Ms: 100,
      retrieveP95Ms: 80,
      assembleP95Ms: 150,
      costP95Ms: 200,
      voiceP95Ms: 100,
      archiveP95Ms: 200,
      markdownMs: 2_000,
      docxMs: 5_000,
      rssMb: 600
    }
    const exports = {
      markdownMs: Math.round(Math.max(...mdTimes) * 10) / 10,
      markdownBytes,
      docxMs: Math.round(Math.max(...docxTimes) * 10) / 10,
      docxBytes
    }
    const rssMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10

    const report: PerfReport = {
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 1024 / 1024 / 1024),
        node: process.versions.node,
        electron: electronVersion()
      },
      fixture,
      metrics,
      queries: {
        costReport: costCount,
        costReportFiltered: costFilteredCount,
        voiceCompute: voiceCount,
        archiveCandidates: archiveResult.queries,
        retrieve: retrieveCount.queries
      },
      exports,
      rssMb,
      limits
    }
    const reportPath = writeReport(report)

    // eslint-disable-next-line no-console
    console.log(
      `PERF-M2-01 打开P95=${metrics.open!.p95}ms 切章P95=${metrics.switchChapter!.p95}ms ` +
        `T23P95=${metrics.timeline!.p95}ms 检索P95=${metrics.retrieve!.p95}ms 装配P95=${metrics.assemble!.p95}ms ` +
        `报表P95=${metrics.costReport!.p95}ms 声音P95=${metrics.voiceCompute!.p95}ms ` +
        `归档P95=${metrics.archiveCandidates!.p95}ms MD=${exports.markdownMs}ms DOCX=${exports.docxMs}ms ` +
        `RSS=${rssMb}MB 查询[报表${costCount}/过滤${costFilteredCount}/声音${voiceCount}/归档${archiveResult.queries}/检索${retrieveCount.queries}] ` +
        `夹具=${fixture.words}字/${fixture.memoriesActive + fixture.memoriesArchived}记忆 · 报告 ${reportPath}`
    )

    // ── 断言（PHASE-23 §5.2） ────────────────────────────────────────────────
    expect(metrics.open!.p95).toBeLessThan(limits.openMs)
    expect(metrics.switchChapter!.p95).toBeLessThan(limits.switchP95Ms)
    expect(metrics.timeline!.p95).toBeLessThan(limits.timelineP95Ms)
    expect(metrics.retrieve!.p95).toBeLessThan(limits.retrieveP95Ms)
    expect(metrics.assemble!.p95).toBeLessThan(limits.assembleP95Ms)
    expect(metrics.costReport!.p95).toBeLessThan(limits.costP95Ms)
    expect(metrics.voiceCompute!.p95).toBeLessThan(limits.voiceP95Ms)
    expect(metrics.archiveCandidates!.p95).toBeLessThan(limits.archiveP95Ms)
    expect(exports.markdownMs).toBeLessThan(limits.markdownMs)
    expect(exports.docxMs).toBeLessThan(limits.docxMs)
    expect(rssMb).toBeLessThan(limits.rssMb)

    // 查询计数：30 章时若按章/按拍发查询会远超上界。
    expect(costCount).toBeLessThanOrEqual(10)
    expect(costFilteredCount).toBeLessThanOrEqual(costCount + 1)
    expect(voiceCount).toBeLessThanOrEqual(12)
    expect(archiveResult.queries).toBeLessThanOrEqual(25)
    expect(retrieveCount.queries).toBeLessThanOrEqual(12)
    // 归档候选有结果（性能路径不是空跑）且不超过批次上限。
    expect(archiveResult.value.length).toBeGreaterThan(0)
    expect(archiveResult.value.length).toBeLessThanOrEqual(50)
    // 检索不是空跑：向量 + 关键词 + RRF 至少命中一条。
    expect(retrieveCount.value.items.length + retrieveCount.value.pinned.length).toBeGreaterThan(0)

    await embedder.dispose()
  }, 300_000)
})
