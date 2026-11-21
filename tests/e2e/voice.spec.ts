import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * PHASE-19 验收：
 *   E2E-M2-VOICE-01：一对低区分度角色 → 创作台场景头 → 审批台声音面板 → 报告 voice 建议
 *                     → G6 仍可定稿 → 正文与 revision 不变。
 *   E2E-M2-METRICS-01：`scripts/m2-baseline.mjs` 输出声音与伏笔回收率。
 *
 * 两个角色都由假创作适配器生成同构短句（意图等长），所以句长/问句/第一人称几乎相同，
 * 两两区分度必然低于阈值——这正是要告警的情形。
 */

const ROOT = resolve(__dirname, '../..')
const tempDirs: string[] = []
const apps: ElectronApplication[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.NORYTH_USER_DATA = userData
  env.NORYTH_SINGLE_INSTANCE = '0'
  env.NORYTH_WRITE_FAKE = '1'
  env.NORYTH_REVIEW_FAKE = '1'
  env.NORYTH_WRITE_STREAM_DELAY_MS = '1'
  env.NORYTH_REVIEW_STREAM_DELAY_MS = '1'
  delete env.NORYTH_DEEPSEEK_API_KEY
  delete env.NORYTH_PLAN_API_KEY
  delete env.NORYTH_WRITE_API_KEY
  delete env.NORYTH_REVIEW_API_KEY
  delete env.NORYTH_MEMORY_API_KEY

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-ready"]', { timeout: 30_000 })
  return { app, page }
}

async function createProject(page: Page, parent: string, folder: string): Promise<{ projectId: string; path: string }> {
  const result = await page.evaluate(
    async ({ parentDir, name }) =>
      window.noryth!.project.create({
        parentDir,
        folderName: name,
        title: '黑漆匣子 · 声音',
        genre: '悬疑',
        targetWords: 80_000,
        pov: 'third_limited',
        boundaries: '不写真实人物'
      }),
    { parentDir: parent, name: folder }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  return { projectId: result.data.projectId, path: result.data.path }
}

interface Seeded {
  chapterId: string
  sceneIds: string[]
  first: { id: string; name: string }
  second: { id: string; name: string }
}

/** devSeed 铺一章，再把分镜换成「两个角色轮流说话」的 6 拍 × N 场，并过 G2。 */
async function seedTwoVoices(page: Page, sceneCount = 1): Promise<Seeded> {
  const seeded = await page.evaluate(async () => window.noryth!.write.devSeed({ scenes: 1, beatsPerScene: 6, characters: 2 }))
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error(seeded.error.code)

  const state = await page.evaluate(async () => window.noryth!.write.state())
  expect(state.ok).toBe(true)
  if (!state.ok) throw new Error(state.error.code)
  const chapterId = state.data.chapterId
  const [first, second] = state.data.characters
  if (!first || !second) throw new Error('devSeed 没有两个角色')

  const beats = Array.from({ length: 6 }, (_, index) => ({
    speaker_type: 'character' as const,
    speaker_id: index % 2 === 0 ? first.id : second.id,
    // 等长意图：假适配器把意图写进正文，长度一致才不会人为拉开句长。
    intent: index % 2 === 0 ? '对质甲' : '对质乙',
    max_words: 200
  }))
  const storyboard = {
    chapterId,
    scenes: Array.from({ length: sceneCount }, (_, sceneIndex) => ({
      location: `沈家祠堂 ${sceneIndex + 1}`,
      participants: [first.id, second.id],
      goal: `第 ${sceneIndex + 1} 场：确认匣子的下落`,
      exit: 'beats(6)',
      max_beats: 6,
      beats
    }))
  }
  const saved = await page.evaluate(async (input) => window.noryth!.write.saveStoryboard(input), storyboard)
  expect(saved.ok).toBe(true)
  if (!saved.ok) throw new Error(saved.error.code)

  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapterId)
  expect(g2.ok).toBe(true)
  if (!g2.ok) throw new Error(g2.error.code)
  const after = await page.evaluate(async (id) => window.noryth!.write.state(id), chapterId)
  if (!after.ok) throw new Error(after.error.code)
  return {
    chapterId,
    sceneIds: after.data.scenes.map((scene) => scene.id),
    first: { id: first.id, name: first.name },
    second: { id: second.id, name: second.name }
  }
}

