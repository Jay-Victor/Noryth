import { useMemo, useState } from 'react'
import type { WriteSceneLibraryItem, WriteState } from '../../../shared/schema/write'
import { useWrite } from '../../stores/write'

/**
 * 场景库（PHASE-12 M1-1 / §5.4）。
 *
 * 只做四件事：列出项目级场景、搜索、链接/解链到本章、fork 到本章。
 * - 空场景可以被多章同时链接（规划期），不产生正文；
 * - 已在别的章演出的场景在本章是「只读引用」，要演出必须 fork；
 * - 场景库不写正文，唯一写入者仍是 `commitBeat`。
 */

const TIMELINE_LABELS: Record<WriteSceneLibraryItem['timeline'], string> = {
  main: '主线',
  flashback: '闪回',
  dream: '梦境'
}

export function SceneLibrary({ state }: { state: WriteState }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const busy = useWrite((store) => store.busy)

  const items = useMemo(() => {
    const text = query.trim()
    if (text.length === 0) return state.library
    return state.library.filter(
      (item) => item.location.includes(text) || item.goal.includes(text)
    )
  }, [state.library, query])

  const performed = state.library.filter((item) => item.liveBeats > 0).length
  const linked = state.library.filter((item) => item.linkedToCurrent).length

  return (
    <div className="write-library" data-testid="scene-library">
      <button
        type="button"
        className="write-library__toggle"
        data-testid="scene-library-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>场景库 · {state.library.length} 场（本章链接 {linked}）</span>
        <span className="pane-header__meta">{performed} 场已演出</span>
        <span className="write-library__chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="write-library__body">
          <input
            className="write-input"
            data-testid="scene-library-search"
            placeholder="搜索地点或目标"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {items.length === 0 ? (
            <p className="write-note">
              {state.library.length === 0 ? '还没有场景。开演（G2）后场景会进场景库。' : '没有匹配的场景。'}
            </p>
          ) : (
            <ul className="write-library__list" data-testid="scene-library-list">
              {items.map((item) => {
                const isReference = item.ownerChapterOrd !== null && item.ownerChapterOrd !== state.chapterOrd
                const canLink = !item.linkedToCurrent && (!item.ownerChapterOrd || item.ownedByCurrent)
                const canUnlink = item.linkedToCurrent && item.liveBeats === 0
                const canFork = isReference
                const canRemove = item.liveBeats === 0 && item.linkedChapterOrds.length === 0
                return (
                  <li
                    key={item.id}
                    className={`write-library__item${item.linkedToCurrent ? ' is-linked' : ''}`}
                    data-testid={`scene-library-item-${item.id}`}
                  >
                    <div className="write-library__row">
                      <span className="write-library__location">{item.location}</span>
                      {item.timeline !== 'main' ? (
                        <span className="write-badge write-badge--timeline" data-testid={`scene-library-timeline-${item.id}`}>
                          {TIMELINE_LABELS[item.timeline]}
                        </span>
                      ) : null}
                      {item.liveBeats > 0 ? (
                        <span className="write-library__meta">
                          第 {item.ownerChapterOrd} 章演出 · {item.liveBeats} 拍
                        </span>
                      ) : (
                        <span className="write-library__meta">
                          未演出{item.linkedChapterOrds.length > 0 ? ` · 链接 ${item.linkedChapterOrds.join('、')}` : ''}
                        </span>
                      )}
                      {isReference && item.linkedToCurrent ? (
                        <span className="write-badge write-badge--reference" data-testid={`scene-library-reference-${item.id}`}>
                          只读引用
                        </span>
                      ) : null}
                    </div>
                    <div className="write-library__actions">
                      {item.storyStart ? <span className="write-library__time">{item.storyStart}</span> : null}
                      {canLink ? (
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`scene-link-${item.id}`}
                          disabled={state.readOnly || busy}
                          onClick={() => void useWrite.getState().linkScene(item.id)}
                        >
                          链接到本章
                        </button>
                      ) : null}
                      {canUnlink ? (
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`scene-unlink-${item.id}`}
                          disabled={state.readOnly || busy}
                          onClick={() => void useWrite.getState().unlinkScene(item.id)}
                        >
                          解链
                        </button>
                      ) : null}
                      {canFork ? (
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`scene-fork-${item.id}`}
                          disabled={state.readOnly || busy}
                          title={`复制场景与拍到本章；第 ${item.ownerChapterOrd} 章不动`}
                          onClick={() => void useWrite.getState().forkScene(item.id)}
                        >
                          fork 到本章
                        </button>
                      ) : null}
                      {canRemove ? (
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`scene-remove-${item.id}`}
                          disabled={state.readOnly || busy}
                          onClick={() => void useWrite.getState().removeScene(item.id)}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
