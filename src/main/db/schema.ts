import type { Generated } from 'kysely'

/**
 * Kysely 的数据库类型（snake_case 与 0001_init.sql / 0002_outbox_meta.sql 一致）。
 * 只描述关系表；memory_fts / memory_vec 是虚拟表，由阶段 09 的 MemoryStore 直接处理。
 * 枚举列用 string 描述，业务枚举留在 repos 的输入/输出类型里，避免两层类型互相 import。
 */

export interface ProjectTable {
  id: string
  title: string
  genre: Generated<string>
  pov: string
  target_words: number | null
  status: Generated<string>
  setup_state: Generated<string>
  embedding_model: string
  embedding_dim: number
  default_preset: string
  seq_head: Generated<number>
  write_epoch: Generated<number>
  schema_version: number
  blueprint_version: Generated<number>
  blueprint_locked_at: string | null
  metadata_json: Generated<string>
  created_at: string
  updated_at: string
}

export interface OutlineNodeTable {
  id: string
  project_id: string
  parent_id: string | null
  kind: string
  ord: number
  title: string
  content: Generated<string>
  status: Generated<string>
  version: Generated<number>
  created_at: string
  updated_at: string
}

export interface CharacterTable {
  id: string
  project_id: string
  name: string
  card_json: string
  card_version: Generated<number>
  status: Generated<string>
  created_at: string
  updated_at: string
}

export interface ChapterTable {
  id: string
  project_id: string
  outline_node_id: string
  ord: number
  status: string
  covered_until_seq: number
  current_revision_id: string | null
  final_revision_id: string | null
  opened_at: string | null
  finalized_at: string | null
  budget_tokens: number | null
}

export interface SceneTable {
  id: string
  project_id: string
  ord: number
  location: string
  participants_json: string
  goal: string
  entry: Generated<string>
  exit_json: string
  status: string
  max_beats: Generated<number>
  created_at: string
  updated_at: string
}

export interface ChapterSceneTable {
  chapter_id: string
  scene_id: string
  ord: number
}

export interface RevisionTable {
  id: string
  chapter_id: string
  parent_revision_id: string | null
  kind: string
  content_hash: string
  created_by: string
  note: string | null
  created_at: string
}

export interface BeatTable {
  id: string
  chapter_id: string
  scene_id: string
  ord: number
  seq: number | null
  speaker_type: string
  speaker_id: string
  intent: Generated<string>
  body: Generated<string>
  grounding_json: Generated<string>
  trace_ref: string | null
  status: string
  supersedes_id: string | null
  created_revision_id: string
  max_words: number | null
  word_count: Generated<number>
  author_edited: Generated<number>
  decided_by: string | null
  created_at: string
  updated_at: string
}

export interface RevisionBeatTable {
  revision_id: string
  beat_id: string
  scene_ord: number
  beat_ord: number
}

export interface PatchTable {
  id: string
  project_id: string
  proposal_id: string
  revision_id: string
  beat_id: string
  before: string
  after: string
  reason: string
  issue_ref: string
  status: string
  applied_revision_id: string | null
  created_at: string
  decided_at: string | null
}

export interface MemoryEntryTable {
  id: string
  project_id: string
  character_id: string
  kind: string
  text: string
  learned_seq: number
  source_chapter_id: string
  source_revision_id: string
  source_beat_id: string | null
  importance: Generated<number>
  pinned: Generated<number>
  valid_from_seq: number | null
  valid_to_seq: number | null
  supersedes_id: string | null
  embedding_model: string
  status: Generated<string>
  created_at: string
}

export interface WorldFactTable {
  id: string
  project_id: string
  subject: string
  predicate: string
  object: string
  single_value: Generated<number>
  truth: string
  visibility: string
  known_by_json: Generated<string>
  reveal_seq: number | null
  valid_from_seq: number
  valid_to_seq: number | null
  source_type: string
  source_id: string | null
  created_at: string
}

export interface CharacterBeliefTable {
  id: string
  project_id: string
  character_id: string
  fact_id: string | null
  belief_text: string
  confidence: number
  learned_seq: number
  source_type: string
  source_id: string | null
  status: Generated<string>
  created_at: string
}

export interface RelationshipEdgeTable {
  id: string
  project_id: string
  from_id: string
  to_id: string
  axis: string
  value: number
  since_seq: number
  valid_to_seq: number | null
  source_type: string
  source_id: string | null
  supersedes_id: string | null
}

export interface ApprovalReportTable {
  id: string
  project_id: string
  chapter_id: string
  revision_id: string
  round: number
  verdict: string
  blocking_json: Generated<string>
  suggestions_json: Generated<string>
  dimensions_json: Generated<string>
  degraded: string | null
  model: string | null
  created_at: string
}

export interface GateRecordTable {
  id: string
  project_id: string
  gate_id: string
  entity_type: string
  entity_id: string
  decision: string
  actor: string
  payload_json: Generated<string>
  token_hash: string | null
  expires_at: string | null
  consumed_at: string | null
  created_at: string
}

