import { z } from 'zod'
import { AppError } from '../../../shared/domain/app-error'
import { defineTool } from '../define'
import { validateExitExpr } from '../support/dsl'
import { validateStoryboard, StoryboardDraftSchema } from '../support/storyboard'
import { AUDIT, Id, degradeFor, limitsFor, parseJson, participantIds } from './shared'
import type { ToolServices } from '../types'

/** T24–T30：校验与度量（PRD §4.10.3）。T25/T26/T29 按里程碑开关。 */

const Issue = z.strictObject({
  code: z.string(),
  severity: z.enum(['error', 'warn', 'candidate']),
  message: z.string(),
  beat_id: Id.nullable(),
  ref_id: z.string().nullable()
})

interface IssueRecord {
  code: string
  severity: 'error' | 'warn' | 'candidate'
  message: string
  beat_id: string | null
  ref_id: string | null
}

const consistencyCheck = defineTool({
  toolId: 'T24',
  name: 'consistency.check',
  version: '1.0.0',
  family: 'verify',
  summary: '对 revision 做确定性检查：引用缺失、时间轴、单值槽、出口状态与泄漏候选',
  actors: ['reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ revision_id: Id }),
  output: z.strictObject({ revision_id: Id, issue_count: z.number().int(), issues: z.array(Issue) }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const revision = services.repos.revision.get(args.revision_id)
    if (!revision) throw new AppError('stale_revision', 'revision not found')
    const chapter = services.repos.chapter.get(revision.chapterId)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('stale_revision', 'revision not in project')
    }

    const issues: IssueRecord[] = []
    const rows = services.repos.revision.manifest(revision.id)
    let lastSeq = Number.NEGATIVE_INFINITY

    for (const row of rows) {
      const beat = services.repos.beat.get(row.beatId)
      if (!beat) {
        issues.push({
          code: 'beat_missing',
          severity: 'error',
          message: `清单引用的拍 ${row.beatId} 不存在`,
          beat_id: row.beatId,
          ref_id: null
        })
        continue
      }

      if (beat.seq === null) {
        issues.push({
          code: 'seq_missing',
          severity: 'error',
          message: '拍没有叙事序',
          beat_id: beat.id,
          ref_id: null
        })
      } else {
        if (beat.seq < lastSeq) {
          issues.push({
            code: 'timeline_non_monotonic',
            severity: 'error',
            message: `叙事序 ${beat.seq} 小于上一拍 ${lastSeq}`,
            beat_id: beat.id,
            ref_id: null
          })
        }
        lastSeq = beat.seq
      }

      if (row.body.trim().length === 0) {
        issues.push({
          code: 'empty_body',
          severity: 'warn',
          message: '拍正文为空',
          beat_id: beat.id,
          ref_id: null
        })
      } else if (beat.maxWords !== null && [...row.body].length > beat.maxWords) {
        issues.push({
          code: 'over_max_words',
          severity: 'warn',
          message: `正文 ${[...row.body].length} 字超过上限 ${beat.maxWords}`,
          beat_id: beat.id,
          ref_id: null
        })
      }

      const scene = services.repos.scene.get(row.sceneId)
      if (!scene) {
        issues.push({
          code: 'scene_missing',
          severity: 'error',
          message: `拍所属场景 ${row.sceneId} 不存在`,
          beat_id: beat.id,
          ref_id: null
        })
      } else if (
        row.speakerType === 'character' &&
        !participantIds(scene.participantsJson).includes(row.speakerId)
      ) {
        issues.push({
          code: 'speaker_not_in_scene',
          severity: 'warn',
          message: `角色 ${row.speakerId} 不在本场在场者中`,
          beat_id: beat.id,
          ref_id: null
        })
      }

      const grounding = parseJson<Array<{ type?: unknown; id?: unknown; quote?: unknown }>>(beat.groundingJson, [])
      for (const ref of grounding) {
        if (typeof ref.type !== 'string' || typeof ref.id !== 'string') continue
        const exists = referenceExists(services, ref.type, ref.id)
        if (!exists) {
          issues.push({
            code: 'reference_missing',
            severity: 'error',
            message: `依据 ${ref.type}:${ref.id} 不存在`,
            beat_id: beat.id,
            ref_id: `${ref.type}:${ref.id}`
          })
          continue
        }
        if (typeof ref.quote === 'string' && ref.quote.length > 0) {
          const source = referenceQuote(services, ref.type, ref.id)
          if (source !== null && !normalize(source).includes(normalize(ref.quote))) {
            issues.push({
              code: 'quote_mismatch',
              severity: 'candidate',
              message: `依据引文与 ${ref.type}:${ref.id} 原文不一致`,
              beat_id: beat.id,
              ref_id: `${ref.type}:${ref.id}`
            })
          }
        }
        if (ref.type === 'fact' && row.speakerType === 'character') {
          const fact = services.repos.world.get(ref.id)
          if (fact && fact.visibility === 'secret') {
            const knownBy = parseJson<string[]>(fact.knownByJson, [])
            if (!knownBy.includes(row.speakerId)) {
              issues.push({
                code: 'knowledge_leak_candidate',
                severity: 'candidate',
                message: `角色 ${row.speakerId} 的依据含其未知的秘密事实`,
                beat_id: beat.id,
                ref_id: fact.id
              })
            }
          }
        }
      }
    }

    // 单值槽：同一 subject+predicate 同时存在多条 active objective 事实
    const slots = new Map<string, number>()
    for (const fact of services.repos.world.listByProject(ctx.runtime.project_id)) {
      if (fact.truth !== 'objective' || fact.singleValue !== 1 || fact.validToSeq !== null) continue
      const key = `${fact.subject}\u0000${fact.predicate}`
      slots.set(key, (slots.get(key) ?? 0) + 1)
    }
    for (const [key, count] of slots) {
      if (count > 1) {
        const [subject, predicate] = key.split('\u0000')
        issues.push({
          code: 'single_value_conflict',
          severity: 'error',
          message: `${subject} 的 ${predicate} 同时有 ${count} 条有效值`,
          beat_id: null,
          ref_id: null
        })
      }
    }

    return {
      data: { revision_id: revision.id, issue_count: issues.length, issues },
      degraded: issues.some((issue) => issue.severity === 'error') ? ('summary' as const) : ('none' as const)
    }
  }
})

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '')
}

