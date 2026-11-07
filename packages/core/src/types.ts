/**
 * 领域类型：与 docs/02-schema.sql 的列一一对应（camelCase）。
 * 这些是行对象，不是 DTO；校验在 store 的命令层做，这里不重复。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActorType =
  | 'user'
  | 'character'
  | 'narrator'
  | 'planner'
  | 'writer'
  | 'reviser'
  | 'critic'
  | 'director'
  | 'system';

export type AgentRole = 'character' | 'narrator' | 'planner' | 'writer' | 'reviser' | 'critic';

export type EntityKind = 'character' | 'place' | 'item' | 'org' | 'concept';
export type EntityStatus = 'active' | 'dead' | 'missing' | 'destroyed' | 'unknown';
export type Cardinality = 'single' | 'multi';
export type Truth = -1 | 0 | 1;
export type Attitude = 'knows' | 'believes' | 'suspects' | 'doubts' | 'falsely_believes';
export type Percept = 'witness' | 'told' | 'reported' | 'inferred' | 'discovered';
export type RelationAxis = 'trust' | 'affection' | 'fear' | 'debt' | 'power';
export type SceneState = 'planned' | 'open' | 'paused' | 'closing' | 'closed' | 'abandoned';
export type BeatMode = 'auto' | 'user_pick' | 'forced_narrator' | 'user_acted' | 'arbitrated';
export type MessageRole = 'character' | 'narrator' | 'director' | 'user' | 'system';
export type MessagePercept = 'public' | 'whisper' | 'soliloquy' | 'narrator_reader' | 'director' | 'system';
export type MemoryKind =
  | 'event'
  | 'summary'
  | 'fact'
  | 'preference'
  | 'relationship'
  | 'clue'
  | 'world';
export type MemoryEdgeKind = 'CAUSES' | 'SUPERSEDES' | 'DERIVED_FROM' | 'SIMILAR' | 'CO_OCCURS';
export type IssueKind = 'world' | 'character' | 'timeline' | 'logic' | 'style' | 'pacing' | 'knowledge';
export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export type IssueStatus = 'open' | 'sent_to_reviser' | 'fixed' | 'wontfix' | 'duplicate';
export type LockScope = 'fact' | 'relation' | 'entity' | 'world' | 'timeline';
export type OutboxStatus = 'pending' | 'applied' | 'failed' | 'skipped';
export type JobKind = 'summarize' | 'embed' | 'extract' | 'index';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'discarded';
export type CheckpointTrigger = 'auto' | 'manual' | 'scene_close' | 'git_commit' | 'restore';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface Branch {
  id: string;
  projectId: string;
  parentId: string | null;
  forkSeq: number;
  headSeq: number;
  name: string;
  reason: string;
  createdAt: string;
}

export interface ProjectState {
  projectId: string;
  activeBranchId: string;
  activeSceneId: string | null;
  headSeq: number;
}

export interface Checkpoint {
  id: string;
  branchId: string;
  seq: number;
  label: string;
  trigger: CheckpointTrigger;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  branchId: string;
  seq: number;
  blob: Uint8Array;
  codec: 'json' | 'zstd+json';
  bytes: number;
  createdAt: string;
}

export interface Event {
  seq: number;
  projectId: string;
  branchId: string;
  kind: string;
  actorType: ActorType;
  actorId: string | null;
  payload: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface Receipt {
  projectId: string;
  idempotencyKey: string;
  command: string;
  requestHash: string;
  resultJson: string;
  resultSeq: number | null;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  branchId: string;
  roleType: AgentRole;
  name: string;
  entityId: string | null;
  model: string;
  temperature: number;
  card: string;
  permissions: string;
  enabled: 0 | 1;
}

export interface PredicateSpec {
  predicate: string;
  cardinality: Cardinality;
  description: string;
  builtin: 0 | 1;
}

export interface Entity {
  id: string;
  branchId: string;
  kind: EntityKind;
  name: string;
  aliases: string;
  card: string;
  status: EntityStatus;
  createdSeq: number | null;
}

export interface Fact {
  id: string;
  branchId: string;
  subjectId: string;
  predicate: string;
  objectJson: string;
  card: Cardinality;
  slotKey: string;
  truth: Truth;
  secrecy: number;
  validFrom: string;
  validTo: string | null;
  sourceSeq: number | null;
  createdAt: string;
}

export interface Cognition {
  branchId: string;
  characterId: string;
  factId: string;
  attitude: Attitude;
  certainty: number;
  learnedSeq: number;
  sourceMessageId: string | null;
  percept: Percept;
}

export interface Relation {
  branchId: string;
  fromId: string;
  toId: string;
  axis: RelationAxis;
  value: number;
  updatedSeq: number;
  reason: string | null;
}

export interface MemoryNode {
  id: string;
  branchId: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  stability: number;
  conf: number;
  validFrom: string;
  lastAccess: string | null;
  accessCount: number;
  pinned: 0 | 1;
  hard: 0 | 1;
  sensitivity: number;
  ownerId: string | null;
  slotKey: string | null;
  sourceSeq: number | null;
  resolvedSeq: number | null;
  embedding: Uint8Array | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
}

export interface MemoryEdge {
  src: string;
  dst: string;
  kind: MemoryEdgeKind;
  weight: number;
}

export interface Scene {
  id: string;
  branchId: string;
  arcId: string | null;
  idx: number;
  title: string;
  locationId: string | null;
  storyStart: string;
  storyEnd: string | null;
  timeline: string;
  present: string;
  goal: string;
  conflictLevel: number;
  maxBeats: number;
  beats: number;
  state: SceneState;
  exitConditions: string;
  summary: string | null;
  openedSeq: number | null;
  closedSeq: number | null;
}

export interface Beat {
  id: string;
  branchId: string;
  sceneId: string;
  seq: number;
  agentId: string;
  score: number;
  damped: number | null;
  breakdown: string;
  mode: BeatMode;
  stale: 0 | 1;
  staleReason: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  branchId: string;
  seq: number;
  sceneId: string;
  beatId: string | null;
  agentId: string;
  roleType: MessageRole;
  prose: string;
  structured: string;
  audience: string;
  percept: MessagePercept;
  contentHash: string;
  tokenEst: number;
  createdAt: string;
  supersedesId: string | null;
}

export interface EventCardRow {
  id: string;
  branchId: string;
  title: string;
  triggerJson: string;
  minLevel: number;
  weight: number;
  oneShot: 0 | 1;
  consumedSeq: number | null;
}

export interface Chapter {
  id: string;
  branchId: string;
  arcId: string | null;
  idx: number;
  title: string;
  filePath: string;
  contentHash: string;
  wordCount: number;
  coveredUntilSeq: number | null;
  status: 'draft' | 'review' | 'final';
  currentRev: number;
  updatedSeq: number | null;
}

export interface ChapterScene {
  chapterId: string;
  sceneId: string;
  ord: number;
}

export interface Revision {
  id: string;
  chapterId: string;
  rev: number;
  parentRev: number | null;
  content: string;
  contentHash: string;
  author: 'user' | 'writer' | 'reviser';
  reason: string | null;
  issueIds: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  branchId: string;
  chapterId: string;
  rev: number;
  kind: IssueKind;
  severity: IssueSeverity;
  locator: string | null;
  description: string;
  evidence: string;
  status: IssueStatus;
  round: number;
  createdAt: string;
}

export interface Lock {
  branchId: string;
  scope: LockScope;
  slotKey: string;
  reason: string;
  lockedBy: string;
  createdAt: string;
}

export interface OutboxItem {
  id: string;
  branchId: string;
  chapterId: string;
  rev: number;
  targetPath: string;
  expectedHash: string | null;
  appliedRev: number | null;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

export interface Job {
  id: string;
  branchId: string;
  kind: JobKind;
  targetId: string | null;
  expectedSeq: number;
  generation: number;
  status: JobStatus;
  payload: string;
  createdAt: string;
}
