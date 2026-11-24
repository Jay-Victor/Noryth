import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import {
  extractAndApplyMemory,
  generateAndConfirmBeat,
  listChapters,
  reviewAndFinalize
} from './m1-flow'

/**
 * M2 长跑脚手架（PHASE-24 §5.1 / §5.2）。
 *
 * 与 M1 的 `m1-flow.ts` 共用审批/记忆闭环；本文件只加 M2 需要的部分：
 * - 分镜：3 场 × 8 拍（24 拍/章），3 个角色轮流 + 旁白（每个角色每场 ≥2 拍，
 *   声音指标才算得出两两区分度）；
 * - 每章前 2 拍逐拍确认，其中第 2 拍含 1 次重生成；
 * - 自动模式带章预算（默认 ¥5；调用方可用 budgetCny 覆盖）；
 * - 可选：章前一次编排对话（orchestrator 回合），项目级一次规划对话（planner），
 *   让 `turn_metric` 覆盖六个 Agent。
 *
 * 只用产品 IPC（等价 UI 按钮），不直接写库；生产包不注册 devSeed。
 */

export interface M2SeedOptions {
  volumes?: number
  chaptersPerVolume?: number
  characters?: number
  scenes?: number
  beatsPerScene?: number
}

export interface M2Chapter {
  id: string
  ord: number
}

export interface M2ChapterResult {
  chapterId: string
  ord: number
  reportVerdict: string
  patches: number
  accepted: number
  memoryApplied: number
  words: number
}

export interface M2ChapterOptions {
  /** 章预算（¥）；省略 = 保持默认（NULL → ¥5.00）。 */
  budgetCny?: number
  /** 章前发一条编排消息，覆盖 orchestrator 的成本行。 */
  orchestratorTurn?: boolean
}

const CHARACTER_BEATS = 3
const SPEAKERS_PER_SCENE = 3

function scenesFor(
  ord: number,
  people: Array<{ id: string }>,
  sceneCount: number,
  beatsPerScene: number
): unknown[] {
  const speakers = people.slice(0, SPEAKERS_PER_SCENE)
  if (speakers.length < 2) throw new Error('M2 长跑至少需要 2 个角色（声音两两区分度）')
  return Array.from({ length: sceneCount }, (_, sceneIndex) => ({
    location: `第 ${ord} 章 · 地点 ${sceneIndex + 1}`,
    participants: people.map((person) => person.id),
    goal: `第 ${ord} 章第 ${sceneIndex + 1} 场：核对匣子的下落`,
    entry: '',
    exit: `all(fact("black_box","location"), beats(${beatsPerScene}))`,
    max_beats: beatsPerScene,
    beats: Array.from({ length: beatsPerScene }, (_, beatIndex) => {
      // 每 4 拍：角色 A、B、C、旁白；同一场每个角色恰好 2 拍。
      const role = beatIndex % (CHARACTER_BEATS + 1)
      const speaker = role < CHARACTER_BEATS ? speakers[role]! : null
      return {
        speaker_type: speaker === null ? 'narrator' : 'character',
        speaker_id: speaker === null ? 'narrator' : speaker.id,
        intent: `第${ord}章·第${sceneIndex + 1}场·第${beatIndex + 1}拍`,
        max_words: 200
      }
    })
  }))
}