type Services = ToolServices

function referenceExists(services: Services, type: string, id: string): boolean {
  switch (type) {
    case 'memory':
      return services.repos.memory.get(id) !== null
    case 'belief':
      return services.repos.belief.get(id) !== null
    case 'fact':
      return services.repos.world.get(id) !== null
    case 'canon':
    case 'outline':
      return services.repos.outline.get(id) !== null
    case 'manuscript':
      return services.repos.beat.get(id) !== null
    default:
      return false
  }
}

function referenceQuote(services: Services, type: string, id: string): string | null {
  switch (type) {
    case 'memory':
      return services.repos.memory.get(id)?.text ?? null
    case 'belief':
      return services.repos.belief.get(id)?.beliefText ?? null
    case 'fact': {
      const fact = services.repos.world.get(id)
      return fact ? `${fact.subject} ${fact.predicate} ${fact.object}` : null
    }
    case 'canon':
    case 'outline':
      return services.repos.outline.get(id)?.content ?? null
    case 'manuscript':
      return services.repos.beat.get(id)?.body ?? null
    default:
      return null
  }
}

const StoryboardConflict = z.strictObject({
  code: z.string(),
  severity: z.enum(['hard', 'soft']),
  message: z.string(),
  scene_ord: z.number().int(),
  beat_ord: z.number().int().optional()
})

