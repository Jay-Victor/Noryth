/**
 * 兼容入口：分镜 schema 与校验已移到 `shared`（工具层、调度器、UI 共用）。
 * 保留本文件是为了让 T27/T34 与既有测试的 import 路径不漂移。
 */
export {
  DraftBeatSchema,
  DraftSceneSchema,
  StoryboardDraftSchema,
  StoryboardConflictSchema,
  hasHardConflict,
  firstConflictReason
} from '../../../shared/schema/storyboard'

export type {
  DraftBeat,
  DraftScene,
  StoryboardDraft,
  StoryboardConflict,
  ConflictSeverity
} from '../../../shared/schema/storyboard'

export { validateStoryboard } from '../../../shared/dsl/storyboard'
export type { StoryboardCardView, StoryboardValidationOptions } from '../../../shared/dsl/storyboard'