/** devSeed（3 卷 / 30 章 / 5 角色）+ 逐章覆盖为「多角色轮换」的分镜草案。 */
export async function seedLongrun(page: Page, options: M2SeedOptions = {}): Promise<M2Chapter[]> {
  const sceneCount = options.scenes ?? 3
  const beatsPerScene = options.beatsPerScene ?? 8
  const volumes = options.volumes ?? 3
  const chaptersPerVolume = options.chaptersPerVolume ?? 10
  const seeded = await page.evaluate(
    async (input) =>
      window.noryth!.write.devSeed({
        ...(input.volumes > 1
          ? { volumes: input.volumes, chaptersPerVolume: input.chaptersPerVolume }
          : { chapters: input.chaptersPerVolume }),
        scenes: input.scenes,
        beatsPerScene: input.beatsPerScene,
        seedEveryChapter: true,
        characters: input.characters
      }),
    {
      volumes,
      chaptersPerVolume,
      scenes: sceneCount,
      beatsPerScene,
      characters: options.characters ?? 5
    }
  )
  if (!seeded.ok) throw new Error(`devSeed failed: ${seeded.error.code} ${seeded.error.message}`)

  const state = await page.evaluate(async () => {
    const result = await window.noryth!.write.state()
    return result.ok ? result.data : null
  })
  if (state === null) throw new Error('write.state failed after devSeed')
  const people = state.characters.map((character) => ({ id: character.id }))
  const chapters = await listChapters(page)

  for (const chapter of chapters) {
    const saved = await page.evaluate(
      async ({ chapterId, scenes }) => window.noryth!.write.saveStoryboard({ chapterId, scenes: scenes as never }),
      { chapterId: chapter.id, scenes: scenesFor(chapter.ord, people, sceneCount, beatsPerScene) }
    )
    if (!saved.ok) {
      throw new Error(`saveStoryboard failed for ch${chapter.ord}: ${saved.error.code} ${saved.error.message}`)
    }
  }
  return chapters.map((chapter) => ({ id: chapter.id, ord: chapter.ord }))
}

