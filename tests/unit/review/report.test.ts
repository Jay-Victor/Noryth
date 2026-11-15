import { afterEach, describe, expect, it } from 'vitest'
import {
  dimensionsForBlocking,
  dimensionsForIssueTypes,
  DIMENSION_KEYS,
  normalizeReport,
  parseDimensions,
  verdictOf
} from '../../../src/shared/schema/report'
import { submitPlainReport, submitReport } from '../../../src/main/review/report'
import { openWriteWorld, type WriteTestWorld } from '../../support/write-world'

/**
 * 报告契约（PHASE-08 §5.1 / §6）：
 * - 阻断缺 beat / 缺 evidence / 缺 why → 降级为建议；
 * - 建议类类型即使被标成 blocking 也降级；
 * - verdict 由条目反推，模型不能空口给 pass 或 fail；
 * - 落库前再校验「拍存在 + evidence 是正文子串」；
 * - schema 失败 → 纯文本报告 + degraded。
 */

const worlds: WriteTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): WriteTestWorld {
  const created = openWriteWorld({ sceneCount: 1, beatsPerScene: 3 })
  worlds.push(created)
  return created
}

function sealBody(w: WriteTestWorld, text: string): string {
  // 直接把第一拍的正文写成固定文本：report 的 evidence 子串校验依赖它。
  const beat = w.repos.beat.listLiveByChapter(w.chapterId).find((item) => item.body.trim().length === 0)!
  w.handle.db
    .prepare('UPDATE beat SET body = ? WHERE id = ?')
    .run(text, beat.id)
  return beat.id
}

describe('normalizeReport', () => {
  it('阻断必须同时有 beat 与证据；缺一个就降级', () => {
    const report = normalizeReport({
      verdict: 'fail',
      blocking: [
        { type: 'knowledge_leak', beat_id: 'bt_1', evidence: '她说账本在祠堂', why: '越界' },
        { type: 'outline_conflict', beat_id: '', evidence: '有证据但没拍', why: '越界' },
        { type: 'timeline', beat_id: 'bt_2', evidence: '', why: '没有证据' },
        { type: 'continuity', beat_id: 'bt_3', evidence: '有证据', why: '' }
      ],
      suggestions: []
    })
    expect(report.blocking).toHaveLength(1)
    expect(report.blocking[0]!.issue_id).toBe('iss_01')
    expect(report.suggestions.map((issue) => issue.downgraded)).toEqual([
      'missing_beat',
      'missing_evidence',
      'missing_why'
    ])
    expect(report.verdict).toBe('fail')
  })

  it('建议类类型不能阻断；verdict 由条目反推', () => {
    const asBlocking = normalizeReport({
      verdict: 'pass',
      blocking: [{ type: 'prose', beat_id: 'bt_1', evidence: '写得不好', why: '文笔' }],
      suggestions: []
    })
    expect(asBlocking.blocking).toHaveLength(0)
    expect(asBlocking.suggestions).toHaveLength(1)
    expect(asBlocking.suggestions[0]!.downgraded).toBe('advisory_type')
    expect(asBlocking.verdict).toBe('pass_with_notes')

    const empty = normalizeReport({ verdict: 'fail', blocking: [], suggestions: [] })
    expect(empty.verdict).toBe('pass')

    const notes = normalizeReport({
      verdict: 'pass',
      blocking: [],
      suggestions: [{ type: 'pacing', why: '节奏慢' }]
    })
    expect(notes.verdict).toBe('pass_with_notes')
  })

  it('issue_id 非法时重编号且不重复；重复条目去重', () => {
    const report = normalizeReport({
      verdict: 'fail',
      blocking: [
        { issue_id: 'bad id!', type: 'knowledge_leak', beat_id: 'bt_1', evidence: 'a', why: 'w' },
        { issue_id: 'bad id!', type: 'timeline', beat_id: 'bt_2', evidence: 'b', why: 'w' },
        { issue_id: 'iss_ok', type: 'knowledge_leak', beat_id: 'bt_1', evidence: 'a', why: 'w' }
      ],
      suggestions: []
    })
    const ids = report.blocking.map((issue) => issue.issue_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['iss_01', 'iss_02'])
    // 第三条与第一条同 type/beat/evidence → 去重（保留首次出现的编号）
    expect(report.blocking.filter((issue) => issue.type === 'knowledge_leak')).toHaveLength(1)
  })

  it('维度分只接收 1–5 的四个已知键', () => {
    expect(parseDimensions({ character_consistency: 4, plot_logic: 9, prose: 0, unknown: 3 })).toEqual({
      character_consistency: 4,
      plot_logic: null,
      outline_alignment: null,
      prose: null
    })
  })

  it('复检维度映射覆盖 DEV-PLAN §9.7；未分类 → 全维度', () => {
    expect(dimensionsForIssueTypes(['knowledge_leak'])).toEqual(['character_consistency', 'plot_logic'])
    expect(dimensionsForIssueTypes(['outline_conflict', 'missing_event'])).toEqual(['outline_alignment'])
    expect(dimensionsForIssueTypes(['voice'])).toEqual(['prose'])
    expect(dimensionsForIssueTypes(['other'])).toEqual([...DIMENSION_KEYS])
    expect(dimensionsForBlocking([])).toEqual([...DIMENSION_KEYS])
  })

  it('verdictOf 不信 verdict，只看条目', () => {
    const issue = {
      issue_id: 'iss_01',
      type: 'knowledge_leak' as const,
      beat_id: 'bt_1',
      evidence: 'x',
      why: 'y',
      suggestion: '',
      downgraded: null
    }
    expect(verdictOf([issue], [])).toBe('fail')
    expect(verdictOf([], [issue])).toBe('pass_with_notes')
    expect(verdictOf([], [])).toBe('pass')
  })
})

