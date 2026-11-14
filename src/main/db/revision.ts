import type { Db } from './project-db'
import { hashManifestRows, type ManifestRow } from './hash'
import { RevisionRepo, type RevisionCreatedBy, type RevisionKind, type RevisionMemberRecord, type RevisionRecord } from './repos/revision'
import { systemClock, type Clock } from './repos/common'

export interface ManifestBeatRow extends ManifestRow {
  beatId: string
}

interface LiveManifestRow {
  beat_id: string
  scene_id: string
  scene_ord: number
  beat_ord: number
  speaker_type: 'character' | 'narrator'
  speaker_id: string
  body: string
}

/** 按章内场景顺序读取现行拍（status <> superseded），作为清单基线。 */
export function loadLiveManifest(db: Db, chapterId: string): ManifestBeatRow[] {
  const rows = db
    .prepare(
      `SELECT b.id AS beat_id, b.scene_id, cs.ord AS scene_ord, b.ord AS beat_ord,
              b.speaker_type, b.speaker_id, b.body
       FROM beat b
       JOIN chapter_scene cs ON cs.chapter_id = b.chapter_id AND cs.scene_id = b.scene_id
       WHERE b.chapter_id = ? AND b.status <> 'superseded'
       ORDER BY cs.ord, b.ord`
    )
    .all(chapterId) as LiveManifestRow[]
  return rows.map((row) => ({
    beatId: row.beat_id,
    sceneId: row.scene_id,
    sceneOrd: row.scene_ord,
    beatOrd: row.beat_ord,
    speakerType: row.speaker_type,
    speakerId: row.speaker_id,
    body: row.body
  }))
}

/**
 * 「复制父清单再替换一拍」的内存形态（PHASE-02 §5.2）：
 * 去掉被替换的旧拍与同槽位旧行，插入新拍，再按 (sceneOrd, beatOrd) 排好。
 */
export function mergeBeatIntoManifest(
  manifest: readonly ManifestBeatRow[],
  beat: ManifestBeatRow,
  supersedesId: string | null = null
): ManifestBeatRow[] {
  const kept = manifest.filter(
    (row) => row.beatId !== supersedesId && !(row.sceneId === beat.sceneId && row.beatOrd === beat.beatOrd)
  )
  kept.push(beat)
  kept.sort((a, b) => a.sceneOrd - b.sceneOrd || a.beatOrd - b.beatOrd)
  return kept
}

export interface CreateRevisionInput {
  id?: string
  chapterId: string
  parentRevisionId?: string | null
  kind: RevisionKind
  createdBy: RevisionCreatedBy
  note?: string | null
  manifest: readonly ManifestBeatRow[]
  now?: Clock
}

export interface CreateRevisionResult {
  revision: RevisionRecord
  contentHash: string
  memberCount: number
}

/**
 * 先算 hash，再一次性写 revision + revision_beat；revision 只 INSERT。
 * beat 必须已经存在（首次提交时调用方需先插 revision 再插 beat）。
 */
export function createRevisionFromManifest(db: Db, input: CreateRevisionInput): CreateRevisionResult {
  const contentHash = hashManifestRows(input.manifest)
  const repo = new RevisionRepo(db, input.now ?? systemClock)
  const revision = repo.insert({
    id: input.id,
    chapterId: input.chapterId,
    parentRevisionId: input.parentRevisionId ?? null,
    kind: input.kind,
    contentHash,
    createdBy: input.createdBy,
    note: input.note ?? null
  })
  const members: RevisionMemberRecord[] = input.manifest.map((row) => ({
    revisionId: revision.id,
    beatId: row.beatId,
    sceneOrd: row.sceneOrd,
    beatOrd: row.beatOrd
  }))
  repo.insertMembers(revision.id, members)
  return { revision, contentHash, memberCount: members.length }
}

export function createRevisionFromLiveBeats(
  db: Db,
  input: Omit<CreateRevisionInput, 'manifest'>
): CreateRevisionResult {
  return createRevisionFromManifest(db, { ...input, manifest: loadLiveManifest(db, input.chapterId) })
}

/** 从 revision_beat + beat 复算 hash；verify 用它证明 revision 未漂移。 */
export function recomputeRevisionHash(db: Db, revisionId: string): string {
  const repo = new RevisionRepo(db)
  return hashManifestRows(repo.manifest(revisionId))
}
