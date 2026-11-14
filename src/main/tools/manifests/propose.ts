import { z } from 'zod'
import { AppError } from '../../../shared/domain/app-error'
import { newId } from '../../db/repos/common'
import type { ProposalKind } from '../../db/repos/memory-proposal'
import { defineTool } from '../define'
import { canonicalJson } from '../idempotency'
import { sha256Hex } from '../../crypto'
import { ensureNamespaces } from '../../memory/namespace'
import { validateStoryboard, DraftSceneSchema } from '../support/storyboard'
import { AUDIT, Id, degradeFor, limitsFor, parseJson } from './shared'

/** T31–T41：提案与执行（PRD §4.10.4）。T40 按里程碑开关。 */

const StoryboardConflict = z.strictObject({
  code: z.string(),
  severity: z.enum(['hard', 'soft']),
  message: z.string(),
  scene_ord: z.number().int(),
  beat_ord: z.number().int().optional()
})

const BlueprintOp = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    parent_id: Id.nullable(),
    /** 同一提案内引用前面 add 的 `ref`，用于一次提交整棵树。 */
    parent_ref: z.string().min(1).max(40).optional(),
    ref: z.string().min(1).max(40).optional(),
    kind: z.enum(['main', 'volume', 'chapter']),
    ord: z.number().int().min(0).max(10_000),
    title: z.string().min(1).max(200),
    content: z.string().max(20_000).optional()
  }),
  z.strictObject({
    op: z.literal('update'),
    node_id: Id,
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(20_000).optional()
  }),
  z.strictObject({ op: z.literal('remove'), node_id: Id })
])

