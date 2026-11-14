import { z } from 'zod'
import { AppError } from '../../shared/domain/app-error'
import { defineTool } from './define'
import { AUDIT, Id, degradeFor, limitsFor } from './manifests/shared'

/**
 * 8 个系统能力：注册表登记契约，但 `agent_callable=false`，永不下发给 Agent。
 * 实现分别落在阶段 05（doc.*）、07（export/backup）、09（memory executor）。
 */

function notReady(name: string): never {
  throw new AppError('tool_unavailable', `${name} 由系统调度器实现，尚未接入`)
}

const docCommitBeat = defineTool({
  toolId: 'S01',
  name: 'doc.commit_beat',
  version: '1.0.0',
  family: 'propose',
  summary: '调度器调用文档控制器，单拍落盘并生成 revision',
  actors: [],
  sideEffect: 'commit',
  agentCallable: false,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({
    chapter_id: Id,
    scene_id: Id,
    ord: z.number().int().min(1).max(10_000),
    speaker_type: z.enum(['character', 'narrator']),
    speaker_id: Id,
    body: z.string().min(1).max(20_000),
    supersedes_id: Id.optional(),
    expected_revision: Id.optional()
  }),
  output: z.strictObject({ beat_id: Id, revision_id: Id, seq: z.number().int() }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('doc.commit_beat')
})

const docApplyPatch = defineTool({
  toolId: 'S02',
  name: 'doc.apply_patch',
  version: '1.0.0',
  family: 'propose',
  summary: 'G5 决策后逐条落盘 patch，生成新 revision',
  actors: [],
  sideEffect: 'commit',
  agentCallable: false,
  requiresGate: 'G5',
  idempotency: 'key_required',
  input: z.strictObject({
    proposal_id: Id,
    decisions: z
      .array(z.strictObject({ patch_id: Id, decision: z.enum(['accept', 'reject']) }))
      .min(1)
      .max(50)
  }),
  output: z.strictObject({ revision_id: Id, applied_count: z.number().int() }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('doc.apply_patch')
})

const docFinalizeChapter = defineTool({
  toolId: 'S03',
  name: 'doc.finalize_chapter',
  version: '1.0.0',
  family: 'propose',
  summary: '作者凭 G6 冻结定稿快照',
  actors: [],
  sideEffect: 'commit',
  agentCallable: false,
  requiresGate: 'G6',
  idempotency: 'key_required',
  input: z.strictObject({ chapter_id: Id, expected_revision: Id }),
  output: z.strictObject({ chapter_id: Id, revision_id: Id }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('doc.finalize_chapter')
})

const memoryApplyExecutor = defineTool({
  toolId: 'S04',
  name: 'memory.apply_executor',
  version: '1.0.0',
  family: 'propose',
  summary: 'memory.apply 的落盘端，真正写向量库与世界状态',
  actors: [],
  sideEffect: 'execute',
  agentCallable: false,
  requiresGate: 'G7',
  idempotency: 'key_required',
  input: z.strictObject({
    proposal_id: Id,
    decisions: z
      .array(z.strictObject({ item_id: Id, decision: z.enum(['accept', 'edit', 'reject']) }))
      .min(1)
      .max(80)
  }),
  output: z.strictObject({ applied_count: z.number().int() }),
  limits: limitsFor('propose'),
  degrade: degradeFor('propose'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('memory.apply_executor')
})

const indexRebuild = defineTool({
  toolId: 'S05',
  name: 'index.rebuild',
  version: '1.0.0',
  family: 'knowledge',
  summary: '嵌入模型变更后全量重建索引',
  actors: [],
  sideEffect: 'execute',
  agentCallable: false,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({ chapter_id: Id.optional() }),
  output: z.strictObject({ rebuilt_count: z.number().int() }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('index.rebuild')
})

const exportRun = defineTool({
  toolId: 'S06',
  name: 'export.run',
  version: '1.0.0',
  family: 'knowledge',
  summary: '按范围导出 Markdown 或 TXT 快照',
  actors: [],
  sideEffect: 'execute',
  agentCallable: false,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({
    format: z.enum(['markdown', 'txt', 'docx']),
    chapter_ids: z.array(Id).max(100).optional()
  }),
  output: z.strictObject({ path: z.string(), bytes: z.number().int() }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('export.run')
})

const backupCreate = defineTool({
  toolId: 'S07',
  name: 'backup.create',
  version: '1.0.0',
  family: 'knowledge',
  summary: '项目级检查点与定时备份',
  actors: [],
  sideEffect: 'execute',
  agentCallable: false,
  requiresGate: null,
  idempotency: 'key_required',
  input: z.strictObject({ reason: z.string().max(120).optional() }),
  output: z.strictObject({ path: z.string() }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('backup.create')
})

const jobCancel = defineTool({
  toolId: 'S08',
  name: 'job.cancel',
  version: '1.0.0',
  family: 'knowledge',
  summary: '取消任务；不保证远端停止',
  actors: [],
  sideEffect: 'none',
  agentCallable: false,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ job_id: Id }),
  output: z.strictObject({ cancelled: z.boolean() }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  system: true,
  handler: () => notReady('job.cancel')
})

export const SYSTEM_TOOLS = [
  docCommitBeat,
  docApplyPatch,
  docFinalizeChapter,
  memoryApplyExecutor,
  indexRebuild,
  exportRun,
  backupCreate,
  jobCancel
]
