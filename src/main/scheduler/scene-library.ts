import { AppError } from '../../shared/domain/app-error'
import type { DraftScene } from '../../shared/schema/storyboard'
import type { WriteSceneLibraryItem } from '../../shared/schema/write'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import { newId } from '../db/repos/common'
import type { SceneRecord, SceneTimeline } from '../db/repos/scene'
import { hashManifestRows, hashText } from '../db/hash'
import type { ManifestBeatRow } from '../db/revision'
import { withTransaction } from '../db/tx'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../doc/mirror'
import { readStoryboardDraft, saveStoryboardDraft } from './storyboard'

/**
 * 场景库与章↔场景多对多（PHASE-12 M1-1 / §5.1）。
 *
 * 语义：
 * - `scene` 是项目级；`chapter_scene` 是章内顺序的唯一真相。
 * - 规划期：无 live 拍的场景可以链接多章（比较/复用），不产生正文。
 * - 演出期：场景的 live 拍只属于一个演出章。别的章要演出同一场景必须 fork。
 * - 引用章只读：引用场不进本章 revision 清单，也不出现在本章正文。
 * - fork 复制 scene + live 拍（新 id、新 revision），旧章正文与 revision 不变。
 *
 * 这里只写 scene / chapter_scene / 复制出的拍与 revision；正文的唯一写入者仍是
 * `commitBeat`（fork 复制的是已有正文行，不新写文本）。
 */

function requireChapter(repos: Repos, chapterId: string): ChapterRecord {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('invalid_args', '章不存在', { chapterId })
  if (chapter.finalRevisionId !== null) {
    throw new AppError('invalid_args', '已定稿章节不能改场景', { chapterId })
  }
  return chapter
}

function requireScene(repos: Repos, chapter: ChapterRecord, sceneId: string): SceneRecord {
  const scene = repos.scene.get(sceneId)
  if (!scene || scene.projectId !== chapter.projectId) {
    throw new AppError('invalid_args', '场景不在本项目', { sceneId })
  }
  return scene
}

/** 场景库视图：一次读 scenes + links + 演出归属，供 UI 列表与 fork 判定共用。 */
export function sceneLibraryEntries(
  repos: Repos,
  projectId: string,
  currentChapterId: string
): WriteSceneLibraryItem[] {
  const scenes = repos.scene.listByProject(projectId)
  const links = repos.scene.listLinksByProject(projectId)
  const usage = repos.scene.listUsageByProject(projectId)

  const linksByScene = new Map<string, number[]>()
  for (const link of links) {
    const list = linksByScene.get(link.sceneId) ?? []
    list.push(link.chapterOrd)
    linksByScene.set(link.sceneId, list)
  }
  // 正常项目一个场景只有一行 usage；多行说明跨章共享正文，取第一章展示，verify 拦截。
  const ownerByScene = new Map<string, { chapterId: string; chapterOrd: number; liveBeats: number }>()
  for (const row of usage) {
    if (!ownerByScene.has(row.sceneId)) {
      ownerByScene.set(row.sceneId, {
        chapterId: row.chapterId,
        chapterOrd: row.chapterOrd,
        liveBeats: row.liveBeats
      })
    }
  }
  const currentOrd = repos.chapter.get(currentChapterId)?.ord ?? -1

  return scenes.map((scene) => {
    const owner = ownerByScene.get(scene.id)
    const linkedChapterOrds = [...new Set(linksByScene.get(scene.id) ?? [])].sort((a, b) => a - b)
    return {
      id: scene.id,
      ord: scene.ord,
      location: scene.location,
      goal: scene.goal,
      status: scene.status,
      timeline: scene.timeline,
      storyStart: scene.storyStart,
      storyEnd: scene.storyEnd,
      liveBeats: owner?.liveBeats ?? 0,
      ownerChapterOrd: owner?.chapterOrd ?? null,
      linkedChapterOrds,
      linkedToCurrent: linkedChapterOrds.includes(currentOrd),
      ownedByCurrent: owner?.chapterId === currentChapterId
    }
  })
}

/**
 * 链接场景到章。
 *
 * - 已在本章演出（或空场景）→ 直接链接（幂等）。
 * - 已在别的章演出 → `invalid_args`，要求 fork（引用章只读，不共享正文）。
 * - 链接同时把场景写进本章分镜草案，否则 G2 物化时会被当成「草案里没有」而解链。
 */