const storyboardValidate = defineTool({
  toolId: 'T27',
  name: 'storyboard.validate',
  version: '1.0.0',
  family: 'verify',
  summary: '校验分镜草案：发言人在场、意图与出口可判定、拍数上限；硬冲突拒绝提交',
  actors: ['orchestrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ draft: StoryboardDraftSchema }),
  output: z.strictObject({ valid: z.boolean(), conflicts: z.array(StoryboardConflict) }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args) => {
    const conflicts = validateStoryboard(args.draft)
    return {
      data: { valid: !conflicts.some((conflict) => conflict.severity === 'hard'), conflicts }
    }
  }
})

const exitDslValidate = defineTool({
  toolId: 'T28',
  name: 'exit_dsl.validate',
  version: '1.0.0',
  family: 'verify',
  summary: '校验出口 DSL 是否合法且可判定；自然语言出口直接拒绝',
  actors: ['orchestrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ expr: z.string().min(1).max(500) }),
  output: z.strictObject({ valid: z.boolean(), machine_decidable: z.boolean(), reasons: z.array(z.string()) }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args) => ({ data: validateExitExpr(args.expr) })
})

const reportGetLatest = defineTool({
  toolId: 'T30',
  name: 'report.get_latest',
  version: '1.0.0',
  family: 'verify',
  summary: '返回本章最近一次审批报告摘要：verdict、阻断数与 issue_refs，不含全文',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ chapter_id: Id }),
  output: z.strictObject({
    chapter_id: Id,
    found: z.boolean(),
    report: z
      .strictObject({
        report_id: Id,
        round: z.number().int(),
        verdict: z.string(),
        blocking_count: z.number().int(),
        issue_refs: z.array(z.string()),
        degraded: z.string().nullable(),
        created_at: z.string()
      })
      .nullable()
  }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const chapter = services.repos.chapter.get(args.chapter_id)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      return { data: { chapter_id: args.chapter_id, found: false, report: null }, degraded: 'empty' as const }
    }
    const reports = services.repos.review.listReportsByChapter(chapter.id)
    const latest = reports[reports.length - 1]
    if (!latest) {
      return { data: { chapter_id: chapter.id, found: false, report: null }, degraded: 'empty' as const }
    }
    const blocking = parseJson<Array<{ issue_ref?: unknown }>>(latest.blockingJson, [])
    const issueRefs = blocking
      .map((item) => item.issue_ref)
      .filter((ref): ref is string => typeof ref === 'string')
    return {
      data: {
        chapter_id: chapter.id,
        found: true,
        report: {
          report_id: latest.id,
          round: latest.round,
          verdict: latest.verdict,
          blocking_count: blocking.length,
          issue_refs: issueRefs,
          degraded: latest.degraded,
          created_at: latest.createdAt
        }
      }
    }
  }
})

const notImplemented = (name: string): never => {
  throw new AppError('tool_unavailable', `${name} 按里程碑开关未启用`)
}

/** T25（M2）：声音指标；M0 只保留契约。 */
const voiceMetrics = defineTool({
  toolId: 'T25',
  name: 'voice.metrics',
  version: '1.0.0',
  family: 'verify',
  summary: '统计句长分布、口头禅与问句率（M2）；只出指标，不自动判 fail',
  actors: ['reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ scene_id: Id }),
  output: z.strictObject({
    sentence_length_jsd: z.number(),
    catchphrase_rate: z.number(),
    question_rate: z.number(),
    pairwise_distinctness: z.number()
  }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'M2',
  handler: () => notImplemented('voice.metrics')
})

/** T26（P1）：覆盖检查；建议项，不阻断 G1。 */
const coverageCheck = defineTool({
  toolId: 'T26',
  name: 'coverage.check',
  version: '1.0.0',
  family: 'verify',
  summary: '检查卷纲关键事件无落点、角色无出场动机与章纲冲突（P1），只给建议',
  actors: ['planner'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ scope: z.enum(['volume', 'chapter', 'project']) }),
  output: z.strictObject({ gaps: z.array(z.strictObject({ code: z.string(), message: z.string() })) }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'P1',
  handler: () => notImplemented('coverage.check')
})

/** T29（P1）：影响分析；蓝图变更前必须跑。 */
const impactAnalyze = defineTool({
  toolId: 'T29',
  name: 'impact.analyze',
  version: '1.0.0',
  family: 'verify',
  summary: '分析蓝图变更影响的章节、记忆条目与关系边（P1），结果进变更记录',
  actors: ['planner'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ change: z.record(z.string(), z.unknown()) }),
  output: z.strictObject({
    chapters: z.array(Id),
    memory_entries: z.array(Id),
    relationships: z.array(Id)
  }),
  limits: limitsFor('verify'),
  degrade: degradeFor('verify'),
  audit: AUDIT,
  milestone: 'P1',
  handler: () => notImplemented('impact.analyze')
})

export const VERIFY_TOOLS = [
  consistencyCheck,
  voiceMetrics,
  coverageCheck,
  storyboardValidate,
  exitDslValidate,
  impactAnalyze,
  reportGetLatest
]