/** 项目级一次规划对话：只记账（planner 的 chapter_id = NULL），不应用提案、不确认 G1。 */
export async function runPlanningTurn(page: Page): Promise<string> {
  const created = await page.evaluate(async () => window.noryth!.plan.createSession({ title: 'M2 长跑规划' }))
  if (!created.ok) throw new Error(`plan.createSession failed: ${created.error.code}`)
  const sessionId = created.data.id
  const sent = await page.evaluate(
    async (id) => window.noryth!.plan.send({ sessionId: id, text: '用一句话说明这本书的核心冲突。' }),
    sessionId
  )
  if (!sent.ok) throw new Error(`plan.send failed: ${sent.error.code}`)
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await page.evaluate(async (id) => window.noryth!.plan.state(id), sessionId)
    if (!state.ok) throw new Error(`plan.state failed: ${state.error.code}`)
    const assistant = state.data.messages.find((message) => message.id === sent.data.assistantMessageId)
    if (assistant !== undefined && assistant.status === 'done') return sessionId
    if (assistant !== undefined && assistant.status === 'failed') {
      throw new Error('planning turn failed')
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('planning turn did not finish')
}

async function liveBeatId(
  page: Page,
  chapterId: string,
  sceneId: string,
  ord: number,
  exclude: string | null
): Promise<string | null> {
  return page.evaluate(
    async ({ chapterId: id, sceneId: wantedScene, ord: wantedOrd, exclude: skip }) => {
      const state = await window.noryth!.write.state(id)
      if (!state.ok) return null
      const beats = state.data.scenes.flatMap((scene) => scene.beats)
      const live = beats.find(
        (beat) =>
          beat.sceneId === wantedScene &&
          beat.ord === wantedOrd &&
          beat.status === 'waiting_for_human' &&
          beat.id !== skip
      )
      return live?.id ?? null
    },
    { chapterId, sceneId, ord, exclude }
  )
}

/** 生成一拍 → 重生成一次 → 确认第二版（重生成留下 superseded 旧版）。 */
async function generateRegenerateAndConfirm(page: Page, chapterId: string): Promise<void> {
  const slot = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    if (!state.ok) return null
    const beats = state.data.scenes.flatMap((scene) => scene.beats)
    const next = beats.find((beat) => beat.status === 'proposed') ?? beats.find((beat) => beat.status === 'draft')
    return next === undefined ? null : { beatId: next.id, sceneId: next.sceneId, ord: next.ord }
  }, chapterId)
  if (slot === null) throw new Error(`chapter ${chapterId} has no proposed beat`)
  const first = await page.evaluate(async (id) => window.noryth!.write.generate(id), slot.beatId)
  if (!first.ok) throw new Error(`generate failed: ${first.error.code}`)
  const firstLive = await liveBeatId(page, chapterId, slot.sceneId, slot.ord, null)
  if (firstLive === null) throw new Error('generated beat not waiting for human')
  const second = await page.evaluate(async (id) => window.noryth!.write.regenerate(id), firstLive)
  if (!second.ok) throw new Error(`regenerate failed: ${second.error.code}`)
  const secondLive = await liveBeatId(page, chapterId, slot.sceneId, slot.ord, firstLive)
  if (secondLive === null) throw new Error('regenerated beat not waiting for human')
  const confirmed = await page.evaluate(async (id) => window.noryth!.write.confirm(id), secondLive)
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`)
}

async function waitDraftComplete(page: Page, chapterId: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = await page.evaluate(async (id) => {
      const state = await window.noryth!.write.state(id)
      return state.ok ? state.data.chapterStatus : ''
    }, chapterId)
    if (status === 'draft_complete') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`chapter ${chapterId} did not reach draft_complete`)
}

/** 一章：章预算（可选）→ 编排对话（可选）→ G2 → 2 拍（含重生成）→ 自动 → G4/G5/G6 → G7。 */
export async function runChapterM2(
  page: Page,
  chapter: M2Chapter,
  options: M2ChapterOptions = {}
): Promise<M2ChapterResult> {
  if (options.budgetCny !== undefined) {
    const budget = await page.evaluate(
      async (input) => window.noryth!.write.setBudget(input),
      { chapterId: chapter.id, budgetCny: options.budgetCny }
    )
    if (!budget.ok) throw new Error(`setBudget failed for ch${chapter.ord}: ${budget.error.code}`)
  }
  if (options.orchestratorTurn === true) {
    const sent = await page.evaluate(
      async (id) => window.noryth!.write.send({ chapterId: id, text: '请确认本场分镜与出场顺序。' }),
      chapter.id
    )
    if (!sent.ok) throw new Error(`orchestrator turn failed for ch${chapter.ord}: ${sent.error.code}`)
  }

  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapter.id)
  if (!g2.ok) throw new Error(`G2 failed for ch${chapter.ord}: ${g2.error.code}`)

  await generateAndConfirmBeat(page, chapter.id)
  await generateRegenerateAndConfirm(page, chapter.id)

  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), chapter.id)
  if (!auto.ok) throw new Error(`auto start failed for ch${chapter.ord}: ${auto.error.code}`)
  await waitDraftComplete(page, chapter.id)

  const review = await reviewAndFinalize(page, chapter.id)
  const memoryApplied = await extractAndApplyMemory(page, chapter.id)

  const words = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    if (!state.ok) return 0
    return state.data.scenes.reduce(
      (sum, scene) => sum + scene.beats.reduce((inner, beat) => inner + beat.wordCount, 0),
      0
    )
  }, chapter.id)

  return {
    chapterId: chapter.id,
    ord: chapter.ord,
    reportVerdict: review.verdict,
    patches: review.patches,
    accepted: review.accepted,
    memoryApplied,
    words
  }
}

/** 启动 M2 长跑形态的 Electron（假模型 + 长文本 + 零延迟 + 哈希嵌入）。 */
export async function launchM2(
  root: string,
  userData: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_WRITE_FAKE_LONG = '1'
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_MEMORY_FAKE = '1'
  env.NORYTH_PLAN_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '0'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '0'
  env.NORYTH_MEMORY_STREAM_DELAY_MS = '0'
  env.NORYTH_MEMORY_EMBED = 'hash'
  for (const name of [
    'NORYTH_DEEPSEEK_API_KEY',
    'NORYTH_WRITE_API_KEY',
    'NORYTH_PLAN_API_KEY',
    'NORYTH_REVIEW_API_KEY',
    'NORYTH_MEMORY_API_KEY'
  ]) {
    delete env[name]
  }
  const app = await electron.launch({ args: [root], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

/** 新建项目（M2 长跑统一的书名与目标字数）。 */
export async function createM2Project(
  page: Page,
  parentDir: string,
  folderName: string,
  title: string
): Promise<{ projectId: string; path: string }> {
  const created = await page.evaluate(
    async ({ parent, folder, bookTitle }) =>
      window.noryth!.project.create({
        parentDir: parent,
        folderName: folder,
        title: bookTitle,
        genre: '悬疑',
        targetWords: 120_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parent: parentDir, folder: folderName, bookTitle: title }
  )
  if (!created.ok) throw new Error(`project.create failed: ${created.error.code}`)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  return { projectId: created.data.projectId, path: created.data.path }
}