export function linkSceneToChapter(db: Db, repos: Repos, input: { chapterId: string; sceneId: string }): void {
  withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    const scene = requireScene(repos, chapter, input.sceneId)
    const linked = repos.scene.listByChapter(chapter.id)
    if (linked.some((entry) => entry.scene.id === scene.id)) return

    const owner = repos.scene.ownerChapter(scene.id)
    if (owner && owner.chapterId !== chapter.id) {
      throw new AppError('invalid_args', `场景已在第 ${owner.chapterOrd} 章演出；要在这里演出请 fork 到本章`, {
        sceneId: scene.id,
        needsFork: true,
        ownerChapterOrd: owner.chapterOrd
      })
    }

    const ord = linked.reduce((max, entry) => Math.max(max, entry.chapterOrd), 0) + 1
    repos.scene.linkToChapter(chapter.id, scene.id, ord)
    appendDraftScene(repos, chapter, scene, [])
  })
}

/** 解链：只删 `chapter_scene`，不删 scene，也不动正文。演出中的场景不能解链。 */
export function unlinkSceneFromChapter(db: Db, repos: Repos, input: { chapterId: string; sceneId: string }): void {
  withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    const scene = requireScene(repos, chapter, input.sceneId)
    const owned = repos.beat.listLiveByChapter(chapter.id).filter((beat) => beat.sceneId === scene.id)
    if (owned.length > 0) {
      throw new AppError('invalid_args', '场景在本章已有拍；先撤回这些拍再解链', {
        sceneId: scene.id,
        beatIds: owned.map((beat) => beat.id)
      })
    }
    const remaining = repos.scene
      .listByChapter(chapter.id)
      .filter((entry) => entry.scene.id !== scene.id)
    repos.scene.replaceChapterOrder(
      chapter.id,
      remaining.map((entry) => entry.scene.id)
    )
    removeDraftScene(repos, chapter, scene.id)
  })
}

/**
 * 章内顺序：只改 `chapter_scene.ord`，不改 `scene.ord`（场景库顺序）。
 * 传入的 id 必须与本章现有链接集合完全一致，避免一次拖拽静默增删场景。
 *
 * 有 live 拍时拒绝：正文顺序是 revision 的一部分，改顺序必须走分镜 + 重新开演
 * （G2 会生成新 revision），否则镜像与清单会与 `chapter_scene` 分叉。
 */
export function reorderChapterScenes(
  db: Db,
  repos: Repos,
  input: { chapterId: string; sceneIds: readonly string[] }
): void {
  withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    const existing = repos.scene.listByChapter(chapter.id).map((entry) => entry.scene.id)
    const requested = [...input.sceneIds]
    if (existing.length !== requested.length || !existing.every((id) => requested.includes(id))) {
      throw new AppError('invalid_args', '排序列表必须与本章场景集合一致', {
        chapterId: chapter.id,
        expected: existing,
        received: requested
      })
    }
    if (repos.beat.listLiveByChapter(chapter.id).length > 0) {
      throw new AppError('invalid_args', '本章已有正文；改顺序请改分镜并重新开演', { chapterId: chapter.id })
    }
    repos.scene.replaceChapterOrder(chapter.id, requested)
    reorderDraftScenes(repos, chapter, requested)
  })
}

/** 三轴编辑：故事时间（自由文本）与时间轴标签；M1 只存与展示，不比较。 */
export function updateSceneTime(
  repos: Repos,
  input: {
    chapterId: string
    sceneId: string
    storyStart?: string | null
    storyEnd?: string | null
    timeline?: SceneTimeline
  }
): SceneRecord {
  const chapter = requireChapter(repos, input.chapterId)
  const scene = requireScene(repos, chapter, input.sceneId)
  const linked = repos.scene.listChaptersByScene(scene.id)
  if (!linked.some((link) => link.chapterId === chapter.id)) {
    throw new AppError('invalid_args', '场景未链接到本章；先链接再改时间', { sceneId: scene.id })
  }
  return repos.scene.update(scene.id, {
    ...(input.storyStart === undefined ? {} : { storyStart: input.storyStart }),
    ...(input.storyEnd === undefined ? {} : { storyEnd: input.storyEnd }),
    ...(input.timeline === undefined ? {} : { timeline: input.timeline })
  })
}

