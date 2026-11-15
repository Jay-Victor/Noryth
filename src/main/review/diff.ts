import { AppError } from '../../shared/domain/app-error'
import type { ReviewCompareResult, ReviewDiffHunk, ReviewDiffLine } from '../../shared/schema/review'
import type { Repos } from '../db/repos'
import type { ManifestMemberRecord } from '../db/repos/revision'
/**
 * 版本对比（PHASE-08 G5 / UI-DESIGN §9.3）。
 *
 * 对齐单位是**槽位** `(sceneOrd, beatOrd)` 而不是 beat_id：patch 之后同一槽位
 * 是新的 beat 行，按 id 对齐会把每一处修订都显示成「删一段 + 加一段」。
 * 每个槽位一个 hunk，行号左/右分别编号，UI 负责折叠未变更段落。
 */

export type DiffLine = ReviewDiffLine
export type DiffHunk = ReviewDiffHunk
function splitLines(body: string): string[] {
  return body.length === 0 ? [] : body.split('\n')
}

/** LCS 行级 diff；超过 400 行退化为整段替换，避免 O(n²) 拖垮渲染。 */
export function diffLines(left: string, right: string): DiffLine[] {
  const a = splitLines(left)
  const b = splitLines(right)
  if (a.length === 0 && b.length === 0) return []
  if (a.length > 400 || b.length > 400) {
    const lines: DiffLine[] = a.map((text, index) => ({
      kind: 'remove' as const,
      leftNo: index + 1,
      rightNo: 0,
      text
    }))
    for (const [index, text] of b.entries()) {
      lines.push({ kind: 'add', leftNo: 0, rightNo: index + 1, text })
    }
    return lines
  }

  const rows = a.length + 1
  const cols = b.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', leftNo: i + 1, rightNo: j + 1, text: a[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'remove', leftNo: i + 1, rightNo: 0, text: a[i]! })
      i += 1
    } else {
      lines.push({ kind: 'add', leftNo: 0, rightNo: j + 1, text: b[j]! })
      j += 1
    }
  }
  while (i < a.length) {
    lines.push({ kind: 'remove', leftNo: i + 1, rightNo: 0, text: a[i]! })
    i += 1
  }
  while (j < b.length) {
    lines.push({ kind: 'add', leftNo: 0, rightNo: j + 1, text: b[j]! })
    j += 1
  }
  return lines
}

interface Slot {
  sceneOrd: number
  beatOrd: number
  member: ManifestMemberRecord | null
}

function slotKey(member: ManifestMemberRecord): string {
  return `${member.sceneOrd}:${member.beatOrd}`
}

function slotMap(members: readonly ManifestMemberRecord[]): Map<string, ManifestMemberRecord> {
  const map = new Map<string, ManifestMemberRecord>()
  for (const member of members) map.set(slotKey(member), member)
  return map
}

function speakerName(repos: Repos, member: ManifestMemberRecord | null): string {
  if (!member) return ''
  if (member.speakerType === 'narrator') return '旁白'
  return repos.character.get(member.speakerId)?.name ?? member.speakerId
}

export function compareRevisions(
  repos: Repos,
  input: { chapterId: string; leftRevisionId: string; rightRevisionId: string }
): ReviewCompareResult {
  const left = repos.revision.get(input.leftRevisionId)
  const right = repos.revision.get(input.rightRevisionId)
  if (!left || !right) throw new AppError('invalid_args', 'revision not found')
  if (left.chapterId !== input.chapterId || right.chapterId !== input.chapterId) {
    throw new AppError('invalid_args', '两个 revision 必须属于同一章')
  }
  const leftMembers = repos.revision.manifest(left.id)
  const rightMembers = repos.revision.manifest(right.id)
  const rightBySlot = slotMap(rightMembers)

  const slots: Slot[] = [
    ...leftMembers.map((member) => ({ sceneOrd: member.sceneOrd, beatOrd: member.beatOrd, member })),
    ...rightMembers
      .filter((member) => !leftMembers.some((row) => slotKey(row) === slotKey(member)))
      .map((member) => ({ sceneOrd: member.sceneOrd, beatOrd: member.beatOrd, member: null }))
  ].sort((a, b) => a.sceneOrd - b.sceneOrd || a.beatOrd - b.beatOrd)

  const hunks: ReviewDiffHunk[] = []
  let changedBeats = 0
  for (const slot of slots) {
    const leftMember = slot.member
    const rightMember = rightBySlot.get(`${slot.sceneOrd}:${slot.beatOrd}`) ?? null
    let status: ReviewDiffHunk['status']
    if (leftMember && !rightMember) status = 'removed'
    else if (!leftMember && rightMember) status = 'added'
    else if (leftMember && rightMember && leftMember.body === rightMember.body) status = 'same'
    else status = 'changed'
    if (status !== 'same') changedBeats += 1

    const lines =
      status === 'same'
        ? splitLines(leftMember?.body ?? '').map((text, index) => ({
            kind: 'same' as const,
            leftNo: index + 1,
            rightNo: index + 1,
            text
          }))
        : diffLines(leftMember?.body ?? '', rightMember?.body ?? '')

    hunks.push({
      beatId: rightMember?.beatId ?? leftMember?.beatId ?? null,
      sceneOrd: slot.sceneOrd,
      beatOrd: slot.beatOrd,
      speakerName: speakerName(repos, rightMember ?? leftMember),
      status,
      leftBeatId: leftMember?.beatId ?? null,
      rightBeatId: rightMember?.beatId ?? null,
      lines
    })
  }

  return {
    chapterId: input.chapterId,
    leftRevisionId: left.id,
    rightRevisionId: right.id,
    leftHash: left.contentHash,
    rightHash: right.contentHash,
    changedBeats,
    hunks
  }
}
