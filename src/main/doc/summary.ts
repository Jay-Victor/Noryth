import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { ChapterSummaryEntry } from '../db/repos/chapter-summary'
import { estimateTokens, truncateToTokens } from '../context/tokens'

/**
 * 章末摘要（PHASE-16 §5.4 / M1-13）。
 *
 * 抽取式，不调模型、不产生 revision、不参与 content_hash：
 *   - 首拍正文 + 末拍正文（同一拍只取一次）；
 *   - 本章新出现的客观公开事实 ≤5 条（作者与记忆写入都算）；
 *   - 合计 ≤300 tokens（超了先截摘要正文，不截关键事实）。
 *
 * 写入点在 `finalizeChapter` 的同一事务：摘要与 final 快照同生共死。
 * 重开再定稿会写一份新摘要，旧 final 的摘要保留（按 revision_id 主键）。
 */

export const SUMMARY_MAX_TOKENS = 300
export const SUMMARY_TRIM_TOKENS = 150
export const SUMMARY_KEY_FACT_LIMIT = 5

export interface ChapterSummaryDraft {
  summary: string
  keyFacts: string[]
  tokens: number
}

function bodyLines(repos: Repos, revisionId: string): string[] {
  return repos.revision
    .manifest(revisionId)
    .map((member) => member.body.trim())
    .filter((body) => body.length > 0)
}

function previousChapterOf(repos: Repos, chapter: ChapterRecord): ChapterRecord | null {
  return (
    repos.chapter
      .listByProject(chapter.projectId)
      .filter((item) => item.ord < chapter.ord)
      .sort((left, right) => right.ord - left.ord)[0] ?? null
  )
}

/** 本章新出现的客观公开事实：valid_from_seq 落在上一章水位之后、本章水位之内。 */
function keyFactsOf(repos: Repos, chapter: ChapterRecord): string[] {
  const previous = previousChapterOf(repos, chapter)
  const startExclusive = previous ? Math.max(0, previous.coveredUntilSeq) : 0
  const end = Math.max(0, chapter.coveredUntilSeq)
  return repos.world
    .listByProject(chapter.projectId)
    .filter((fact) => {
      if (fact.truth !== 'objective' || fact.visibility !== 'public') return false
      if (fact.validToSeq !== null) return false
      return fact.validFromSeq > startExclusive && fact.validFromSeq <= end
    })
    .sort((left, right) => left.validFromSeq - right.validFromSeq || left.id.localeCompare(right.id))
    .slice(0, SUMMARY_KEY_FACT_LIMIT)
    .map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`)
}

export function buildChapterSummary(
  repos: Repos,
  input: { chapterId: string; revisionId: string }
): ChapterSummaryDraft {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new Error(`chapter ${input.chapterId} not found`)
  const bodies = bodyLines(repos, input.revisionId)
  const keyFacts = keyFactsOf(repos, chapter)
  const factsText = keyFacts.length > 0 ? `关键事实：${keyFacts.join('；')}` : ''
  const factsTokens = factsText.length > 0 ? estimateTokens(factsText) : 0

  let headTail = ''
  if (bodies.length > 0) {
    const first = bodies[0]!
    const last = bodies[bodies.length - 1]!
    headTail = first === last ? first : `${first}……${last}`
  }

  // 先给关键事实留位置，再截摘要正文；两段合计不超过 300 tokens。
  const summaryCap = Math.max(60, SUMMARY_MAX_TOKENS - factsTokens)
  const summary = truncateToTokens(headTail, summaryCap)
  const text = factsText.length > 0 ? `${summary}\n${factsText}` : summary
  return { summary, keyFacts, tokens: estimateTokens(text) }
}

/**
 * 定稿同事务写入。同一 revision 重放返回已有行，不双写。
 * 摘要为空（整章没有正文）时不写——finalize 本身已经拒绝空清单。
 */
export function writeChapterSummary(
  repos: Repos,
  input: { projectId: string; chapterId: string; revisionId: string; createdAt?: string }
): ChapterSummaryEntry | null {
  const existing = repos.chapterSummary.get(input.revisionId)
  if (existing) return existing
  const draft = buildChapterSummary(repos, input)
  if (draft.tokens === 0) return null
  return repos.chapterSummary.insert({
    revisionId: input.revisionId,
    chapterId: input.chapterId,
    projectId: input.projectId,
    summary: draft.summary,
    keyFacts: draft.keyFacts,
    tokens: draft.tokens,
    source: 'extractive',
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
  })
}

/** 装配用：把摘要行展开成 L0 文本（不含章标题，标题由调用方加）。 */
export function summaryText(entry: ChapterSummaryEntry): string {
  const facts = parseKeyFacts(entry.keyFactsJson)
  return facts.length > 0 ? `${entry.summary}\n关键事实：${facts.join('；')}` : entry.summary
}

export function parseKeyFacts(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