/** 删除场景：无 live 拍、且没有被别的章引用；本章的链接一并解掉（不删正文）。 */
export function removeScene(db: Db, repos: Repos, input: { chapterId: string; sceneId: string }): void {
  withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    const scene = requireScene(repos, chapter, input.sceneId)
    if (repos.scene.liveBeatCount(scene.id) > 0) {
      throw new AppError('invalid_args', '场景已有演出拍，不能删除；先撤回或改分镜', { sceneId: scene.id })
    }
    const links = repos.scene.listChaptersByScene(scene.id)
    const other = links.find((link) => link.chapterId !== chapter.id)
    if (other) {
      throw new AppError('invalid_args', `场景仍被第 ${other.chapterOrd} 章引用，先解链`, {
        sceneId: scene.id,
        chapterOrd: other.chapterOrd
      })
    }
    for (const link of links) repos.scene.unlinkFromChapter(link.chapterId, scene.id)
    removeDraftScene(repos, chapter, scene.id)
    repos.scene.remove(scene.id)
  })
}

export interface ForkResult {
  sceneId: string
  chapterId: string
  beatCount: number
  revisionId: string | null
}

/**
 * fork 场景到本章（PHASE-12 §5.1）：
 * - 复制 scene（新 id，三轴原样保留）与 live 拍（新 id、正文复制、状态 waiting_for_human/proposed）；
 * - 新拍进一个**新 revision**（本章旧内容不变，另一章完全不动）；
 * - 不复制 `supersedes_id`：fork 是新血统，复用会让 `beat_supersedes_once` 与追溯链分叉；
 * - 本章原有的引用链接被新场景替换，草案同步换成可编辑的场景。
 */
export function forkSceneIntoChapter(db: Db, repos: Repos, input: { chapterId: string; sceneId: string }): ForkResult {
  return withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    const source = requireScene(repos, chapter, input.sceneId)
    const owner = repos.scene.ownerChapter(source.id)
    if (owner && owner.chapterId === chapter.id) {
      throw new AppError('invalid_args', '场景已在本章演出，不需要 fork', { sceneId: source.id })
    }
    const sourceBeats = repos.beat.listLiveByScene(source.id)
    if (sourceBeats.length === 0) {
      throw new AppError('invalid_args', '场景还没有演出，直接链接即可，不需要 fork', {
        sceneId: source.id,
        needsFork: false
      })
    }

    const linksBefore = repos.scene.listByChapter(chapter.id)
    const sourceLink = linksBefore.find((entry) => entry.scene.id === source.id)
    const at = repos.scene.listByProject(chapter.projectId).reduce((max, scene) => Math.max(max, scene.ord), 0)
    const newScene = repos.scene.insert({
      projectId: chapter.projectId,
      ord: at + 1,
      location: source.location,
      participantsJson: source.participantsJson,
      goal: source.goal,
      entry: source.entry,
      exitJson: source.exitJson,
      status: 'planned',
      maxBeats: source.maxBeats,
      storyStart: source.storyStart,
      storyEnd: source.storyEnd,
      timeline: source.timeline
    })

    // 章内顺序：替换引用链接的位置，否则追加到末尾。
    const orderedIds = linksBefore.map((entry) => entry.scene.id)
    const chapterOrd = sourceLink ? sourceLink.chapterOrd : orderedIds.length + 1
    const nextOrder = sourceLink
      ? orderedIds.map((id) => (id === source.id ? newScene.id : id))
      : [...orderedIds, newScene.id]
    repos.scene.replaceChapterOrder(chapter.id, nextOrder)

    const sceneOrdOf = new Map<string, number>()
    nextOrder.forEach((id, index) => sceneOrdOf.set(id, index + 1))

    const existingBeats = repos.beat.listLiveByChapter(chapter.id)
    const existingRows: ManifestBeatRow[] = existingBeats.map((beat) => ({
      beatId: beat.id,
      sceneId: beat.sceneId,
      sceneOrd: sceneOrdOf.get(beat.sceneId) ?? 0,
      beatOrd: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: beat.body
    }))
    const copied = sourceBeats.map((beat) => ({ beat, id: newId('bt') }))
    const copiedRows: ManifestBeatRow[] = copied.map(({ beat, id }) => ({
      beatId: id,
      sceneId: newScene.id,
      sceneOrd: chapterOrd,
      beatOrd: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: beat.body
    }))
    const manifest = [...existingRows, ...copiedRows].sort(
      (left, right) => left.sceneOrd - right.sceneOrd || left.beatOrd - right.beatOrd
    )
    const contentHash = hashManifestRows(manifest)
    const revisionId = newId('rev')
    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: chapter.currentRevisionId,
      kind: 'draft',
      contentHash,
      createdBy: 'author',
      note: `scene fork ${source.id}`
    })

    for (const { beat, id } of copied) {
      repos.beat.insert({
        id,
        chapterId: chapter.id,
        sceneId: newScene.id,
        ord: beat.ord,
        seq: null,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        intent: beat.intent,
        body: beat.body,
        groundingJson: beat.groundingJson,
        traceRef: null,
        status: beat.body.trim().length > 0 ? 'waiting_for_human' : 'proposed',
        createdRevisionId: revisionId,
        maxWords: beat.maxWords,
        wordCount: beat.wordCount
      })
    }

    repos.revision.insertMembers(
      revisionId,
      manifest.map((row) => ({
        revisionId,
        beatId: row.beatId,
        sceneOrd: row.sceneOrd,
        beatOrd: row.beatOrd
      }))
    )
    repos.chapter.setCurrentRevision(chapter.id, revisionId)

    if (sourceLink) removeDraftScene(repos, chapter, source.id)
    appendDraftScene(
      repos,
      chapter,
      newScene,
      copied.map(({ beat, id }) => ({ ...beat, id }))
    )

    const mirrorHash = hashText(renderChapterMarkdown(db, { chapterId: chapter.id, revisionId }))
    repos.outbox.enqueue({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      revisionId,
      path: chapterMirrorRelPath(chapter.ord),
      expectedHash: mirrorHash
    })

    return {
      sceneId: newScene.id,
      chapterId: chapter.id,
      beatCount: copied.length,
      revisionId
    }
  })
}

