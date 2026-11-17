import type { ElectronApplication, Page } from '@playwright/test'

/**
 * M1 长跑脚手架（PHASE-18 §5.2）：一章的完整闭环。
 *
 * 每一步都只用产品自身的 IPC 入口（等价 UI 按钮），不直接写库：
 *   G2 → 逐拍 2 拍 → 自动跑完 → G4 → G5 → patch 2 接受 1 拒绝 → 复检
 *   → G6 定稿 → G7 抽取 + 全部接受 + 应用。
 *
 * E2E-M1-SMOKE（3 章，提交门）与 E2E-M1-A（30 章，nightly）共用。
 */

export interface ChapterStepResult {
  chapterId: string
  ord: number
  reportVerdict: string
  patches: number
  accepted: number
  memoryApplied: number
}

/** 取章列表（按 ord）。 */
export async function listChapters(page: Page): Promise<Array<{ id: string; ord: number; status: string }>> {
  return page.evaluate(async () => {
    const state = await window.noryth!.write.state()
    if (!state.ok) return []
    return state.data.chapters.map((chapter) => ({
      id: chapter.id,
      ord: chapter.ord,
      status: chapter.status
    }))
  })
}

/** 逐拍：生成一拍并确认（返回确认的拍 id）。 */
async function generateAndConfirmBeat(page: Page, chapterId: string): Promise<string> {
  // 生成会 supersede 槽位现行拍（含 proposed 占位），所以确认前要按
  // (sceneId, ord) 重新取当前行的 id，不能拿生成前的 id。
  const slot = await page.evaluate(async (id) => {
    const state = await window.noryth!.write.state(id)
    if (!state.ok) return null
    const beats = state.data.scenes.flatMap((scene) => scene.beats)
    const next = beats.find((beat) => beat.status === 'proposed') ?? beats.find((beat) => beat.status === 'draft')
    return next === undefined ? null : { beatId: next.id, sceneId: next.sceneId, ord: next.ord }
  }, chapterId)
  if (slot === null) throw new Error(`chapter ${chapterId} has no proposed beat`)
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
  if (liveId === null) throw new Error(`generated beat not waiting for human (ch ${chapterId})`)
  const confirmed = await page.evaluate(async (id) => window.noryth!.write.confirm(id), liveId)
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`)
  return liveId
}

async function waitDraftComplete(page: Page, chapterId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await page.evaluate(async (id) => {
      const state = await window.noryth!.write.state(id)
      return state.ok ? state.data.chapterStatus : ''
    }, chapterId)
    if (status === 'draft_complete') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`chapter ${chapterId} did not reach draft_complete`)
}

/** 审批闭环：G4 → G5 → 2 接受 1 拒绝 → 复检 → G6。 */
async function reviewAndFinalize(page: Page, chapterId: string): Promise<{ verdict: string; patches: number; accepted: number }> {
  const report = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.run(id)
    return result.ok ? { verdict: result.data.state.report?.verdict ?? null } : { verdict: null }
  }, chapterId)
  if (report.verdict === null) throw new Error(`review run failed for ${chapterId}`)

  const authorized = await page.evaluate(async (id) => window.noryth!.review.authorizeRevision(id), chapterId)
  if (!authorized.ok) throw new Error(`G5 failed: ${authorized.error.code}`)
  const patches = authorized.data.state.patches.filter((patch) => patch.status === 'proposed')
  if (patches.length === 0) throw new Error(`no patch proposals for ${chapterId}`)

  const decisions = patches.map((patch, index) => ({
    patchId: patch.id,
    // 2 接受 1 拒绝（假审批固定 3 条）；更多 patch 时默认接受。
    accept: index < 2 || patches.length <= 2
  }))
  const decided = await page.evaluate(
    async ({ chapterId: id, expectedRevision, decisions: payload }) =>
      window.noryth!.review.decide({ chapterId: id, expectedRevision, decisions: payload }),
    {
      chapterId,
      expectedRevision: authorized.data.state.revisionId,
      decisions
    }
  )
  if (!decided.ok) throw new Error(`patch decide failed: ${decided.error.code}`)

  const rechecked = await page.evaluate(async (id) => window.noryth!.review.recheck(id), chapterId)
  if (!rechecked.ok) throw new Error(`recheck failed: ${rechecked.error.code}`)

  const preview = await page.evaluate(async (id) => {
    const result = await window.noryth!.review.finalizePreview(id)
    return result.ok ? result.data : null
  }, chapterId)
  if (preview === null) throw new Error(`finalize preview failed for ${chapterId}`)

  const issued = await page.evaluate(async (id) => window.noryth!.review.issueFinalizeToken(id), chapterId)
  if (!issued.ok) throw new Error(`G6 issue failed: ${issued.error.code}`)
  const finalized = await page.evaluate(
    async ({ chapterId: id, token, ackBlocking, ackUnreviewed }) =>
      window.noryth!.review.finalize({ chapterId: id, token, ackBlocking, ackUnreviewed }),
    {
      chapterId,
      token: issued.data.token,
      ackBlocking: preview.blocking.length > 0,
      ackUnreviewed: preview.unreviewedCount > 0
    }
  )
  if (!finalized.ok) throw new Error(`finalize failed: ${finalized.error.code}`)
  const status = finalized.data.state.chapterStatus
  if (status !== 'finalized') throw new Error(`chapter ${chapterId} not finalized (${status})`)
  return {
    verdict: report.verdict,
    patches: patches.length,
    accepted: decisions.filter((decision) => decision.accept).length
  }
}

/** 记忆闭环：抽取 → 全部接受 → G7 应用。 */
async function extractAndApplyMemory(page: Page, chapterId: string): Promise<number> {
  const extracted = await page.evaluate(async (id) => window.noryth!.memory.extract(id), chapterId)
  if (!extracted.ok) throw new Error(`memory extract failed: ${extracted.error.code}`)
  const proposals = extracted.data.state.proposals
  if (proposals.length === 0) return 0
  const decided = await page.evaluate(
    async (decisions) => window.noryth!.memory.decideMany({ decisions }),
    proposals.map((proposal) => ({ itemId: proposal.id, decision: 'accept' as const }))
  )
  if (!decided.ok) throw new Error(`memory decide failed: ${decided.error.code}`)
  const issued = await page.evaluate(async (id) => window.noryth!.memory.issueG7Token(id), chapterId)
  if (!issued.ok) throw new Error(`G7 issue failed: ${issued.error.code}`)
  const applied = await page.evaluate(
    async ({ chapterId: id, token }) => window.noryth!.memory.apply({ chapterId: id, token }),
    { chapterId, token: issued.data.token }
  )
  if (!applied.ok) throw new Error(`memory apply failed: ${applied.error.code} ${applied.error.message}`)
  return applied.data.state.entries.filter((entry) => entry.sourceChapterId === chapterId).length
}

/** 一整章：G2 → 2 拍 → 自动 → 审批定稿 → 记忆固化。 */
export async function runChapter(page: Page, chapter: { id: string; ord: number }): Promise<ChapterStepResult> {
  const g2 = await page.evaluate(async (id) => window.noryth!.write.confirmG2(id), chapter.id)
  if (!g2.ok) throw new Error(`G2 failed for ch${chapter.ord}: ${g2.error.code}`)

  await generateAndConfirmBeat(page, chapter.id)
  await generateAndConfirmBeat(page, chapter.id)

  const auto = await page.evaluate(async (id) => window.noryth!.write.autoStart(id), chapter.id)
  if (!auto.ok) throw new Error(`auto start failed for ch${chapter.ord}: ${auto.error.code}`)
  await waitDraftComplete(page, chapter.id)

  const review = await reviewAndFinalize(page, chapter.id)
  const memoryApplied = await extractAndApplyMemory(page, chapter.id)
  return { chapterId: chapter.id, ord: chapter.ord, reportVerdict: review.verdict, patches: review.patches, accepted: review.accepted, memoryApplied }
}

/** 只读 DB 校验（dev 通道）；返回 error 级问题。 */
export async function verifyProject(page: Page): Promise<{ ok: boolean; errors: string[] }> {
  return page.evaluate(async () => {
    const result = await window.noryth!.project.verify()
    if (!result.ok) return { ok: false, errors: [`verify ipc: ${result.error.code}`] }
    return {
      ok: result.data.ok,
      errors: result.data.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.code}: ${issue.message}`)
    }
  })
}

/** 主进程 + 渲染进程 + GPU 的 working set 与私有字节（MB）。 */
export async function memoryMb(
  page: Page,
  app: ElectronApplication
): Promise<{ workingSet: number; privateBytes: number; processes: Array<{ type: string; ws: number; priv: number }> }> {
  const metrics = await app.evaluate(async ({ app: electronApp }) => electronApp.getAppMetrics())
  const processes = metrics.map((metric) => ({
    type: metric.type,
    ws: Math.round((metric.memory?.workingSetSize ?? 0) / 1024),
    priv: Math.round((metric.memory?.privateBytes ?? 0) / 1024)
  }))
  // 至少确认渲染进程已被计入（否则数字没有意义）。
  const renderer = await page.evaluate(() => document.title)
  if (renderer.length === 0) throw new Error('renderer not alive')
  return {
    workingSet: processes.reduce((sum, entry) => sum + entry.ws, 0),
    privateBytes: processes.reduce((sum, entry) => sum + entry.priv, 0),
    processes
  }
}

/** 兼容旧调用：只取 working set 合计。 */
export async function workingSetMb(page: Page, app: ElectronApplication): Promise<number> {
  return (await memoryMb(page, app)).workingSet
}