const blueprintProposePatch = defineTool({
  toolId: 'T31',
  name: 'blueprint.propose_patch',
  version: '1.0.0',
  family: 'propose',
  summary: '提交大纲变更提案（新增/修改/删除节点），只写草案，不直接改大纲',
  actors: ['planner'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({ ops: z.array(BlueprintOp).min(1).max(50) }),
  output: z.strictObject({
    proposal_id: Id,
    status: z.literal('draft'),
    diff_summary: z.strictObject({
      added: z.number().int(),
      updated: z.number().int(),
      removed: z.number().int(),
      nodes: z.array(Id)
    })
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')
    if (project.blueprintLockedAt !== null) {
      throw new AppError('invalid_args', '蓝图已锁定；修改必须先走变更流程（阶段 06 只读）')
    }

    let added = 0
    let updated = 0
    let removed = 0
    const nodes: string[] = []
    const refs = new Set<string>()

    for (const op of args.ops) {
      if (op.op === 'add') {
        if (op.ref !== undefined) {
          if (refs.has(op.ref)) throw new AppError('invalid_args', `提案内 ref 重复 ${op.ref}`)
          refs.add(op.ref)
        }
        if (op.parent_ref !== undefined && !refs.has(op.parent_ref)) {
          throw new AppError('invalid_args', `parent_ref ${op.parent_ref} 未在前面定义`)
        }
        if (op.parent_ref !== undefined && op.parent_id !== null) {
          throw new AppError('invalid_args', 'parent_id 与 parent_ref 只能给一个')
        }
        if (op.parent_id !== null) {
          const parent = services.repos.outline.get(op.parent_id)
          if (!parent || parent.projectId !== ctx.runtime.project_id) {
            throw new AppError('invalid_args', `parent ${op.parent_id} not in project`)
          }
        }
        added += 1
        nodes.push(op.ref ?? op.parent_ref ?? op.parent_id ?? '(root)')
        continue
      }
      const node = services.repos.outline.get(op.node_id)
      if (!node || node.projectId !== ctx.runtime.project_id) {
        throw new AppError('invalid_args', `outline node ${op.node_id} not in project`)
      }
      if (op.op === 'update') {
        if (op.title === undefined && op.content === undefined) {
          throw new AppError('invalid_args', 'update 至少需要 title 或 content')
        }
        updated += 1
        nodes.push(op.node_id)
      } else {
        removed += 1
        nodes.push(op.node_id)
      }
    }

    const record = services.repos.proposal.insert({
      projectId: project.id,
      kind: 'blueprint_patch',
      jobId: ctx.runtime.job_id,
      turnId: ctx.runtime.turn_id,
      payloadJson: canonicalJson({ ops: args.ops }),
      summaryJson: JSON.stringify({ added, updated, removed, nodes })
    })

    return {
      data: {
        proposal_id: record.id,
        status: 'draft' as const,
        diff_summary: { added, updated, removed, nodes }
      }
    }
  }
})

const characterProposeCard = defineTool({
  toolId: 'T32',
  name: 'character.propose_card',
  version: '1.0.0',
  family: 'propose',
  summary: '提交角色卡提案；不更换 character_id，改版列出受影响章节',
  actors: ['planner'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({
    character_id: Id.optional(),
    card: z.record(z.string(), z.unknown())
  }),
  output: z.strictObject({
    card_draft_id: Id,
    character_id: Id.nullable(),
    card_version: z.number().int().nullable(),
    affected_chapters: z.array(Id)
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')

    if (!args.character_id) {
      const record = services.repos.proposal.insert({
        projectId: project.id,
        kind: 'character_card',
        jobId: ctx.runtime.job_id,
        turnId: ctx.runtime.turn_id,
        payloadJson: canonicalJson({ character_id: null, card: args.card }),
        summaryJson: JSON.stringify({ note: '未指定角色；需作者先选择目标角色' })
      })
      return {
        data: {
          card_draft_id: record.id,
          character_id: null,
          card_version: null,
          affected_chapters: []
        }
      }
    }

    const planCharacter = services.repos.planCharacter.get(args.character_id)
    const character = services.repos.character.get(args.character_id)
    const target = planCharacter ?? character
    if (!target || target.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'character not in project')
    }

    const affected = character
      ? services.repos.chapter
          .listByProject(ctx.runtime.project_id)
          .filter((chapter) =>
            services.repos.beat.listLiveByChapter(chapter.id).some((beat) => beat.speakerId === character.id)
          )
          .map((chapter) => chapter.id)
      : []

    const name = planCharacter?.name ?? character!.name
    const record = services.repos.proposal.insert({
      projectId: project.id,
      kind: 'character_card',
      jobId: ctx.runtime.job_id,
      turnId: ctx.runtime.turn_id,
      payloadJson: canonicalJson({
        character_id: args.character_id,
        target: planCharacter ? 'plan' : 'character',
        card: args.card
      }),
      summaryJson: JSON.stringify({ character_name: name, affected_chapters: affected })
    })

    return {
      data: {
        card_draft_id: record.id,
        character_id: args.character_id,
        card_version: planCharacter?.cardVersion ?? character!.cardVersion,
        affected_chapters: affected
      }
    }
  }
})

const rosterPropose = defineTool({
  toolId: 'T33',
  name: 'roster.propose',
  version: '1.0.0',
  family: 'propose',
  summary: '提交角色注册清单与初始事实提案；规划不建库、不写向量',
  actors: ['planner'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({
    roster: z.strictObject({
      characters: z
        .array(z.strictObject({ name: z.string().min(1).max(40), card: z.record(z.string(), z.unknown()) }))
        .min(1)
        .max(20),
      initial_facts: z
        .array(
          z.strictObject({
            subject: z.string().min(1).max(80),
            predicate: z.string().min(1).max(80),
            object: z.string().min(1).max(200),
            visibility: z.enum(['public', 'secret']).default('public')
          })
        )
        .max(30)
        .default([])
    })
  }),
  output: z.strictObject({
    roster_id: Id,
    characters: z.array(z.strictObject({ name: z.string(), temp_id: Id })),
    initial_facts: z.array(
      z.strictObject({ subject: z.string(), predicate: z.string(), object: z.string(), visibility: z.string() })
    )
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')
    if (project.blueprintLockedAt !== null) {
      throw new AppError('invalid_args', '蓝图已锁定；新增角色必须走变更流程')
    }

    const seen = new Set<string>()
    for (const character of args.roster.characters) {
      const name = character.name.trim()
      if (seen.has(name)) throw new AppError('invalid_args', `角色名重复 ${name}`)
      seen.add(name)
    }

    const record = services.repos.proposal.insert({
      projectId: project.id,
      kind: 'roster',
      jobId: ctx.runtime.job_id,
      turnId: ctx.runtime.turn_id,
      payloadJson: canonicalJson({ roster: args.roster }),
      summaryJson: JSON.stringify({
        characters: args.roster.characters.length,
        facts: args.roster.initial_facts.length
      })
    })

    return {
      data: {
        roster_id: record.id,
        characters: args.roster.characters.map((character, index) => ({
          name: character.name.trim(),
          temp_id: `tmp_${index + 1}`
        })),
        initial_facts: args.roster.initial_facts.map((fact) => ({
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          visibility: fact.visibility
        }))
      }
    }
  }
})

const storyboardPropose = defineTool({
  toolId: 'T34',
  name: 'storyboard.propose',
  version: '1.0.0',
  family: 'propose',
  summary: '提交分镜提案；提交前自动跑 T27，硬冲突不落盘，软冲突告警',
  actors: ['orchestrator'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({
    chapter_id: Id,
    scenes: z.array(DraftSceneSchema).min(1).max(10)
  }),
  output: z.strictObject({
    storyboard_rev: z.string(),
    valid: z.boolean(),
    conflicts: z.array(StoryboardConflict)
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const chapter = services.repos.chapter.get(args.chapter_id)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'chapter not in project')
    }
    const conflicts = validateStoryboard({ chapter_id: args.chapter_id, scenes: args.scenes })
    const valid = !conflicts.some((conflict) => conflict.severity === 'hard')
    return {
      data: {
        storyboard_rev: sha256Hex(canonicalJson(args.scenes)).slice(0, 16),
        valid,
        conflicts
      },
      degraded: valid ? ('none' as const) : ('summary' as const)
    }
  }
})

const BlockingItem = z.strictObject({
  issue_ref: z.string().min(1).max(80),
  dimension: z.string().min(1).max(40),
  beat_id: Id,
  evidence: z.string().min(1).max(1000)
})

const SuggestionItem = z.strictObject({
  issue_ref: z.string().min(1).max(80),
  dimension: z.string().min(1).max(40).optional(),
  suggestion: z.string().min(1).max(1000)
})

const StructuredReport = z.strictObject({
  verdict: z.enum(['pass', 'pass_with_notes', 'fail']),
  blocking: z.array(BlockingItem).max(30).default([]),
  suggestions: z.array(SuggestionItem).max(30).default([]),
  dimensions: z.record(z.string(), z.number()).optional(),
  model: z.string().max(120).optional()
})

const PlainReport = z.strictObject({ plain_text: z.string().min(1).max(20_000) })

const reportSubmit = defineTool({
  toolId: 'T35',
  name: 'report.submit',
  version: '1.0.0',
  family: 'propose',
  summary: '提交审批报告；结构化失败时接受纯文本并标降级，阻断项必须定位到拍',
  actors: ['reviewer'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({ report: z.union([StructuredReport, PlainReport]) }),
  output: z.strictObject({
    report_id: Id,
    round: z.number().int(),
    verdict: z.string(),
    degraded: z.string().nullable()
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    if (!ctx.chapterId) throw new AppError('invalid_args', 'chapter context missing')
    const chapter = services.repos.chapter.get(ctx.chapterId)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'chapter not in project')
    }
    const revisionId = ctx.runtime.expected_revision ?? chapter.currentRevisionId
    if (!revisionId) throw new AppError('invalid_args', 'chapter has no revision')
    const revision = services.repos.revision.get(revisionId)
    if (!revision || revision.chapterId !== chapter.id) throw new AppError('stale_revision', 'revision mismatch')

    const round = services.repos.review.listReportsByChapter(chapter.id).length + 1

    if ('plain_text' in args.report) {
      const record = services.repos.review.insertReport({
        projectId: ctx.runtime.project_id,
        chapterId: chapter.id,
        revisionId,
        round,
        verdict: 'fail',
        suggestionsJson: JSON.stringify([{ issue_ref: 'report_schema', suggestion: args.report.plain_text }]),
        degraded: 'schema_fallback'
      })
      return { data: { report_id: record.id, round, verdict: record.verdict, degraded: record.degraded } }
    }

    const report = args.report
    for (const item of report.blocking) {
      const beat = services.repos.beat.get(item.beat_id)
      if (!beat || beat.chapterId !== chapter.id) {
        throw new AppError('invalid_args', `blocking beat ${item.beat_id} not in chapter`)
      }
    }
    const record = services.repos.review.insertReport({
      projectId: ctx.runtime.project_id,
      chapterId: chapter.id,
      revisionId,
      round,
      verdict: report.verdict,
      blockingJson: JSON.stringify(report.blocking),
      suggestionsJson: JSON.stringify(report.suggestions),
      dimensionsJson: JSON.stringify(report.dimensions ?? {}),
      model: report.model ?? null
    })
    return { data: { report_id: record.id, round, verdict: record.verdict, degraded: record.degraded } }
  }
})

const PatchItem = z.strictObject({
  beat_id: Id,
  before: z.string().min(1).max(4000),
  after: z.string().min(1).max(4000),
  reason: z.string().min(4).max(500),
  issue_ref: z.string().min(1).max(80)
})

const patchPropose = defineTool({
  toolId: 'T36',
  name: 'patch.propose',
  version: '1.0.0',
  family: 'propose',
  summary: '凭 G5 令牌提交草稿 patch；只改已有拍，不加戏、不加场景',
  actors: ['reviewer'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: 'G5',
  idempotency: 'key_required',
  input: z.strictObject({ patches: z.array(PatchItem).min(1).max(20) }),
  output: z.strictObject({ proposal_id: Id, patch_ids: z.array(Id), revision_id: Id }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    if (!ctx.chapterId) throw new AppError('invalid_args', 'chapter context missing')
    const chapter = services.repos.chapter.get(ctx.chapterId)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'chapter not in project')
    }
    const revisionId = ctx.runtime.expected_revision
    if (!revisionId || chapter.currentRevisionId !== revisionId) {
      throw new AppError('stale_revision', 'draft revision changed')
    }
    if (!ctx.gate || ctx.gate.et !== 'revision' || ctx.gate.eid !== revisionId) {
      throw new AppError('stale_revision', 'gate entity mismatch')
    }
    const members = new Set(services.repos.revision.listMembers(revisionId).map((member) => member.beatId))
    const proposalId = newId('prop')
    const patchIds: string[] = []

    for (const patch of args.patches) {
      const beat = services.repos.beat.get(patch.beat_id)
      if (!beat || beat.chapterId !== chapter.id || !members.has(beat.id)) {
        throw new AppError('invalid_args', `beat ${patch.beat_id} not in current revision`)
      }
      if (beat.body !== patch.before) {
        throw new AppError('patch_conflict', `beat ${beat.id} body changed`)
      }
      const record = services.repos.patch.insert({
        projectId: ctx.runtime.project_id,
        proposalId,
        revisionId,
        beatId: beat.id,
        before: patch.before,
        after: patch.after,
        reason: patch.reason,
        issueRef: patch.issue_ref
      })
      patchIds.push(record.id)
    }

    return { data: { proposal_id: proposalId, patch_ids: patchIds, revision_id: revisionId } }
  }
})

const PROPOSAL_KINDS = ['experience', 'fact', 'relationship', 'cognition', 'world_fact', 'belief'] as const

const ProposalItem = z.strictObject({
  kind: z.enum(PROPOSAL_KINDS),
  character_id: Id.optional(),
  text: z.string().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).optional(),
  source_beat_id: Id.optional(),
  importance: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional()
})

const memoryProposalSubmit = defineTool({
  toolId: 'T37',
  name: 'memory.proposal.submit',
  version: '1.0.0',
  family: 'propose',
  summary: '只从定稿抽取记忆固化提案；台词只能进信念或声称，不写客观事实',
  actors: ['memory'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({ proposal: z.strictObject({ items: z.array(ProposalItem).min(1).max(80) }) }),
  output: z.strictObject({
    job_id: Id,
    status: z.literal('proposed'),
    item_count: z.number().int()
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    if (!ctx.chapterId) throw new AppError('invalid_args', 'chapter context missing')
    const chapter = services.repos.chapter.get(ctx.chapterId)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', 'chapter not in project')
    }
    if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
      throw new AppError('invalid_args', 'only finalized chapters feed memory')
    }
    const revisionId = ctx.runtime.expected_revision ?? chapter.finalRevisionId
    if (revisionId !== chapter.finalRevisionId) {
      throw new AppError('stale_revision', 'expected revision is not the final revision')
    }
    const members = new Set(services.repos.revision.listMembers(revisionId).map((member) => member.beatId))

    for (const item of args.proposal.items) {
      if (item.kind !== 'world_fact' && !item.character_id) {
        throw new AppError('invalid_args', `kind ${item.kind} 需要 character_id`)
      }
      if (item.character_id) {
        const character = services.repos.character.get(item.character_id)
        if (!character || character.projectId !== ctx.runtime.project_id) {
          throw new AppError('invalid_args', 'character not in project')
        }
      }
      if (item.source_beat_id && !members.has(item.source_beat_id)) {
        throw new AppError('invalid_args', 'source beat not in final revision')
      }
      if (item.kind === 'world_fact') {
        const truth = item.payload?.truth
        const sourceType = item.payload?.source_type
        if (truth === 'objective' && sourceType === 'dialogue') {
          throw new AppError('invalid_args', '台词不能写成客观事实')
        }
      }
    }

    for (const item of args.proposal.items) {
      services.repos.memoryProposal.insert({
        projectId: ctx.runtime.project_id,
        jobId: ctx.runtime.job_id,
        kind: item.kind as ProposalKind,
        characterId: item.character_id ?? null,
        text: item.text,
        payloadJson: JSON.stringify(item.payload ?? {}),
        sourceChapterId: chapter.id,
        sourceRevisionId: revisionId,
        sourceBeatId: item.source_beat_id ?? null,
        importance: item.importance,
        pinned: item.pinned ? 1 : 0
      })
    }

    return {
      data: { job_id: ctx.runtime.job_id, status: 'proposed' as const, item_count: args.proposal.items.length }
    }
  }
})

const memoryNamespaceCreate = defineTool({
  toolId: 'T38',
  name: 'memory.namespace.create',
  version: '1.0.0',
  family: 'propose',
  summary: '按 G1 长期授权创建角色记忆命名空间并做隔离自检；失败可重试',
  actors: ['memory'],
  sideEffect: 'execute',
  agentCallable: true,
  requiresGate: 'G1',
  idempotency: 'key_required',
  input: z.strictObject({
    character_ids: z.array(Id).min(1).max(20),
    with_public_canon: z.boolean().default(true)
  }),
  output: z.strictObject({
    namespaces: z.array(
      z.strictObject({ character_id: Id, namespace: z.string(), entries: z.number().int() })
    ),
    isolation_verified: z.boolean(),
    setup_state: z.string()
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')
    if (!ctx.gate || ctx.gate.et !== 'project' || ctx.gate.eid !== project.id) {
      throw new AppError('stale_revision', 'gate entity mismatch')
    }

    for (const characterId of args.character_ids) {
      const character = services.repos.character.get(characterId)
      if (!character || character.projectId !== project.id) {
        throw new AppError('invalid_args', `character ${characterId} not in project`)
      }
    }

    const result = ensureNamespaces(services.repos, project.id)
    if (result.isolationVerified) {
      services.repos.project.setSetupState(project.id, 'complete')
      services.repos.project.mergeMetadata(project.id, {
        isolation_verified: true,
        setup_completed_at: new Date().toISOString()
      })
    }

    return {
      data: {
        namespaces: result.namespaces
          .filter((namespace) => namespace.characterId !== null)
          .map((namespace) => ({
            character_id: namespace.characterId!,
            namespace: namespace.name,
            entries: namespace.entries
          })),
        isolation_verified: result.isolationVerified,
        setup_state: services.repos.project.getById(project.id)?.setupState ?? project.setupState
      }
    }
  }
})

const MemoryDecision = z.strictObject({
  item_id: Id,
  decision: z.enum(['accept', 'edit', 'reject']),
  edited_text: z.string().min(1).max(1000).optional()
})

const memoryApply = defineTool({
  toolId: 'T39',
  name: 'memory.apply',
  version: '1.0.0',
  family: 'propose',
  summary: '凭 G7 令牌应用记忆提案：写记忆、世界状态与关系；不碰正文',
  actors: ['memory'],
  sideEffect: 'execute',
  agentCallable: true,
  requiresGate: 'G7',
  idempotency: 'key_required',
  input: z.strictObject({
    proposal_id: Id,
    decisions: z.array(MemoryDecision).min(1).max(80)
  }),
  output: z.strictObject({
    applied_count: z.number().int(),
    rejected_count: z.number().int(),
    superseded: z.array(Id),
    inactive: z.array(Id)
  }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    if (!ctx.gate || ctx.gate.eid !== args.proposal_id) {
      throw new AppError('stale_revision', 'gate entity mismatch')
    }
    const project = services.repos.project.getById(ctx.runtime.project_id)
    if (!project) throw new AppError('project_not_found', 'project row missing')

    const items = services.repos.memoryProposal.listByJob(ctx.runtime.project_id, args.proposal_id)
    if (items.length === 0) throw new AppError('invalid_args', 'proposal not found')
    const byId = new Map(items.map((item) => [item.id, item]))

    let applied = 0
    let rejected = 0
    const superseded: string[] = []

    for (const decision of args.decisions) {
      const item = byId.get(decision.item_id)
      if (!item) throw new AppError('invalid_args', `proposal item ${decision.item_id} not found`)
      if (item.decision !== 'pending') throw new AppError('invalid_args', `proposal item ${item.id} already decided`)
      if (decision.decision === 'edit' && !decision.edited_text) {
        throw new AppError('invalid_args', 'edit 需要 edited_text')
      }

      if (decision.decision === 'reject') {
        services.repos.memoryProposal.decide(item.id, 'reject')
        rejected += 1
        continue
      }

      const text = decision.decision === 'edit' ? decision.edited_text! : item.text
      const payload = parseJson<Record<string, unknown>>(item.payloadJson, {})
      const learnedSeq =
        (item.sourceBeatId ? services.repos.beat.get(item.sourceBeatId)?.seq : null) ?? ctx.runtime.as_of

      if (item.kind === 'world_fact') {
        const subject = payload.subject
        const predicate = payload.predicate
        const object = payload.object
        if (typeof subject !== 'string' || typeof predicate !== 'string' || typeof object !== 'string') {
          throw new AppError('invalid_args', 'world_fact 需要 subject/predicate/object')
        }
        const singleValue = typeof payload.single_value === 'number' ? payload.single_value : 1
        if (singleValue === 1) {
          const current = services.repos.world.current(subject, predicate)
          if (current) {
            services.repos.world.closeValidity(current.id, learnedSeq)
            superseded.push(current.id)
          }
        }
        const truth = payload.truth === 'objective' ? 'objective' : 'claim'
        const visibility = payload.visibility === 'public' ? 'public' : 'secret'
        const knownBy = Array.isArray(payload.known_by)
          ? payload.known_by.filter((value): value is string => typeof value === 'string')
          : []
        const revealSeq = typeof payload.reveal_seq === 'number' ? payload.reveal_seq : null
        services.repos.world.insert({
          projectId: project.id,
          subject,
          predicate,
          object,
          singleValue,
          truth,
          visibility,
          knownByJson: JSON.stringify(knownBy),
          revealSeq,
          validFromSeq: learnedSeq,
          sourceType: 'memory',
          sourceId: item.id
        })
      } else if (item.kind === 'belief') {
        if (!item.characterId) throw new AppError('invalid_args', 'belief 需要 character_id')
        services.repos.belief.insert({
          projectId: project.id,
          characterId: item.characterId,
          factId: typeof payload.fact_id === 'string' ? payload.fact_id : null,
          beliefText: text,
          confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.6,
          learnedSeq,
          sourceType: 'author',
          sourceId: item.id
        })
      } else {
        if (!item.characterId) throw new AppError('invalid_args', `${item.kind} 需要 character_id`)
        const record = services.repos.memory.insert({
          projectId: project.id,
          characterId: item.characterId,
          kind: item.kind,
          text,
          learnedSeq,
          sourceChapterId: item.sourceChapterId,
          sourceRevisionId: item.sourceRevisionId,
          sourceBeatId: item.sourceBeatId,
          importance: item.importance,
          pinned: item.pinned,
          embeddingModel: project.embeddingModel
        })
        if (typeof payload.supersedes_id === 'string') {
          services.repos.memory.supersede(payload.supersedes_id, record.id)
          superseded.push(payload.supersedes_id)
        }
      }

      services.repos.memoryProposal.decide(item.id, decision.decision === 'edit' ? 'edit' : 'accept', decision.edited_text)
      applied += 1
    }

    return {
      data: {
        applied_count: applied,
        rejected_count: rejected,
        superseded,
        inactive: []
      }
    }
  }
})

const notImplemented = (name: string): never => {
  throw new AppError('tool_unavailable', `${name} 按里程碑开关未启用`)
}

/** T40（M1）：按章重建记忆；M0 只保留契约。 */
const memoryRebuild = defineTool({
  toolId: 'T40',
  name: 'memory.rebuild',
  version: '1.0.0',
  family: 'propose',
  summary: '按章重建记忆（M1）：旧 revision 记忆标 inactive，不物理删除',
  actors: ['memory'],
  sideEffect: 'execute',
  agentCallable: true,
  requiresGate: 'author_confirm',
  idempotency: 'key_required',
  input: z.strictObject({ chapter_id: Id }),
  output: z.strictObject({ inactive_count: z.number().int(), rebuilt_count: z.number().int() }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M1',
  handler: () => notImplemented('memory.rebuild')
})

const refusalRaise = defineTool({
  toolId: 'T41',
  name: 'refusal.raise',
  version: '1.0.0',
  family: 'propose',
  summary: '角色拒演：合法输出不是失败，调度器据此暂停场景等作者裁决',
  actors: ['character'],
  sideEffect: 'propose',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'key_required',
  injected: ['character_id'],
  input: z.strictObject({
    code: z.enum(['out_of_knowledge', 'out_of_character', 'storyboard_conflict', 'content_boundary']),
    reason: z.string().min(4).max(500)
  }),
  output: z.strictObject({ status: z.literal('character_refusal') }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (_args, ctx) => {
    if (!ctx.runtime.character_id) throw new AppError('invalid_args', 'character identity missing')
    return { data: { status: 'character_refusal' as const } }
  }
})

export const PROPOSE_TOOLS = [
  blueprintProposePatch,
  characterProposeCard,
  rosterPropose,
  storyboardPropose,
  reportSubmit,
  patchPropose,
  memoryProposalSubmit,
  memoryNamespaceCreate,
  memoryApply,
  memoryRebuild,
  refusalRaise
]