// ── 草案同步（分镜草案是 G2 的唯一真相，链接变化必须回写） ──────────────────

function draftScenesOf(repos: Repos, chapter: ChapterRecord): DraftScene[] {
  return readStoryboardDraft(repos, chapter.id)?.scenes ?? []
}

function appendDraftScene(
  repos: Repos,
  chapter: ChapterRecord,
  scene: SceneRecord,
  beats: Array<Pick<BeatRecord, 'ord' | 'speakerType' | 'speakerId' | 'intent' | 'maxWords'>>
): void {
  const scenes = draftScenesOf(repos, chapter)
  if (scenes.some((item) => item.scene_id === scene.id)) return
  const exitText = exitTextOf(scene.exitJson)
  const participants = participantsOf(scene.participantsJson)
  const entry: DraftScene = {
    scene_id: scene.id,
    location: scene.location,
    participants,
    goal: scene.goal,
    entry: scene.entry,
    ...(exitText === null ? {} : { exit: exitText }),
    max_beats: scene.maxBeats,
    beats: beats.map((beat) => ({
      ord: beat.ord,
      speaker_type: beat.speakerType,
      speaker_id: beat.speakerId,
      intent: beat.intent,
      ...(beat.maxWords === null ? {} : { max_words: beat.maxWords })
    }))
  }
  saveStoryboardDraft(repos, {
    chapterId: chapter.id,
    updatedBy: 'author',
    scenes: [...scenes, entry]
  })
}

function removeDraftScene(repos: Repos, chapter: ChapterRecord, sceneId: string): void {
  const scenes = draftScenesOf(repos, chapter)
  if (!scenes.some((item) => item.scene_id === sceneId)) return
  const next = scenes.filter((item) => item.scene_id !== sceneId)
  // 删到 0 场 = 回到「未分镜」：删掉草案行，UI 显示空态而不是空表。
  if (next.length === 0) {
    repos.storyboard.remove(chapter.id)
    return
  }
  saveStoryboardDraft(repos, { chapterId: chapter.id, updatedBy: 'author', scenes: next })
}

function reorderDraftScenes(repos: Repos, chapter: ChapterRecord, sceneIds: readonly string[]): void {
  const scenes = draftScenesOf(repos, chapter)
  if (scenes.length === 0) return
  const byId = new Map(scenes.filter((scene) => scene.scene_id).map((scene) => [scene.scene_id!, scene]))
  const ordered: DraftScene[] = []
  for (const id of sceneIds) {
    const scene = byId.get(id)
    if (scene) ordered.push(scene)
  }
  // 草案里还没物化的新场景（无 scene_id）保持在末尾。
  for (const scene of scenes) {
    if (!scene.scene_id) ordered.push(scene)
  }
  if (ordered.length === scenes.length) {
    saveStoryboardDraft(repos, { chapterId: chapter.id, updatedBy: 'author', scenes: ordered })
  }
}

function participantsOf(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function exitTextOf(json: string): string | null {
  try {
    const value = JSON.parse(json) as unknown
    if (value === null || typeof value !== 'object') return null
    const dsl = (value as { dsl?: unknown }).dsl
    return typeof dsl === 'string' ? dsl : null
  } catch {
    return null
  }
}
