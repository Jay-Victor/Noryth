import { useEffect, useMemo, useState } from 'react'
import { GRID, type LayoutMode } from '../../../shared/layout/grid'
import { WRITE_CHAPTER_STATUS_LABELS } from '../../../shared/schema/write'
import { Icon } from '../../components/Icon'
import { useApp } from '../../stores/app'
import { useWrite } from '../../stores/write'
import { ConfirmBar } from './ConfirmBar'
import { ProseView } from './ProseView'
import { StoryboardTable } from './StoryboardTable'

/**
 * 创作台（UI-DESIGN §5 / PHASE-07 F5）。
 *
 * 四分区：章节树 + 场景进度 / 编排对话 + 执行流 / 正文或分镜 + 确认条 / 文件树。
 * 键盘路径与 IME 守卫写在同一处（§5.6），不散落到三个组件里。
 */

const TABS: Array<{ key: 'prose' | 'storyboard'; label: string }> = [
  { key: 'prose', label: '正文' },
  { key: 'storyboard', label: '分镜' }
]

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function WritePage({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const current = useApp((state) => state.current)
  const projectId = current?.project.id ?? null
  const state = useWrite((store) => store.state)
  const tab = useWrite((store) => store.tab)
  const chatTab = useWrite((store) => store.chatTab)
  const busy = useWrite((store) => store.busy)
  const loading = useWrite((store) => store.loading)
  const editingBeatId = useWrite((store) => store.editingBeatId)
  const [message, setMessage] = useState('')
  const [activeBeatId, setActiveBeatId] = useState<string | null>(null)

  useEffect(() => {
    useWrite.getState().reset()
    if (projectId) void useWrite.getState().load()
  }, [projectId])

  const beats = useMemo(() => state?.scenes.flatMap((scene) => scene.beats) ?? [], [state])
  const currentBeat = beats.find((beat) => beat.id === (activeBeatId ?? state?.currentBeatId)) ?? null
  const hardConflicts = state?.g2.conflicts.filter((conflict) => conflict.severity === 'hard').length ?? 0

  // 键盘：Enter 确认 / Ctrl+R 重生成 / E 编辑 / J K 切拍 / Space 暂停 / Ctrl+Enter 发送
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!state) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        const text = message.trim()
        if (text.length === 0) return
        setMessage('')
        void useWrite.getState().send(text)
        return
      }
      if (mod && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        if (currentBeat && (currentBeat.status === 'waiting_for_human' || currentBeat.status === 'draft')) {
          void useWrite.getState().regenerate(currentBeat.id)
        }
        return
      }
      if (isEditable(event.target) || editingBeatId) return
      if (event.isComposing || event.keyCode === 229) return
      const index = beats.findIndex((beat) => beat.id === currentBeat?.id)
      if (event.key === 'Enter') {
        event.preventDefault()
        if (currentBeat?.status === 'waiting_for_human' || currentBeat?.status === 'draft') {
          void useWrite.getState().confirm(currentBeat.id)
        }
        return
      }
      if (event.key.toLowerCase() === 'e') {
        if (currentBeat && currentBeat.body.trim().length > 0) {
          event.preventDefault()
          useWrite.getState().startEdit(currentBeat.id, currentBeat.body)
        }
        return
      }
      if (event.key.toLowerCase() === 'j') {
        const next = beats[Math.min(beats.length - 1, index + 1)]
        if (next) setActiveBeatId(next.id)
        return
      }
      if (event.key.toLowerCase() === 'k') {
        const previous = beats[Math.max(0, index - 1)]
        if (previous) setActiveBeatId(previous.id)
        return
      }
      if (event.key === ' ') {
        if (!state.autoRunning && !state.autoPaused) return
        event.preventDefault()
        if (state.autoRunning) void useWrite.getState().pause()
        else void useWrite.getState().resume()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state, beats, currentBeat, editingBeatId, message])

  if (!projectId) {
    return (
      <>
        <section className="pane pane--sessions" data-testid="pane-sessions">
          <div className="pane-header">章节</div>
        </section>
        <section className="pane pane--chat" data-testid="pane-chat">
          <div className="pane-header">对话</div>
          <div className="pane-body">
            <div className="pane-empty">
              <h3>先打开一个项目</h3>
              <p>创作台只在项目内可用。</p>
            </div>
          </div>
        </section>
        <section className="pane pane--preview" data-testid="pane-preview">
          <div className="pane-header">正文</div>
        </section>
        <section className="pane pane--tree" data-testid="pane-tree">
          <div className="pane-header">文件树</div>
        </section>
      </>
    )
  }

  if (!state) {
    return (
      <section className="pane pane--chat" data-testid="pane-chat">
        <div className="pane-header">正文</div>
        <div className="pane-body">
          <div className="pane-empty">
            <h3>{loading ? '正在打开创作台…' : '还没有章节'}</h3>
            <p>先在规划台完成 G1；章节点会在这里出现。</p>
          </div>
        </div>
      </section>
    )
  }

  const treeMode = GRID[mode].treeMode
  const pauseBanner = state.pauseReason
    ? { reason: state.pauseReason, text: state.pauseText ?? state.pauseReason }
    : null

  return (
    <>
      <section className="pane pane--sessions" data-testid="pane-sessions" aria-label="章节">
        <div className="pane-header">
          <span>章节</span>
          <span className="pane-header__meta">{state.chapters.length}</span>
        </div>
        <div className="pane-body write-chapters">
          {state.chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              className={`write-chapter-row${chapter.id === state.chapterId ? ' is-active' : ''}`}
              data-testid={`write-chapter-${chapter.id}`}
              onClick={() => void useWrite.getState().setChapter(chapter.id)}
            >
              <span className="write-chapter-title">{chapter.title}</span>
              <span className="write-chapter-status" data-status={chapter.status} data-testid={`write-chapter-status-${chapter.id}`}>
                {WRITE_CHAPTER_STATUS_LABELS[chapter.status] ?? chapter.status}
              </span>
            </button>
          ))}

          <div className="write-scene-progress" data-testid="write-scene-progress">
            <div className="write-subhead">
              场景 · {state.progress.scenesClosed}/{state.progress.scenesTotal} 已收束
            </div>
            {state.scenes.length === 0 ? (
              <p className="write-note">还没有开演。先分镜，再过 G2。</p>
            ) : (
              state.scenes.map((scene) => (
                <div key={scene.id} className="write-scene-row">
                  <span className={`write-scene-dot is-${scene.status}`} />
                  <span className="write-scene-name">
                    场景 {scene.ord} · {scene.location}
                  </span>
                  <span className="write-scene-count">
                    {scene.confirmed}/{scene.maxBeats}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="write-scene-progress">
            <div className="write-subhead">本章会话</div>
            {state.messages.filter((item) => item.kind !== 'pause').length === 0 ? (
              <p className="write-note">编排对话从右侧开始。</p>
            ) : (
              state.messages
                .filter((item) => item.kind !== 'pause')
                .slice(-4)
                .map((item) => (
                  <div key={item.id} className="write-session-line">
                    <span className="write-session-dot" />
                    <span>{item.body.slice(0, 40) || '（空）'}</span>
                  </div>
                ))
            )}
          </div>
        </div>
      </section>

      <section className="pane pane--chat" data-testid="pane-chat" aria-label="编排对话与执行流">
        <div className="pane-header write-chat-head">
          <div className="write-toggle">
            <button
              type="button"
              className={chatTab === 'chat' ? 'is-active' : ''}
              data-testid="write-tab-chat"
              onClick={() => useWrite.getState().setChatTab('chat')}
            >
              编排对话
            </button>
            <button
              type="button"
              className={chatTab === 'stream' ? 'is-active' : ''}
              data-testid="write-tab-stream"
              onClick={() => useWrite.getState().setChatTab('stream')}
            >
              执行流
            </button>
          </div>
          <span className="pane-header__meta">{state.model.label}</span>
        </div>

        <div className="pane-body">
          {chatTab === 'stream' ? (
            <div className="write-exec-stream" data-testid="write-exec-stream">
              {state.events.length === 0 ? (
                <p className="write-note">还没有执行记录。</p>
              ) : (
                state.events
                  .filter((event) => event.kind === 'beat_committed' || event.kind === 'scene_closed' || event.kind === 'paused')
                  .map((event) => {
                    const payload = (event.payload ?? {}) as { beatId?: string; latencyMs?: number }
                    return (
                      <div key={event.id} className="write-exec-row">
                        <span className="write-exec-kind">{event.kind}</span>
                        <span className="mono">{payload.beatId ?? event.reason ?? '—'}</span>
                        <span className="write-exec-meta">
                          {payload.latencyMs !== undefined ? `${payload.latencyMs}ms` : ''}
                          {event.reason ? event.reason : ''}
                        </span>
                      </div>
                    )
                  })
              )}
            </div>
          ) : (
            <div className="write-chat-stream" data-testid="write-chat-stream">
              {state.messages.length === 0 ? (
                <div className="chat-bubble is-agent">
                  说「这场太拖」或「两个人不该在这里摊牌」，我给替代分镜；只改分镜草案，不改正文。
                  <div className="chat-bubble__meta">仅讨论 · 不写正文</div>
                </div>
              ) : (
                state.messages.map((item) => (
                  <div
                    key={item.id}
                    className={`chat-bubble ${item.role === 'author' ? 'is-author' : item.role === 'system' ? 'is-system' : 'is-agent'}`}
                    data-testid={`write-message-${item.role}`}
                  >
                    {item.body || '…'}
                    {item.kind === 'storyboard' ? <div className="chat-bubble__meta">已更新分镜草案</div> : null}
                    {item.kind === 'refusal' ? <div className="chat-bubble__meta">拒演 · 不提供强制继续</div> : null}
                  </div>
                ))
              )}
            </div>
          )}

          {pauseBanner ? (
            <div className="write-pause-banner" data-testid="write-pause-banner" data-reason={pauseBanner.reason}>
              <strong>{pauseBanner.reason}</strong>
              <span>{pauseBanner.text}</span>
              <div className="write-pause-actions">
                <button type="button" className="plan-btn" onClick={() => void useWrite.getState().resume()}>
                  继续
                </button>
                <button type="button" className="plan-mini-btn" onClick={() => useWrite.getState().setTab('storyboard')}>
                  改分镜
                </button>
              </div>
            </div>
          ) : null}

          {chatTab === 'chat' ? (
            <div className="write-composer">
              <textarea
                className="write-composer__input"
                data-testid="write-composer"
                placeholder="和编排讨论场次、节奏、出口条件（Ctrl+Enter 发送）"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
              />
              <button
                type="button"
                className="plan-btn"
                data-testid="write-send"
                disabled={busy || message.trim().length === 0}
                onClick={() => {
                  const text = message.trim()
                  if (text.length === 0) return
                  setMessage('')
                  void useWrite.getState().send(text)
                }}
              >
                发送
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="pane pane--preview" data-testid="pane-preview" aria-label="正文">
        <div className="pane-header write-preview-head">
          <div className="write-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={`write-tab${tab === item.key ? ' is-active' : ''}`}
                data-testid={`write-tab-${item.key}`}
                onClick={() => useWrite.getState().setTab(item.key)}
              >
                {item.label}
                {item.key === 'storyboard' && hardConflicts > 0 ? (
                  <span className="write-tab__badge" data-testid="write-storyboard-badge">
                    {hardConflicts}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <span className="pane-header__meta">
            {state.budget.spent}/{state.budget.limit} tokens
            {state.autoRunning ? ' · 自动运行中' : ''}
            {state.readOnly ? ' · 只读' : ''}
          </span>
        </div>

        {tab === 'prose' ? (
          <ProseView
            state={state}
            activeBeatId={currentBeat?.id ?? null}
            onSelectBeat={setActiveBeatId}
          />
        ) : (
          <StoryboardTable state={state} />
        )}

        <ConfirmBar
          state={state}
          beat={currentBeat}
          busy={busy}
          onGenerate={(beatId) => void useWrite.getState().generate(beatId)}
          onRegenerate={(beatId) => void useWrite.getState().regenerate(beatId)}
          onConfirm={(beatId) => void useWrite.getState().confirm(beatId)}
          onEdit={(beatId, body) => useWrite.getState().startEdit(beatId, body)}
          onAuto={() => void useWrite.getState().startAuto()}
          onPause={() => void useWrite.getState().pause()}
          onResume={() => void useWrite.getState().resume()}
          onCancel={() => void useWrite.getState().cancel()}
        />
      </section>

      <section className="pane pane--tree" data-testid="pane-tree" aria-label="文件树">
        {treeMode === 'pane' ? (
          <>
            <div className="pane-header">
              <span>稿件 / 分镜</span>
              <span className="pane-header__meta">Ctrl B</span>
            </div>
            <div className="pane-body write-tree">
              <div className="plan-subhead">稿件</div>
              <div className="plan-tree-file">
                <Icon name="write" size={12} />
                <span className="mono">ch-{String(state.chapterOrd).padStart(3, '0')}.md</span>
                <span className="plan-tree-status is-locked">{state.revisionId ? '草稿' : '空'}</span>
              </div>
              <div className="plan-subhead">分镜</div>
              <div className="plan-tree-file">
                <Icon name="plan" size={12} />
                <span className="mono">storyboard</span>
                <span className="plan-tree-status">{state.storyboard.rev ? `v${state.storyboard.rev}` : '未提案'}</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="review" size={12} />
                <span>出口条件</span>
                <span className="pane-header__meta">{state.scenes.filter((scene) => scene.exitSatisfied).length} 已满足</span>
              </div>
              <div className="plan-subhead">数据库视图</div>
              <div className="plan-tree-file">
                <Icon name="memory" size={12} />
                <span>拍</span>
                <span className="pane-header__meta">
                  {state.progress.confirmed}/{state.progress.totalBeats} 已确认
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="rail">
            <span className="rail-item is-active" title="章节">
              <Icon name="write" size={13} />
            </span>
            <span className="rail-item" title={`拍 ${state.progress.totalBeats}`}>
              <Icon name="plan" size={13} />
            </span>
            <span className="rail-item" title={`事件 ${state.events.length}`}>
              <Icon name="review" size={13} />
            </span>
          </div>
        )}
      </section>
    </>
  )
}