/** 生成并确认一拍；给了 target 就按 (sceneId, ord) 定位，否则取第一拍 proposed。 */
async function generateAndConfirm(
  page: Page,
  chapterId: string,
  target?: { sceneId: string; ord: number }
): Promise<void> {
  const slot = await page.evaluate(
    async ({ id, target: wanted }) => {
      const state = await window.noryth!.write.state(id)
      if (!state.ok) return null
      const beats = state.data.scenes.flatMap((scene) => scene.beats)
      const next = wanted
        ? beats.find(
            (beat) =>
              beat.sceneId === wanted.sceneId &&
              beat.ord === wanted.ord &&
              (beat.status === 'proposed' || beat.status === 'draft')
          )
        : (beats.find((beat) => beat.status === 'proposed') ?? beats.find((beat) => beat.status === 'draft'))
      return next === undefined ? null : { beatId: next.id, sceneId: next.sceneId, ord: next.ord }
    },
    { id: chapterId, target }
  )
  if (slot === null) throw new Error('没有可生成的拍')
  const generated = await page.evaluate(async (id) => window.noryth!.write.generate(id), slot.beatId)
  if (!generated.ok) throw new Error(`generate failed: ${generated.error.code}`)
  const liveId = await page.evaluate(
    async ({ chapterId: id, sceneId, ord }) => {
      const state = await window.noryth!.write.state(id)
      if (!state.ok) return null
      const beats = state.data.scenes.flatMap((scene) => scene.beats)
      const live = beats.find(
        (beat) => beat.sceneId === sceneId && beat.ord === ord && beat.status === 'waiting_for_human'
      )
      return live?.id ?? null
    },
    { chapterId, sceneId: slot.sceneId, ord: slot.ord }
  )
  if (liveId === null) throw new Error('生成后没有 waiting_for_human 的拍')
  const confirmed = await page.evaluate(async (id) => window.noryth!.write.confirm(id), liveId)
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`)
}

async function waitDraftComplete(page: Page, chapterId: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const status = await page.evaluate(async (id) => {
      const state = await window.noryth!.write.state(id)
      return state.ok ? state.data.chapterStatus : ''
    }, chapterId)
    if (status === 'draft_complete') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('章节没有到 draft_complete')
}

async function readVoice(page: Page, sceneId: string): Promise<{
  found: boolean
  insufficientData: boolean
  belowThreshold: boolean
  names: string[]
  thresholdVersion: string
  pairs: number
}> {
  const result = await page.evaluate(async (id) => window.noryth!.voice.scene({ sceneId: id }), sceneId)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)
  const names = result.data.pairs.flatMap((pair) => [pair.aName, pair.bName])
  return {
    found: result.data.found,
    insufficientData: result.data.insufficientData,
    belowThreshold: result.data.belowThreshold,
    names: [...new Set(names)],
    thresholdVersion: result.data.threshold.version,
    pairs: result.data.pairs.length
  }
}

const ZERO_HASH = '0'.repeat(64)

function draftHash(dbPath: string, chapterId: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT content_hash FROM revision WHERE chapter_id = ? AND kind = ? ORDER BY created_at')
      .all(chapterId, 'draft') as Array<{ content_hash: string }>
    return row.map((item) => item.content_hash).join('|') || ZERO_HASH
  } finally {
    db.close()
  }
}

test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  for (const app of apps) {
    try {
      await app.close()
    } catch {
      // 已退出
    }
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 偶发占用
    }
  }
})

test('E2E-M2-VOICE-01：低区分度角色对可见、报告只出建议、G6 仍可定稿', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-voice-user-')
  const parent = makeTemp('noryth-voice-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent, '声音主流程')
  const seeded = await seedTwoVoices(page)

  // 两位角色各 2 拍（4 拍确认），不用跑完就能算指标。
  for (let index = 0; index < 4; index += 1) await generateAndConfirm(page, seeded.chapterId)
  const early = await readVoice(page, seeded.sceneIds[0]!)
  expect(early.found).toBe(true)
  expect(early.insufficientData).toBe(false)
  expect(early.pairs).toBe(1)
  expect(early.names).toEqual([seeded.first.name, seeded.second.name])
  expect(early.thresholdVersion).toBe('zh-v1')
  expect(early.belowThreshold).toBe(true)

  // 创作台场景头：徽标显示最低的一对，可展开看分项；不阻断确认。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="write"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  const badge = page.locator(`[data-testid="write-voice-badge-${seeded.sceneIds[0]!}"]`)
  await expect(badge).toBeVisible({ timeout: 15_000 })
  await expect(badge).toContainText(seeded.first.name)
  await expect(badge).toContainText(seeded.second.name)
  await expect(page.locator(`[data-testid="write-voice-${seeded.sceneIds[0]!}"]`)).toHaveAttribute('data-low', '1')
  await badge.click()
  await expect(page.locator(`[data-testid="write-voice-panel-${seeded.sceneIds[0]!}"]`)).toContainText('zh-v1')

  // 自动跑完本章，再跑 G4；声音建议由运行时追加（不阻断）。
  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), seeded.chapterId)
  expect(auto.ok).toBe(true)
  if (!auto.ok) throw new Error(auto.error.code)
  await waitDraftComplete(page, seeded.chapterId)

  const dbPath = join(project.path, 'noryth.db')
  const hashBeforeReview = draftHash(dbPath, seeded.chapterId)

  const reviewed = await page.evaluate(async (id) => window.noryth!.review.run(id), seeded.chapterId)
  expect(reviewed.ok).toBe(true)
  if (!reviewed.ok) throw new Error(reviewed.error.code)
  const report = reviewed.data.state.report
  expect(report).not.toBeNull()
  // 假审批自己也会给一条没有指标证据的 voice 建议；运行时那条以 iss_voice_ 开头。
  const voiceIssues = report!.suggestions.filter(
    (issue) => issue.type === 'voice' && issue.issue_id.startsWith('iss_voice_')
  )
  expect(voiceIssues).toHaveLength(1)
  expect(voiceIssues[0]!.evidence).toContain('区分度')
  expect(report!.blocking.some((issue) => issue.type === 'voice')).toBe(false)
  expect(draftHash(dbPath, seeded.chapterId)).toBe(hashBeforeReview)

  // 审批台报告页：声音面板显示同一对角色与阈值版本。
  await page.reload()
  await page.waitForSelector('[data-testid="app-ready"]')
  await page.locator('[data-nav="review"]').click()
  await page.waitForSelector('[data-testid="pane-preview"]')
  await page.locator('[data-testid="review-tab-report"]').click()
  await expect(page.locator('[data-testid="review-voice"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(`[data-testid="review-voice-characters-${seeded.sceneIds[0]!}"]`)).toContainText(
    seeded.first.name
  )
  await expect(page.locator(`[data-testid="review-voice-characters-${seeded.sceneIds[0]!}"]`)).toContainText(
    seeded.second.name
  )
  await expect(page.locator(`[data-testid="review-voice-matrix-${seeded.sceneIds[0]!}"]`)).toContainText('0.')

  // G5 修订 → 复检 → G6：声音偏低不阻断定稿。
  const authorized = await page.evaluate(async (id) => window.noryth!.review.authorizeRevision(id), seeded.chapterId)
  expect(authorized.ok).toBe(true)
  if (!authorized.ok) throw new Error(authorized.error.code)
  const patches = authorized.data.state.patches.filter((patch) => patch.status === 'proposed')
  expect(patches.length).toBeGreaterThan(0)
  const decided = await page.evaluate(
    async ({ chapterId, expectedRevision, decisions }) =>
      window.noryth!.review.decide({ chapterId, expectedRevision, decisions }),
    {
      chapterId: seeded.chapterId,
      expectedRevision: authorized.data.state.revisionId,
      decisions: patches.map((patch, index) => ({ patchId: patch.id, accept: index < 2 || patches.length <= 2 }))
    }
  )
  expect(decided.ok).toBe(true)
  const rechecked = await page.evaluate(async (id) => window.noryth!.review.recheck(id), seeded.chapterId)
  expect(rechecked.ok).toBe(true)

  const preview = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.finalizePreview(id)
    return result.ok ? result.data : null
  }, seeded.chapterId)
  expect(preview).not.toBeNull()
  expect(preview!.ready).toBe(true)
  expect(preview!.blocking.some((issue) => issue.type === 'voice')).toBe(false)

  const issued = await page.evaluate(async (id) => window.noryth!.review.issueFinalizeToken(id), seeded.chapterId)
  expect(issued.ok).toBe(true)
  if (!issued.ok) throw new Error(issued.error.code)
  const finalized = await page.evaluate(
    async ({ chapterId, token, ackBlocking, ackUnreviewed }) =>
      window.noryth!.review.finalize({ chapterId, token, ackBlocking, ackUnreviewed }),
    {
      chapterId: seeded.chapterId,
      token: issued.data.token,
      ackBlocking: issued.data.preview.blocking.length > 0,
      ackUnreviewed: issued.data.preview.unreviewedCount > 0
    }
  )
  expect(finalized.ok).toBe(true)
  if (!finalized.ok) throw new Error(finalized.error.code)
  expect(finalized.data.state.chapterStatus).toBe('finalized')

  // G4 那次已断言 draft 清单不变；G5 的 patch 会建新 draft，但声音指标不参与。
  const verify = await page.evaluate(async () => {
    const result = await window.noryth!.project.verify()
    return result.ok ? { ok: result.data.ok, errors: result.data.issues.filter((issue) => issue.severity === 'error') } : { ok: false, errors: [] }
  })
  expect(verify.errors).toEqual([])
  expect(verify.ok).toBe(true)
})

test('E2E-M2-METRICS-01：基线脚本输出声音与伏笔回收率', async () => {
  test.setTimeout(240_000)
  const userData = makeTemp('noryth-metrics-user-')
  const parent = makeTemp('noryth-metrics-project-')
  const { page } = await launch(userData)
  const project = await createProject(page, parent, '基线度量')
  const seeded = await seedTwoVoices(page, 3)

  // 3 场 × 4 拍（每场两位角色各 2 拍），覆盖 3 个场景的指标。
  for (const sceneId of seeded.sceneIds) {
    for (const ord of [1, 2, 3, 4]) {
      await generateAndConfirm(page, seeded.chapterId, { sceneId, ord })
    }
  }
  for (const sceneId of seeded.sceneIds) {
    const voice = await readVoice(page, sceneId)
    expect(voice.found).toBe(true)
    expect(voice.pairs).toBe(1)
  }

  const created = await page.evaluate(async (id) => {
    const closed = await window.noryth!.world.createForeshadow({
      text: '匣子底部的记号',
      plantedChapterId: id,
      plannedPayoffChapterId: id
    })
    if (!closed.ok) return { ok: false as const, code: closed.error.code }
    const open = await window.noryth!.world.createForeshadow({
      text: '祠堂梁上的霉',
      plantedChapterId: id,
      plannedPayoffChapterId: id
    })
    if (!open.ok) return { ok: false as const, code: open.error.code }
    const payoff = await window.noryth!.world.closeForeshadow({
      foreshadowId: closed.data.item!.id,
      payoffChapterId: id
    })
    return { ok: payoff.ok as boolean }
  }, seeded.chapterId)
  expect(created.ok).toBe(true)

  const raw = execFileSync(process.execPath, ['scripts/m2-baseline.mjs', project.path], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  console.warn('[E2E-M2-METRICS-01] baseline =', raw.trim())
  const baseline = JSON.parse(raw) as {
    voice: {
      threshold: { version: string; distinctnessMin: number }
      scenes: number
      pairs: number
      belowThreshold: number
      minPair: { a: string; b: string; score: number } | null
      sameCharacterFalseAlarm: number
      differentCharacterDetection: number
    }
    foreshadow: { planted: number; closed: number; open: number; payoffRate: number; overdue: number }
  }

  expect(baseline.voice.threshold.version).toBe('zh-v1')
  expect(baseline.voice.scenes).toBeGreaterThan(0)
  expect(baseline.voice.pairs).toBeGreaterThan(0)
  expect(baseline.voice.minPair).not.toBeNull()
  expect(baseline.voice.minPair!.score).toBeLessThanOrEqual(1)
  expect(baseline.voice.sameCharacterFalseAlarm).toBeLessThanOrEqual(0.05)
  expect(baseline.voice.differentCharacterDetection).toBeGreaterThanOrEqual(0.8)
  expect(baseline.foreshadow.planted).toBe(2)
  expect(baseline.foreshadow.closed).toBe(1)
  expect(baseline.foreshadow.open).toBe(1)
  expect(baseline.foreshadow.payoffRate).toBeGreaterThan(0)
  expect(baseline.foreshadow.payoffRate).toBeLessThanOrEqual(1)
  expect(baseline.foreshadow.overdue).toBeGreaterThanOrEqual(0)
})