export interface JobTable {
  id: string
  project_id: string
  type: string
  status: Generated<string>
  expected_revision: string | null
  epoch: number
  idempotency_key: string
  payload_json: string
  result_json: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}

export interface ToolCallTable {
  id: string
  project_id: string
  job_id: string
  turn_id: string
  tool: string
  tool_version: string
  actor_id: string
  scope_json: string
  args_hash: string
  result_ids_json: Generated<string>
  result_json: string | null
  status: string
  error_code: string | null
  latency_ms: number
  degraded: string | null
  idempotency_key: string | null
  created_at: string
}

export interface ModelBindingTable {
  id: string
  project_id: string
  agent_key: string
  provider: string
  model: string
  params_json: Generated<string>
  version: Generated<number>
  updated_at: string
}

export interface ModelBindingAuditTable {
  id: string
  project_id: string
  agent_key: string
  old_json: string | null
  new_json: string
  actor: string
  created_at: string
}

export interface OutboxTable {
  id: string
  project_id: string
  kind: string
  path: string
  expected_hash: string
  attempts: Generated<number>
  last_error: string | null
  published_at: string | null
  created_at: string
  chapter_id: string | null
  revision_id: string | null
  next_attempt_at: string | null
}

export interface TurnMetricTable {
  turn_id: string
  project_id: string
  job_id: string
  beat_id: string | null
  agent_key: string
  provider: string
  model: string
  binding_version: number
  tokens_in: number | null
  tokens_out: number | null
  cost_cny: number | null
  latency_ms: number | null
  first_token_ms: number | null
  context_json: string
  degraded_json: Generated<string>
  created_at: string
}

export interface MemoryProposalItemTable {
  id: string
  project_id: string
  job_id: string
  kind: string
  character_id: string | null
  text: string
  payload_json: Generated<string>
  source_chapter_id: string
  source_revision_id: string
  source_beat_id: string | null
  importance: Generated<number>
  pinned: Generated<number>
  decision: Generated<string>
  edited_text: string | null
  decided_at: string | null
}

export interface PlanSessionTable {
  id: string
  project_id: string
  title: string
  status: Generated<string>
  created_at: string
  updated_at: string
  last_message_at: string | null
}

export interface PlanMessageTable {
  id: string
  session_id: string
  project_id: string
  role: string
  kind: Generated<string>
  body: Generated<string>
  status: Generated<string>
  meta_json: Generated<string>
  attempt: Generated<number>
  retry_of: string | null
  created_at: string
  updated_at: string
}

export interface PlanCharacterTable {
  id: string
  project_id: string
  name: string
  card_json: string
  card_version: Generated<number>
  ord: number
  status: Generated<string>
  registered_character_id: string | null
  created_at: string
  updated_at: string
}

export interface PlanFactTable {
  id: string
  project_id: string
  subject: string
  predicate: string
  object: string
  visibility: Generated<string>
  ord: number
  status: Generated<string>
  created_at: string
  updated_at: string
}

export interface AgentProposalTable {
  id: string
  project_id: string
  kind: string
  status: Generated<string>
  job_id: string
  turn_id: string
  summary_json: Generated<string>
  payload_json: string
  created_at: string
  applied_at: string | null
}

export interface MemoryNamespaceTable {
  id: string
  project_id: string
  character_id: string | null
  kind: string
  name: string
  isolation_verified: Generated<number>
  created_at: string
}

export interface StoryboardDraftTable {
  chapter_id: string
  project_id: string
  rev: Generated<number>
  scenes_json: string
  updated_by: string
  updated_at: string
}

export interface WriteMessageTable {
  id: string
  project_id: string
  chapter_id: string
  role: string
  kind: Generated<string>
  body: Generated<string>
  meta_json: Generated<string>
  created_at: string
}

export interface SchedulerEventTable {
  id: string
  project_id: string
  chapter_id: string
  job_id: string | null
  kind: string
  reason: string | null
  payload_json: Generated<string>
  created_at: string
}

export interface Database {
  project: ProjectTable
  outline_node: OutlineNodeTable
  character: CharacterTable
  chapter: ChapterTable
  scene: SceneTable
  chapter_scene: ChapterSceneTable
  revision: RevisionTable
  beat: BeatTable
  revision_beat: RevisionBeatTable
  patch: PatchTable
  memory_entry: MemoryEntryTable
  world_fact: WorldFactTable
  character_belief: CharacterBeliefTable
  relationship_edge: RelationshipEdgeTable
  approval_report: ApprovalReportTable
  gate_record: GateRecordTable
  job: JobTable
  tool_call: ToolCallTable
  model_binding: ModelBindingTable
  model_binding_audit: ModelBindingAuditTable
  outbox: OutboxTable
  turn_metric: TurnMetricTable
  memory_proposal_item: MemoryProposalItemTable
  plan_session: PlanSessionTable
  plan_message: PlanMessageTable
  plan_character: PlanCharacterTable
  plan_fact: PlanFactTable
  agent_proposal: AgentProposalTable
  memory_namespace: MemoryNamespaceTable
  storyboard_draft: StoryboardDraftTable
  write_message: WriteMessageTable
  scheduler_event: SchedulerEventTable
}
