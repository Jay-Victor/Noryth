import { afterEach, describe, expect, it } from 'vitest'
import type { ChatAdapter } from '../../src/main/model/adapter'
import { runReviewTurn } from '../../src/main/review/run'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { AppError, isAppError } from '../../src/shared/domain/app-error'
import { sameText } from '../../src/shared/text/normalize'
import { DIMENSION_KEYS } from '../../src/shared/schema/report'
import { verifyDatabase } from '../../src/main/db/verify'
import { editBeat } from '../../src/main/doc/beats'
import { openReviewWorld, type ReviewTestWorld } from '../support/review-world'

/**
 * 阶段 08 集成验收（PHASE-08 §6 / E2E-REVIEW-01 的主链路）：
 *   draft_complete → 报告 fail（2 阻断 / 3 建议）→ G5 → 3 条 patch
 *   → 接受 2 拒绝 1 → 新 revision → 复检 → G6 定稿。
 *
 * 另外三条硬约束各一测：
 *   - 讨论阶段 DB 不变；
 *   - patch 的 before 与当前正文不匹配 → patch_conflict，原文不变；
 *   - 3 轮上限 → 转人工，G5 关闭，G6 仍可执行。
 */

const worlds: ReviewTestWorld[] = []

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.world.cleanup()
})

function harness(): ReviewTestWorld {
  const created = openReviewWorld()
  worlds.push(created)
  return created
}

