import { useEffect, useRef, useState } from 'react'
import type { WriteBeatState, WriteState } from '../../../shared/schema/write'
import { useWrite } from '../../stores/write'
import { BeatCard } from './BeatCard'

/**
 * 正文视图（UI-DESIGN §5.4）：
 * - 连续正文，不按拍分块；左侧 26px gutter 显示拍号，点击打开拍卡。
 * - 当前拍左侧 2px accent；stale 右上角虚线徽标；author_edited 显示「已手改」。
 * - 流式只更新当前拍：已确认段落不会重排（store 按 beatId 写增量）。
 * - 编辑以拍为单位；保存走 IPC，Enter 不提交（IME 安全）。
 */

export function ProseView({
  state,
  activeBeatId,
  onSelectBeat
}: {
  state: WriteState
  activeBeatId: string | null
  onSelectBeat: (beatId: string | null) => void
}): React.JSX.Element {
  const streaming = useWrite((store) => store.streaming)
  const editingBeatId = useWrite((store) => store.editingBeatId)
  const editDraft = useWrite((store) => store.editDraft)
  const [openBeatId, setOpenBeatId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const streamStart = useRef<number | null>(null)

  const streamingBeatId = Object.keys(streaming)[0] ?? null
  useEffect(() => {
    if (!streamingBeatId) {
      streamStart.current = null
      setElapsed(0)
      return
    }
    streamStart.current = Date.now()
    const timer = setInterval(() => {
      if (streamStart.current === null) return
      setElapsed(Math.round((Date.now() - streamStart.current) / 100) / 10)
    }, 200)
    return () => clearInterval(timer)
  }, [streamingBeatId])

  const beats = state.scenes.flatMap((scene) => scene.beats)
  const numbers = new Map(beats.map((beat, index) => [beat.id, index + 1]))
  if (beats.length === 0) {
    return (
      <div className="write-prose" data-testid="write-prose">
        <div className="pane-empty">
          <h3>空正文</h3>
          <p>先到「分镜」写三场戏，再过 G2 开演。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="write-prose" data-testid="write-prose">
      {state.scenes.map((scene) => {
        const sceneBeats = scene.beats
        if (sceneBeats.length === 0) return null
        const visible = sceneBeats.filter((beat) => beat.body.trim().length > 0 || beat.id === streamingBeatId || beat.status === 'generating' || beat.status === 'regenerating')
        const pending = sceneBeats.find((beat) => beat.status === 'proposed' || beat.status === 'rejected' || beat.status === 'interrupted')
        return (
          <section key={scene.id} className="write-scene" data-testid={`write-scene-${scene.ord}`}>
            <header className="write-scene-head">
              <span className="write-scene-ord">场景 {scene.ord}</span>
              <span>{scene.location}</span>
              <span className="write-scene-goal">{scene.goal}</span>
              <span className="write-scene-exit" data-satisfied={scene.exitSatisfied}>
                出口 {scene.exitSatisfied ? '已满足' : '未满足'}
              </span>
            </header>

            {visible.map((beat) => (
              <div
                key={beat.id}
                className={`write-para${beat.id === (activeBeatId ?? state.currentBeatId) ? ' is-current' : ''}${
                  beat.status === 'stale' ? ' is-stale' : ''
                }`}
                data-testid={`write-para-${beat.id}`}
                data-status={beat.status}
                onClick={() => {
                  onSelectBeat(beat.id)
                  setOpenBeatId((value) => (value === beat.id ? null : beat.id))
                }}
              >
                <button
                  type="button"
                  className="write-gutter"
                  data-testid={`write-gutter-${beat.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelectBeat(beat.id)
                    setOpenBeatId(openBeatId === beat.id ? null : beat.id)
                  }}
                  title={`${beat.speakerName} · ${beat.id}`}
                >
                  {beatLabel(numbers.get(beat.id) ?? 0)}
                </button>

                <div className="write-para__body">
                  {beat.status === 'stale' ? <span className="write-badge is-stale">上游已改</span> : null}
                  {beat.authorEdited ? <span className="write-badge is-edited">已手改</span> : null}

                  {editingBeatId === beat.id ? (
                    <div className="write-edit" onClick={(event) => event.stopPropagation()}>
                      <textarea
                        className="write-edit__input"
                        data-testid={`write-edit-input-${beat.id}`}
                        value={editDraft}
                        rows={4}
                        onChange={(event) => useWrite.getState().setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') useWrite.getState().cancelEdit()
                        }}
                      />
                      <div className="write-edit__actions">
                        <button
                          type="button"
                          className="plan-btn"
                          data-testid={`write-edit-save-${beat.id}`}
                          onClick={() => void useWrite.getState().saveEdit()}
                        >
                          保存
                        </button>
                        <button type="button" className="plan-mini-btn" onClick={() => useWrite.getState().cancelEdit()}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="write-para__text">
                      {beat.id === streamingBeatId ? streaming[beat.id] ?? beat.body : beat.body || '…'}
                      {beat.id === streamingBeatId ? <span className="write-caret" aria-hidden="true" /> : null}
                    </p>
                  )}

                  {beat.id === streamingBeatId ? (
                    <span className="write-stream-meta" data-testid="write-streaming">
                      生成中 {elapsed.toFixed(1)}s
                    </span>
                  ) : null}
                </div>

                {openBeatId === beat.id ? (
                  <BeatCard beat={beat} traceRef={beat.traceRef} onClose={() => setOpenBeatId(null)} />
                ) : null}
              </div>
            ))}

            {pending ? (
              <div className="write-placeholder" data-testid={`write-placeholder-${pending.id}`}>
                <span className="write-gutter">{beatLabel(beats.indexOf(pending) + 1)}</span>
                <span>
                  {pending.status === 'interrupted'
                    ? '上一拍被中断，可重试'
                    : pending.status === 'rejected'
                      ? '上一拍未通过校验，可重生成'
                      : '下一拍待生成'}
                </span>
              </div>
            ) : null}
          </section>
        )
      })}

      {state.chapterStatus === 'draft_complete' ? (
        <div className="write-complete-banner" data-testid="write-draft-complete">
          <strong>草稿完成</strong>
          <span>所有场景已收束；送审在阶段 08 接入。</span>
        </div>
      ) : null}
    </div>
  )
}

/** gutter 显示章内拍号（UI-DESIGN §5.4 的 `bt_012`）；完整 id 在拍卡里。 */
function beatLabel(index: number): string {
  return `bt_${String(index).padStart(3, '0')}`
}

export type { WriteBeatState }
