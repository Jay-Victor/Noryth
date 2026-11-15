import { useEffect, useState } from 'react'
import type { ReviewCompareResult, ReviewDiffHunk, ReviewState } from '../../../shared/schema/review'
import { useReview } from '../../stores/review'

/**
 * 版本列表与只读对比（PHASE-08 G5 / UI-DESIGN §6.4）。
 *
 * - revision 列表：id、kind（draft / final）、parent、hash、时间、来源。
 * - 对比任意两版：槽位级 hunk（同一拍的两版并排 + 行级增删）。
 * - 定稿只读，不能在此回退；回退走「重新打开」生成新 revision（M0 只给提示）。
 */

function HunkView({ hunk }: { hunk: ReviewDiffHunk }): React.JSX.Element {
  const [open, setOpen] = useState(hunk.status !== 'same')
  useEffect(() => {
    setOpen(hunk.status !== 'same')
  }, [hunk])
  return (
    <div
      className={`review-hunk-row is-${hunk.status}`}
      data-testid={`review-hunk-${hunk.sceneOrd}-${hunk.beatOrd}`}
      data-status={hunk.status}
    >
      <button type="button" className="review-hunk-row__head" onClick={() => setOpen(!open)}>
        <span className="mono">
          场景 {hunk.sceneOrd} · 拍 {String(hunk.beatOrd).padStart(2, '0')}
        </span>
        <span>{hunk.speakerName}</span>
        <span className="review-hunk-row__badge">
          {hunk.status === 'same' ? '未变' : hunk.status === 'changed' ? '已改' : hunk.status === 'added' ? '新增' : '删除'}
        </span>
      </button>
      {open ? (
        <div className="review-hunk-lines">
          {hunk.lines.map((line, index) => (
            <div key={`${index}-${line.kind}`} className={`review-line is-${line.kind}`}>
              <span className="review-line__no">{line.leftNo || ''}</span>
              <span className="review-line__no">{line.rightNo || ''}</span>
              <span className="review-line__text">{line.text || ' '}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function VersionList({ state }: { state: ReviewState }): React.JSX.Element {
  const compare = useReview((store) => store.compare)
  const busy = useReview((store) => store.busy)
  const [left, setLeft] = useState<string>('')
  const [right, setRight] = useState<string>('')

  const versions = state.versions
  useEffect(() => {
    if (versions.length === 0) return
    const current = state.revisionId ?? versions[versions.length - 1]!.id
    const previous =
      versions.find((version) => version.id !== current && version.kind === 'draft')?.id ??
      versions[versions.length - 1]!.id
    setLeft((value) => (value && versions.some((version) => version.id === value) ? value : previous))
    setRight((value) => (value && versions.some((version) => version.id === value) ? value : current))
  }, [state.revisionId, versions])

  return (
    <div className="review-versions" data-testid="review-versions">
      <div className="review-versions__head">
        <span>版本（{versions.length}）</span>
        <span className="review-note">定稿只读，不能在此回退</span>
      </div>

      <div className="review-version-compare">
        <label>
          左
          <select
            data-testid="review-compare-left"
            value={left}
            onChange={(event) => setLeft(event.target.value)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.id}（{version.kind}）
              </option>
            ))}
          </select>
        </label>
        <label>
          右
          <select
            data-testid="review-compare-right"
            value={right}
            onChange={(event) => setRight(event.target.value)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.id}（{version.kind}）
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="review-compare-run"
          disabled={!left || !right || left === right || busy}
          onClick={() => void useReview.getState().compareRevisions(left, right)}
        >
          对比
        </button>
      </div>

      <table className="review-version-table">
        <thead>
          <tr>
            <th>revision</th>
            <th>kind</th>
            <th>parent</th>
            <th>来源</th>
            <th>hash</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr
              key={version.id}
              className={version.id === state.revisionId ? 'is-current' : ''}
              data-testid={`review-version-${version.id}`}
              data-kind={version.kind}
            >
              <td className="mono">{version.id}</td>
              <td>{version.kind === 'final' ? '定稿' : '草稿'}</td>
              <td className="mono">{version.parentRevisionId ?? '—'}</td>
              <td>{version.createdBy}</td>
              <td className="mono">{version.contentHash.slice(0, 10)}</td>
              <td>{version.createdAt.slice(0, 19).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {compare ? (
        <div className="review-compare-result" data-testid="review-compare-result">
          <div className="review-compare-result__head">
            <span className="mono">
              {compare.leftRevisionId} → {compare.rightRevisionId}
            </span>
            <span>{compare.changedBeats} 拍有变化</span>
          </div>
          {compare.hunks.map((hunk) => (
            <HunkView key={`${hunk.sceneOrd}-${hunk.beatOrd}-${hunk.status}`} hunk={hunk} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export type { ReviewCompareResult }