describe('E2E-REVIEW-01（集成）：报告 → patch → 复检 → 定稿', () => {
  it('2 阻断 3 建议 → 接受 2 拒绝 1 → 新 revision → 复检 → G6', async () => {
    const { world, service } = harness()
    const chapterId = world.chapterId

    // ── G4 ──
    await service.run(chapterId)
    let state = service.state(chapterId)
    expect(state.report).not.toBeNull()
    const report = state.report!
    expect(report.verdict).toBe('fail')
    expect(report.blocking).toHaveLength(2)
    expect(report.suggestions).toHaveLength(3)
    expect(state.chapterStatus).toBe('under_review')
    expect(state.hasReport).toBe(true)

    // 每条阻断都必须有 beat 与证据原文，且证据真的是该拍正文的子串。
    for (const issue of report.blocking) {
      expect(issue.beat_id.length).toBeGreaterThan(0)
      expect(issue.evidence.length).toBeGreaterThan(0)
      const beat = world.repos.beat.get(issue.beat_id)!
      expect(sameText(beat.body, beat.body)).toBe(true)
      expect(beat.body.includes(issue.evidence)).toBe(true)
    }
    expect(report.dimensions.plot_logic).toBe(2)
    expect(state.reports).toHaveLength(1)
    // 假模型先跑 consistency.check 再交报告：不是降级报告。
    expect(report.degraded).toBeNull()

    // ── 讨论：不改稿，不产生新 revision ──
    const revisionBefore = state.revisionId
    const sent = await service.send(chapterId, '第 1 条阻断具体是哪句？')
    expect(sent.reply.length).toBeGreaterThan(0)
    expect(sent.state.revisionId).toBe(revisionBefore)
    expect(sent.state.reports).toHaveLength(1)

    // ── G5 → 3 条 patch ──
    const g5 = await service.authorizeRevision(chapterId)
    state = g5.state
    expect(state.chapterStatus).toBe('revising')
    expect(state.patches).toHaveLength(3)
    expect(state.patches.every((patch) => patch.status === 'proposed')).toBe(true)
    for (const patch of state.patches) {
      const beat = world.repos.beat.get(patch.beatId)!
      expect(sameText(beat.body, patch.before)).toBe(true)
      expect(patch.after).not.toBe(patch.before)
    }

    // ── 接受 2 拒绝 1 ──
    const [first, second, third] = state.patches
    const decided = service.decide({
      chapterId,
      expectedRevision: state.revisionId,
      decisions: [
        { patchId: first!.id, accept: true },
        { patchId: second!.id, accept: true },
        { patchId: third!.id, accept: false }
      ]
    })
    state = decided.state
    expect(state.patches.filter((patch) => patch.status === 'applied')).toHaveLength(2)
    expect(state.patches.filter((patch) => patch.status === 'rejected')).toHaveLength(1)
    expect(state.revisionId).not.toBe(revisionBefore)
    const appliedRevision = state.versions.find((version) => version.id === state.revisionId)!
    expect(appliedRevision.contentHash.length).toBe(64)
    expect(state.g6.unreviewedCount).toBeGreaterThan(0)

    // ── 复检（只跑受影响维度）──
    const rechecked = await service.recheck(chapterId)
    state = rechecked.state
    expect(state.reports).toHaveLength(2)
    expect(state.reports[1]!.scope.length).toBeGreaterThan(0)
    expect(state.reports[1]!.scope.length).toBeLessThan(DIMENSION_KEYS.length)
    expect(state.reports[1]!.verdict).not.toBe('fail')
    expect(state.chapterStatus).toBe('approved')
    expect(state.g6.unreviewedCount).toBe(0)

    // ── G6 定稿 ──
    const issued = service.issueFinalizeToken(chapterId)
    expect(issued.token.length).toBeGreaterThan(0)
    const finalized = service.finalize({
      chapterId,
      token: issued.token,
      ackBlocking: true,
      ackUnreviewed: false
    })
    state = finalized.state
    expect(state.chapterStatus).toBe('finalized')
    expect(state.finalRevisionId).not.toBeNull()

    const finalRevision = world.repos.revision.get(state.finalRevisionId!)!
    expect(finalRevision.kind).toBe('final')
    expect(finalRevision.createdBy).toBe('author')
    expect(world.repos.revision.countMembers(finalRevision.id)).toBe(4)

    const gateRecords = world.repos.gate.listByEntity('chapter', chapterId).filter((record) => record.gateId === 'G6')
    expect(gateRecords).toHaveLength(1)
    expect(gateRecords[0]!.consumedAt).not.toBeNull()
    expect(JSON.parse(gateRecords[0]!.payloadJson)).toMatchObject({ finalRevisionId: finalRevision.id })

    const memoryJobs = world.repos.job.listByStatus(world.repos.project.get()!.id, 'queued')
    expect(memoryJobs.some((job) => job.type === 'memory.extract')).toBe(true)

    // ── 定稿后写正文被拒 ──
    const beat = world.repos.beat.listLiveByChapter(chapterId)[0]!
    expect(() =>
      editBeat(world.handle.db, world.repos, {
        beatId: beat.id,
        body: '定稿后不该写进去的正文',
        expectedRevision: state.revisionId
      })
    ).toThrowError(AppError)
    try {
      editBeat(world.handle.db, world.repos, {
        beatId: beat.id,
        body: '定稿后不该写进去的正文',
        expectedRevision: state.revisionId
      })
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('already_finalized')
    }

    const verify = verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
    expect(verify.ok, JSON.stringify(verify.issues)).toBe(true)
  })

  it('没有跑 consistency.check 的 pass 报告 → degraded=check_missing（PRD §5.3）', async () => {
    const { world } = harness()
    const adapter: ChatAdapter = {
      provider: 'deepseek',
      model: 'deepseek-flash',
      async probe() {
        return {
          stream: true,
          tools: true,
          jsonMode: true,
          contextWindow: 32_000,
          maxOutput: 4_096,
          pricing: { in: 0, out: 0 }
        }
      },
      async stream(_request: Parameters<ChatAdapter['stream']>[0], hooks: Parameters<ChatAdapter['stream']>[1]) {
        const text = JSON.stringify({ verdict: 'pass', blocking: [], suggestions: [] })
        hooks.onText?.(text, text)
        return {
          text,
          reasoning: '',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 20 },
          finishReason: 'stop',
          model: 'deepseek-flash',
          latencyMs: 1,
          firstTokenMs: 1,
          retries: 0
        }
      }
    }
    const outcome = await runReviewTurn(
      {
        db: world.handle.db,
        repos: world.repos,
        registry: buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' }),
        adapter,
        gateSecret: 'integration-review-gate'
      },
      { chapterId: world.chapterId, messageId: 'msg_stub', mode: 'report', jobId: 'job_stub' }
    )
    expect(outcome.reportId).not.toBeNull()
    const record = world.repos.review.getReport(outcome.reportId!)!
    expect(record.verdict).toBe('pass')
    expect(record.degraded).toBe('check_missing')
  })

  it('patch 的 before 与当前正文不匹配 → patch_conflict，原文与 revision 不变', async () => {
    const { world, service } = harness()
    const chapterId = world.chapterId
    await service.run(chapterId)
    const patches = (await service.authorizeRevision(chapterId)).state.patches
    expect(patches).toHaveLength(3)

    // 作者先手改了第一条 patch 指向的拍：base revision 变了，旧提案不能再套用。
    const target = patches.find((patch) => patch.issueRef === 'iss_01') ?? patches[0]!
    const beat = world.repos.beat.get(target.beatId)!
    const stateBefore = service.state(chapterId)
    editBeat(world.handle.db, world.repos, {
      beatId: beat.id,
      body: `${beat.body}（作者手改）`,
      expectedRevision: stateBefore.revisionId
    })
    const afterEdit = service.state(chapterId)
    expect(afterEdit.revisionId).not.toBe(stateBefore.revisionId)
    expect(afterEdit.patches.find((patch) => patch.id === target.id)!.status).toBe('superseded')

    let stale: AppError | null = null
    try {
      service.decide({
        chapterId,
        expectedRevision: afterEdit.revisionId,
        decisions: [{ patchId: target.id, accept: true }]
      })
    } catch (error) {
      stale = isAppError(error) ? error : null
    }
    expect(stale?.code).toBe('stale_revision')

    // 同一 revision 内 before 不一致（外部改库/坏数据）→ patch_conflict，不套用。
    const current = service.state(chapterId)
    const currentBeat = world.repos.beat.listLiveByChapter(chapterId)[0]!
    const corrupted = world.repos.patch.insert({
      projectId: world.repos.project.get()!.id,
      proposalId: 'prop_corrupt',
      revisionId: current.revisionId!,
      beatId: currentBeat.id,
      before: '这段文字与当前正文不一致',
      after: '不应该被写进去的正文',
      reason: '坏数据用例',
      issueRef: 'iss_99'
    })
    let conflict: AppError | null = null
    try {
      service.decide({
        chapterId,
        expectedRevision: current.revisionId,
        decisions: [{ patchId: corrupted.id, accept: true }]
      })
    } catch (error) {
      conflict = isAppError(error) ? error : null
    }
    expect(conflict?.code).toBe('patch_conflict')
    const after = service.state(chapterId)
    expect(after.revisionId).toBe(current.revisionId)
    expect(world.repos.beat.get(currentBeat.id)!.body).toBe(currentBeat.body)
  })

  it('3 轮上限：转人工，G5 关闭，G6 仍可执行', async () => {
    const { world, service } = harness()
    const chapterId = world.chapterId
    await service.run(chapterId)
    await service.run(chapterId)
    const third = await service.run(chapterId)
    const state = third.state
    expect(state.reports).toHaveLength(3)
    expect(state.takeover).toBe(true)
    expect(state.g5.allowed).toBe(false)
    expect(state.g5.reason).toContain('转人工')
    expect(state.g6.ready).toBe(true)

    await expect(service.authorizeRevision(chapterId)).rejects.toMatchObject({ code: 'gate_required' })

    const issued = service.issueFinalizeToken(chapterId)
    const finalized = service.finalize({
      chapterId,
      token: issued.token,
      ackBlocking: true,
      ackUnreviewed: true,
      reason: '3 轮后转人工，作者决定保留'
    })
    expect(finalized.state.chapterStatus).toBe('finalized')
  })
})
