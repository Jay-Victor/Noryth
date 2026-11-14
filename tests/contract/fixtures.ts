import type { TurnContext } from '../../src/main/tools/invoke'
import type { AgentInstanceKey, ToolGateId } from '../../src/main/tools/types'

/** 每个已实现工具的最小合法调用与空结果调用（C7：缺测试即 CI 失败）。 */

export interface ContractFixture {
  args: Record<string, unknown>
  agent?: AgentInstanceKey
  context?: Partial<TurnContext>
  /** null 表示该工具没有「空输入」语义，用 {} 调用必须得到 invalid_args 而不是崩溃。 */
  emptyArgs?: Record<string, unknown> | null
  gate?: { gateId: ToolGateId; entityType: string; entityId: string }
}

const BEAT_BODY = '「见过。匣子不在书房，在祠堂的供桌下面。」'

const draftScene = {
  location: '沈家祠堂',
  participants: ['chr_lin', 'chr_shen'],
  goal: '确认匣子的下落',
  exit: 'beats(1)',
  beats: [{ speaker_type: 'narrator', speaker_id: 'narrator', intent: '开场' }]
}

export const CONTRACT_FIXTURES: Record<string, ContractFixture> = {
  'project.get_meta': { args: {} },
  'outline.get_subtree': { args: { depth: 2 }, emptyArgs: { node_id: 'out_missing' } },
  'outline.get_chapter_brief': { args: {} },
  'character.get_own_card': { args: {} },
  'character.get_public_profile': {
    args: { character_ids: ['chr_lin', 'chr_shen'] },
    emptyArgs: { character_ids: ['chr_missing'] }
  },
  'character.get_card_full': { args: { character_id: 'chr_lin' }, emptyArgs: { character_id: 'chr_missing' } },
  'storyboard.get_chapter': { args: { chapter_id: 'ch_draft' } },
  'storyboard.get_beat': { args: {} },
  'scene.get': { args: { scene_id: 'scn_a' } },
  'memory.retrieve_own': { args: { query: '匣子' }, emptyArgs: { query: 'zzz不存在' } },
  'memory.retrieve_audit': {
    args: { character_id: 'chr_shen', query: '钥匙', issue_ref: 'ISSUE-1' },
    emptyArgs: { character_id: 'chr_shen', query: 'zzz不存在', issue_ref: 'ISSUE-1' }
  },
  'canon.search_public': { args: { query: '匣子' }, emptyArgs: { query: 'zzz不存在' } },
  'world.get_limited': { args: {}, emptyArgs: { as_of: 0 } },
  'world.get_reader_known': { args: { as_of: 3 }, emptyArgs: { as_of: 0 } },
  'world.get_objective': { args: { as_of: 3 }, emptyArgs: { as_of: 0 } },
  'belief.get_own': { args: {} },
  'belief.get_for_character': { args: { character_id: 'chr_lin' }, emptyArgs: { character_id: 'chr_shen' } },
  'relationship.get_edges': {
    args: {},
    agent: 'character:chr_lin',
    emptyArgs: { axis: 'intimacy' }
  },
  'manuscript.search_final': { args: { query: '匣子' }, emptyArgs: { query: 'zzz不存在' } },
  'manuscript.get_final_chapter': {
    args: { chapter_id: 'ch_final' },
    emptyArgs: { chapter_id: 'ch_draft' }
  },
  'draft.get_chapter': { args: { revision_id: 'rev_draft' }, emptyArgs: null },
  'consistency.check': { args: { revision_id: 'rev_draft' } },
  'storyboard.validate': { args: { draft: { scenes: [draftScene] } }, emptyArgs: null },
  'exit_dsl.validate': { args: { expr: 'all(fact("黑漆匣子","位置","祠堂供桌下面"), beats(2))' }, emptyArgs: null },
  'report.get_latest': { args: { chapter_id: 'ch_final' }, emptyArgs: { chapter_id: 'ch_draft' } },
  'blueprint.propose_patch': {
    args: { ops: [{ op: 'update', node_id: 'out_main', title: '主线：黑漆匣子（改）' }] },
    emptyArgs: null
  },
  'character.propose_card': { args: { character_id: 'chr_lin', card: { role: '主角' } }, emptyArgs: null },
  'roster.propose': {
    args: {
      roster: {
        characters: [{ name: '新角色', card: { role: '配角' } }],
        initial_facts: [{ subject: '林砚', predicate: '身份', object: '账房学徒' }]
      }
    },
    emptyArgs: null
  },
  'storyboard.propose': {
    args: { chapter_id: 'ch_draft', scenes: [draftScene] },
    emptyArgs: null
  },
  'report.submit': {
    args: {
      report: {
        verdict: 'pass_with_notes',
        blocking: [],
        suggestions: [{ issue_ref: 'ISSUE-1', suggestion: '补一句环境' }]
      }
    },
    context: { chapterId: 'ch_draft', expectedRevision: 'rev_draft' },
    emptyArgs: null
  },
  'patch.propose': {
    args: {
      patches: [
        {
          beat_id: 'bt_b',
          before: BEAT_BODY,
          after: '她把茶盏推回去，没有接话。',
          reason: '语气与角色卡不符',
          issue_ref: 'ISSUE-1'
        }
      ]
    },
    context: { chapterId: 'ch_draft', expectedRevision: 'rev_draft' },
    gate: { gateId: 'G5', entityType: 'revision', entityId: 'rev_draft' },
    emptyArgs: null
  },
  'memory.proposal.submit': {
    args: {
      proposal: {
        items: [
          {
            kind: 'experience',
            character_id: 'chr_lin',
            text: '她确认匣子在祠堂供桌下面',
            source_beat_id: 'bt_final'
          }
        ]
      }
    },
    agent: 'memory',
    context: { chapterId: 'ch_final', expectedRevision: 'rev_final' },
    emptyArgs: null
  },
  'memory.namespace.create': {
    args: { character_ids: ['chr_lin', 'chr_shen'] },
    agent: 'memory',
    context: { expectedRevision: null },
    gate: { gateId: 'G1', entityType: 'project', entityId: 'prj_contract' },
    emptyArgs: null
  },
  'memory.apply': {
    args: {
      proposal_id: 'job_prop',
      decisions: [
        { item_id: 'mpi_accept', decision: 'accept' },
        { item_id: 'mpi_reject', decision: 'reject' }
      ]
    },
    agent: 'memory',
    context: { chapterId: 'ch_final', expectedRevision: null },
    gate: { gateId: 'G7', entityType: 'proposal', entityId: 'job_prop' },
    emptyArgs: null
  },
  'refusal.raise': {
    args: { code: 'out_of_knowledge', reason: '她不知道账本在哪里' },
    agent: 'character:chr_lin'
  },
  'author.request_choice': {
    args: {
      question: '接下来查哪条线？',
      options: [
        { id: 'ledger', label: '查旧账' },
        { id: 'elder', label: '问老太爷' }
      ]
    },
    context: { mode: 'interactive' },
    emptyArgs: null
  }
}