describe('submitReport（落库校验）', () => {
  it('拍不存在或证据不是正文子串 → 降级为建议', () => {
    const w = world()
    const body = '她把茶盏往他那边推了推，声音压得很低。'
    const beatId = sealBody(w, body)
    const result = submitReport(w.repos, {
      projectId: w.projectId,
      chapterId: w.chapterId,
      revisionId: w.repos.chapter.get(w.chapterId)!.currentRevisionId!,
      draft: {
        verdict: 'fail',
        blocking: [
          { type: 'knowledge_leak', beat_id: beatId, evidence: '「我爹书房里那只黑漆匣子」', why: '越界' },
          { type: 'timeline', beat_id: 'bt_missing', evidence: '有证据', why: '时间线' },
          { type: 'outline_conflict', beat_id: beatId, evidence: body.slice(0, 12), why: '章纲' }
        ],
        suggestions: []
      }
    })
    expect(result.downgraded).toBe(2)
    expect(result.report.verdict).toBe('fail')
    const blocking = JSON.parse(result.report.blockingJson) as Array<{ beat_id: string }>
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.beat_id).toBe(beatId)
    const suggestions = JSON.parse(result.report.suggestionsJson) as Array<{ downgraded: string }>
    expect(suggestions.map((item) => item.downgraded).sort()).toEqual(['evidence_not_found', 'unknown_beat'])
  })

  it('已定稿的章不能再出报告', () => {
    const w = world()
    const chapter = w.repos.chapter.get(w.chapterId)!
    w.repos.chapter.markFinalized(w.chapterId, chapter.currentRevisionId!)
    expect(() =>
      submitReport(w.repos, {
        projectId: w.projectId,
        chapterId: w.chapterId,
        revisionId: chapter.currentRevisionId!,
        draft: { verdict: 'pass', blocking: [], suggestions: [] }
      })
    ).toThrowError(/已定稿/)
  })

  it('schema 失败 → 纯文本报告 + degraded，仍能落库', () => {
    const w = world()
    const chapter = w.repos.chapter.get(w.chapterId)!
    const result = submitPlainReport(w.repos, {
      projectId: w.projectId,
      chapterId: w.chapterId,
      revisionId: chapter.currentRevisionId!,
      text: '这一章整体可用，但第 3 拍的对白信息量过大。'
    })
    expect(result.report.verdict).toBe('fail')
    expect(result.report.degraded).toBe('schema_fallback')
    expect(result.report.round).toBe(1)
    const suggestions = JSON.parse(result.report.suggestionsJson) as Array<{ suggestion: string }>
    expect(suggestions[0]!.suggestion).toContain('对白信息量过大')
  })
})
