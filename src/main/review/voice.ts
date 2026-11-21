import type { Issue } from '../../shared/schema/report'
import { verdictOf } from '../../shared/schema/report'
import type { Repos } from '../db/repos'
import { resolveSceneVoice } from '../voice/service'

/**
 * 声音漂移告警（PHASE-19 §5.3 / M2-2）。
 *
 * 报告由 T35 / 运行时兜底先落库；声音指标要等 `voice_metric` 算完才知道，
 * 所以这里在回合结束后往**建议**里补一条 `type='voice'` 的条目：
 * - `voice` 不在 `BLOCKING_ISSUE_TYPES`，永远不阻断 G6；
 * - 证据只用指标与角色对，不复制正文；`issue_ref` 指向场景（`beat_id` 为空）；
 * - 同一报告只补一次（已有 voice 建议就跳过），重复跑 G4 不会叠加。
 */

export interface VoiceSuggestionResult {
  appended: number
  belowThreshold: number
}

function lowestPairOf(state: ReturnType<typeof resolveSceneVoice>):
  | { score: number; aName: string; bName: string }
  | null {
  if (state.pairs.length === 0) return null
  return state.pairs.reduce(
    (lowest, pair) => (pair.score < lowest.score ? pair : lowest),
    state.pairs[0]!
  )
}

function voiceIssue(input: {
  sceneOrd: number
  score: number
  thresholdMin: number
  thresholdVersion: string
  aName: string
  bName: string
  existingIds: ReadonlySet<string>
}): Issue {
  let issueId = `iss_voice_s${input.sceneOrd}`
  let suffix = 1
  while (input.existingIds.has(issueId)) {
    suffix += 1
    issueId = `iss_voice_s${input.sceneOrd}_${suffix}`
  }
  const score = (Math.round(input.score * 100) / 100).toFixed(2)
  const threshold = (Math.round(input.thresholdMin * 100) / 100).toFixed(2)
  return {
    issue_id: issueId,
    type: 'voice',
    // 指向场景，不指向拍：声音问题是场景级的。
    beat_id: '',
    evidence: `场景 ${input.sceneOrd} · 区分度 ${score}（阈值 ${threshold}，${input.thresholdVersion}）· ${input.aName} / ${input.bName}`,
    why: '同场两人的句长与口语特征接近，读者可能分不清谁在说话。',
    suggestion: '拉开句长、口头禅或问句习惯的差距；可参考角色卡 voice 字段，或换回统一模型。',
    downgraded: null
  }
}

/**
 * 计算本章各场指标并把低区分度场景追加进报告建议。
 * 失败/空场景只跳过，不影响报告与定稿；`persist` 由调用方按只读态决定。
 */
export function appendVoiceSuggestions(
  repos: Repos,
  input: { chapterId: string; reportId: string; persist: boolean }
): VoiceSuggestionResult {
  const report = repos.review.getReport(input.reportId)
  if (!report) return { appended: 0, belowThreshold: 0 }
  const existing = parseSuggestions(report.suggestionsJson)
  // 只按「运行时追加的条目」判重：模型自己提的声音意见（没有指标证据）保留，
  // 但仍补一条带阈值与角色对的运行时建议。
  if (existing.some((issue) => issue.type === 'voice' && issue.issue_id.startsWith('iss_voice_'))) {
    return { appended: 0, belowThreshold: 0 }
  }

  const usedIds = new Set(existing.map((issue) => issue.issue_id))
  const additions: Issue[] = []
  for (const entry of repos.scene.listByChapter(input.chapterId)) {
    let state: ReturnType<typeof resolveSceneVoice>
    try {
      state = resolveSceneVoice(repos, { sceneId: entry.scene.id }, { persist: input.persist })
    } catch {
      continue
    }
    if (!state.found || state.insufficientData || !state.belowThreshold) continue
    const lowest = lowestPairOf(state)
    if (lowest === null) continue
    const issue = voiceIssue({
      sceneOrd: entry.chapterOrd,
      score: lowest.score,
      thresholdMin: state.threshold.distinctnessMin,
      thresholdVersion: state.threshold.version,
      aName: lowest.aName,
      bName: lowest.bName,
      existingIds: usedIds
    })
    usedIds.add(issue.issue_id)
    additions.push(issue)
  }

  if (additions.length === 0) return { appended: 0, belowThreshold: 0 }
  const suggestions = [...existing, ...additions]
  repos.review.appendSuggestions(
    report.id,
    JSON.stringify(suggestions),
    verdictOf(parseBlocking(report.blockingJson), suggestions)
  )
  return { appended: additions.length, belowThreshold: additions.length }
}

function parseSuggestions(json: string): Issue[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as Issue[]) : []
  } catch {
    return []
  }
}

function parseBlocking(json: string): Issue[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as Issue[]) : []
  } catch {
    return []
  }
}
