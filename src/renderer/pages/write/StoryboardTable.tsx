import { useEffect, useMemo, useState } from 'react'
import type { DraftScene, StoryboardConflict } from '../../../shared/schema/storyboard'
import type { WriteSceneState, WriteState } from '../../../shared/schema/write'
import { useWrite } from '../../stores/write'
import { SceneLibrary } from './SceneLibrary'

/**
 * 分镜编辑器（UI-DESIGN §5.4「分镜 tab」/ PHASE-07 F1 / PHASE-12 §5.4）：
 * - 表：场次 / 拍号 / speaker / intent / 字数上限 / 出口条件；行可拖排序。
 * - 冲突行内联：speaker 不在场、意图与角色卡矛盾、出口条件不可判定。
 * - `notes` 固定说明「不进任何 Agent 上下文」。
 * - 每场头部有三轴：时间轴（主线/闪回/梦境）+ 故事开始/结束；未标注不阻塞 G2。
 * - 引用场（拍属于别的章）显示「只读引用（第 N 章）」+ [fork 到本章]，拍不可编辑。
 * - 开演按钮在 header：硬冲突 0 才能用；点击弹 G2 确认。
 */

const CONFLICT_CODES: Record<string, string> = {
  speaker_not_in_participants: '发言人不在场',
  narrator_id: '旁白 id 错误',
  exit_invalid: '出口不可解析',
  exit_not_machine_decidable: '出口不可判定',
  exit_beats_only: '出口只有拍数',
  empty_intent: '意图为空',
  intent_violates_taboo: '意图触及角色禁忌',
  intent_uses_banned_words: '意图含禁用词',
  too_many_beats: '拍数超限',
  max_beats_too_high: '拍数上限过高',
  beat_too_long: '单拍字数过长',
  too_many_participants: '在场者过多',
  duplicate_scene: '场景重复',
  empty_scene: '场景还没有拍',
  scene_performed_elsewhere: '场景已在别的章演出',
  no_scenes: '没有场景',
  no_storyboard: '没有分镜'
}

const TIMELINE_LABELS: Record<WriteSceneState['timeline'], string> = {
  main: '主线',
  flashback: '闪回',
  dream: '梦境'
}

function emptyScene(): DraftScene {
  return {
    location: '新地点',
    participants: [],
    goal: '这一场要发生什么',
    entry: '',
    exit: 'beats(6)',
    beats: [{ speaker_type: 'narrator', speaker_id: 'narrator', intent: '开场', max_words: 160 }]
  }
}

function conflictsFor(conflicts: readonly StoryboardConflict[], sceneOrd: number, beatOrd?: number): StoryboardConflict[] {
  return conflicts.filter(
    (conflict) => conflict.scene_ord === sceneOrd && (beatOrd === undefined ? conflict.beat_ord === undefined : conflict.beat_ord === beatOrd)
  )
}

/** 故事时间输入：本地草稿 + 失焦/回车提交，避免逐字符打 IPC。 */
function TimeInput(props: {
  label: string
  value: string
  testId: string
  disabled: boolean
  onCommit: (value: string | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const commit = (): void => {
    const next = draft.trim()
    if (next === props.value) return
    props.onCommit(next.length === 0 ? null : next)
  }
  return (
    <label>
      {props.label}
      <input
        className="write-input"
        data-testid={props.testId}
        value={draft}
        placeholder="未标注"
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit()
        }}
      />
    </label>
  )
}

export function StoryboardTable({ state }: { state: WriteState }): React.JSX.Element {
  const busy = useWrite((store) => store.busy)
  const [scenes, setScenes] = useState<DraftScene[]>(state.storyboard.scenes)
  const [dirty, setDirty] = useState(false)
  const [g2Open, setG2Open] = useState(false)

  useEffect(() => {
    setScenes(state.storyboard.scenes)
    setDirty(false)
  }, [state.storyboard.rev, state.storyboard.scenes])

  const conflicts = useMemo(
    () => (dirty ? state.g2.conflicts.filter((conflict) => conflict.code !== 'no_storyboard' && conflict.code !== 'blueprint_not_locked' && conflict.code !== 'setup_incomplete') : state.g2.conflicts),
    [dirty, state.g2.conflicts]
  )
  const hardConflicts = conflicts.filter((conflict) => conflict.severity === 'hard')
  const hardCount = hardConflicts.length
  const characters = state.characters
  const dbScenes = useMemo(() => new Map(state.scenes.map((scene) => [scene.id, scene])), [state.scenes])
  const references = state.scenes.filter((scene) => scene.referenceChapterOrd !== null)

  const update = (mutate: (draft: DraftScene[]) => void): void => {
    setScenes((current) => {
      const next = current.map((scene) => ({ ...scene, beats: scene.beats.map((beat) => ({ ...beat })) }))
      mutate(next)
      return next
    })
    setDirty(true)
  }

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= scenes.length) return
    update((draft) => {
      const [item] = draft.splice(from, 1)
      if (item) draft.splice(to, 0, item)
    })
  }

  if (state.storyboard.scenes.length === 0 && references.length === 0) {
    return (
      <div className="write-storyboard" data-testid="write-storyboard">
        <SceneLibrary state={state} />
        <div className="pane-empty">
          <h3>还没有分镜草案</h3>
          <p>可以在编排对话里说「给我三场戏」，或直接手动加一场，也可以从场景库链接一个已有场景。</p>
          <button
            type="button"
            className="plan-btn"
            data-testid="write-storyboard-new"
            disabled={state.readOnly}
            onClick={() => {
              setScenes([emptyScene()])
              setDirty(true)
            }}
          >
            手动加一场
          </button>
        </div>
        {scenes.length > 0 ? renderTable() : null}
      </div>
    )
  }

  return renderTable()

  function renderTimeFields(scene: DraftScene, sceneOrd: number): React.JSX.Element | null {
    if (!scene.scene_id) return null
    const dbScene = dbScenes.get(scene.scene_id)
    if (!dbScene) return null
    const disabled = state.readOnly || busy
    return (
      <div className="write-scene-block__time" data-testid={`write-scene-time-${sceneOrd}`}>
        <label>
          时间轴
          <select
            className="write-input"
            data-testid={`write-scene-timeline-${sceneOrd}`}
            value={dbScene.timeline}
            disabled={disabled}
            onChange={(event) =>
              void useWrite.getState().setSceneTime({
                sceneId: dbScene.id,
                timeline: event.target.value as WriteSceneState['timeline']
              })
            }
          >
            <option value="main">主线</option>
            <option value="flashback">闪回</option>
            <option value="dream">梦境</option>
          </select>
        </label>
        <TimeInput
          label="故事开始"
          testId={`write-scene-story-start-${sceneOrd}`}
          value={dbScene.storyStart ?? ''}
          disabled={disabled}
          onCommit={(value) => void useWrite.getState().setSceneTime({ sceneId: dbScene.id, storyStart: value })}
        />
        <TimeInput
          label="故事结束"
          testId={`write-scene-story-end-${sceneOrd}`}
          value={dbScene.storyEnd ?? ''}
          disabled={disabled}
          onCommit={(value) => void useWrite.getState().setSceneTime({ sceneId: dbScene.id, storyEnd: value })}
        />
        {dbScene.timeline !== 'main' ? (
          <span className="write-badge write-badge--timeline" data-testid={`write-scene-timeline-badge-${sceneOrd}`}>
            {TIMELINE_LABELS[dbScene.timeline]}
          </span>
        ) : null}
        {dbScene.storyStart === null && dbScene.storyEnd === null ? (
          <span className="write-note" data-testid={`write-scene-time-unmarked-${sceneOrd}`}>
            未标注（不阻塞 G2）
          </span>
        ) : null}
      </div>
    )
  }

  function renderReferences(): React.JSX.Element | null {
    if (references.length === 0) return null
    return (
      <div className="write-storyboard-references" data-testid="write-storyboard-references">
        <div className="write-subhead">只读引用</div>
        {references.map((scene) => (
          <div
            key={scene.id}
            className="write-scene-block is-reference"
            data-testid={`write-reference-scene-${scene.ord}`}
          >
            <div className="write-scene-block__head">
              <span className="write-scene-ord">场景 {scene.ord}</span>
              <span className="write-scene-ref-name">{scene.location}</span>
              <span className="write-badge write-badge--reference" data-testid={`write-reference-badge-${scene.ord}`}>
                只读引用（第 {scene.referenceChapterOrd} 章）
              </span>
              {scene.timeline !== 'main' ? (
                <span className="write-badge write-badge--timeline">{TIMELINE_LABELS[scene.timeline]}</span>
              ) : null}
              <button
                type="button"
                className="plan-mini-btn"
                data-testid={`write-reference-fork-${scene.ord}`}
                disabled={state.readOnly || busy}
                title="复制场景与拍到本章；原章正文不变"
                onClick={() => void useWrite.getState().forkScene(scene.id)}
              >
                fork 到本章
              </button>
            </div>
            <p className="write-note">
              这一场的拍属于第 {scene.referenceChapterOrd} 章，本章不计入正文与 hash；要在这里演出请 fork。
            </p>
            <div className="write-scene-block__meta">
              <span>目标：{scene.goal}</span>
              {scene.storyStart ? <span className="mono">时间：{scene.storyStart}</span> : null}
            </div>
          </div>
        ))}
      </div>
    )
  }

  function renderTable(): React.JSX.Element {
    return (
      <div className="write-storyboard" data-testid="write-storyboard">
        <SceneLibrary state={state} />
        <div className="write-storyboard-head">
          <span data-testid="write-storyboard-summary">
            {scenes.length} 场 · {scenes.reduce((sum, scene) => sum + scene.beats.length, 0)} 拍
            {references.length > 0 ? ` · ${references.length} 场引用` : ''}
            {hardCount > 0 ? ` · ${hardCount} 条硬冲突` : ' · 无硬冲突'}
          </span>
          <div className="write-storyboard-actions">
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="write-storyboard-add-scene"
              disabled={state.readOnly}
              onClick={() => update((draft) => draft.push(emptyScene()))}
            >
              ＋场景
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="write-storyboard-save"
              disabled={state.readOnly || busy || !dirty}
              onClick={() => void useWrite.getState().saveStoryboard(scenes)}
            >
              保存分镜
            </button>
            <button
              type="button"
              className="plan-btn"
              data-testid="write-g2"
              disabled={state.readOnly || hardCount > 0 || dirty || state.storyboard.scenes.length === 0}
              title={hardCount > 0 ? (conflicts.find((conflict) => conflict.severity === 'hard')?.message ?? '') : dirty ? '先保存分镜' : '开演'}
              onClick={() => setG2Open(true)}
            >
              开演（G2）
            </button>
          </div>
        </div>

        {hardConflicts[0] ? (
          <p className="write-note" data-testid="write-g2-blocker">
            开演前必须修：{hardConflicts[0].message}
            {hardConflicts[0].beat_ord !== undefined
              ? `（场景 ${hardConflicts[0].scene_ord} · 拍 ${hardConflicts[0].beat_ord}）`
              : `（场景 ${hardConflicts[0].scene_ord}）`}
          </p>
        ) : null}

        {g2Open ? (
          <div className="write-g2-dialog" data-testid="write-g2-dialog">
            <div className="write-preflight__head">G2 · 按这个顺序演？</div>
            <ul>
              <li>{state.g2.sceneCount} 场 / {state.g2.beatCount} 拍</li>
              <li>拍数上限合计 {state.g2.maxBeats}</li>
              <li>分镜版本 v{state.g2.storyboardRev ?? 1}</li>
            </ul>
            <p className="write-note">通过后进入演绎；之后改分镜属于「补分镜」，不改已写正文。</p>
            <div className="write-preflight__actions">
              <button
                type="button"
                className="plan-btn"
                data-testid="write-g2-confirm"
                onClick={() => {
                  setG2Open(false)
                  void useWrite.getState().confirmG2()
                }}
              >
                确认开演
              </button>
              <button type="button" className="plan-mini-btn" onClick={() => setG2Open(false)}>
                再改改
              </button>
            </div>
          </div>
        ) : null}

        <div className="write-storyboard-list">
          {scenes.map((scene, sceneIndex) => {
            const sceneOrd = sceneIndex + 1
            const sceneConflicts = conflictsFor(conflicts, sceneOrd)
            return (
              <div
                key={`${scene.scene_id ?? 'new'}-${sceneIndex}`}
                className="write-scene-block"
                data-testid={`write-storyboard-scene-${sceneOrd}`}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('text/plain', String(sceneIndex))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const from = Number(event.dataTransfer.getData('text/plain'))
                  if (!Number.isNaN(from)) move(from, sceneIndex)
                }}
              >
                <div className="write-scene-block__head">
                  <span className="write-scene-ord">场景 {sceneOrd}</span>
                  <input
                    className="write-input"
                    data-testid={`write-scene-location-${sceneOrd}`}
                    value={scene.location}
                    disabled={state.readOnly}
                    onChange={(event) => update((draft) => void (draft[sceneIndex]!.location = event.target.value))}
                  />
                  <input
                    className="write-input write-input--wide"
                    data-testid={`write-scene-goal-${sceneOrd}`}
                    value={scene.goal}
                    disabled={state.readOnly}
                    onChange={(event) => update((draft) => void (draft[sceneIndex]!.goal = event.target.value))}
                  />
                  <button
                    type="button"
                    className="plan-mini-btn"
                    onClick={() => move(sceneIndex, sceneIndex - 1)}
                    disabled={state.readOnly || sceneIndex === 0}
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="plan-mini-btn"
                    onClick={() => move(sceneIndex, sceneIndex + 1)}
                    disabled={state.readOnly || sceneIndex === scenes.length - 1}
                    title="下移"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="plan-mini-btn"
                    data-testid={`write-scene-remove-${sceneOrd}`}
                    disabled={state.readOnly || scenes.length === 1}
                    onClick={() => update((draft) => void draft.splice(sceneIndex, 1))}
                  >
                    删除
                  </button>
                </div>

                <div className="write-scene-block__meta">
                  <label>
                    在场者
                    <input
                      className="write-input write-input--wide"
                      data-testid={`write-scene-participants-${sceneOrd}`}
                      value={scene.participants.join(', ')}
                      disabled={state.readOnly}
                      onChange={(event) =>
                        update(
                          (draft) =>
                            void (draft[sceneIndex]!.participants = event.target.value
                              .split(/[,，\s]+/)
                              .map((item) => item.trim())
                              .filter((item) => item.length > 0))
                        )
                      }
                    />
                  </label>
                  <label>
                    出口条件（DSL）
                    <input
                      className="write-input write-input--wide mono"
                      data-testid={`write-scene-exit-${sceneOrd}`}
                      value={typeof scene.exit === 'string' ? scene.exit : JSON.stringify(scene.exit ?? '')}
                      disabled={state.readOnly}
                      onChange={(event) =>
                        update((draft) => {
                          draft[sceneIndex]!.exit = event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    拍数上限
                    <input
                      className="write-input"
                      type="number"
                      min={1}
                      max={40}
                      data-testid={`write-scene-maxbeats-${sceneOrd}`}
                      value={scene.max_beats ?? 40}
                      disabled={state.readOnly}
                      onChange={(event) =>
                        update((draft) => void (draft[sceneIndex]!.max_beats = Number(event.target.value)))
                      }
                    />
                  </label>
                </div>

                {renderTimeFields(scene, sceneOrd)}

                {sceneConflicts.length > 0 ? (
                  <ul className="write-conflict-list" data-testid={`write-scene-conflicts-${sceneOrd}`}>
                    {sceneConflicts.map((conflict, index) => (
                      <li key={`${conflict.code}-${index}`} className={`write-conflict is-${conflict.severity}`}>
                        <span>{CONFLICT_CODES[conflict.code] ?? conflict.code}</span>
                        <span>{conflict.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <table className="write-storyboard-table">
                  <thead>
                    <tr>
                      <th>拍</th>
                      <th>speaker</th>
                      <th>intent</th>
                      <th>字数上限</th>
                      <th>状态</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {scene.beats.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="write-note" data-testid={`write-scene-empty-${sceneOrd}`}>
                          这一场还没有拍；补一拍再开演。
                        </td>
                      </tr>
                    ) : null}
                    {scene.beats.map((beat, beatIndex) => {
                      const beatOrd = beatIndex + 1
                      const beatConflicts = conflictsFor(conflicts, sceneOrd, beatOrd)
                      return (
                        <tr key={`${beat.speaker_id}-${beatIndex}`} data-testid={`write-storyboard-beat-${sceneOrd}-${beatOrd}`}>
                          <td className="mono">{beatOrd}</td>
                          <td>
                            <select
                              className="write-input"
                              data-testid={`write-beat-speaker-${sceneOrd}-${beatOrd}`}
                              value={`${beat.speaker_type}:${beat.speaker_id}`}
                              disabled={state.readOnly}
                              onChange={(event) => {
                                const [type, id] = event.target.value.split(':')
                                update((draft) => {
                                  const target = draft[sceneIndex]!.beats[beatIndex]!
                                  target.speaker_type = type === 'narrator' ? 'narrator' : 'character'
                                  target.speaker_id = id ?? ''
                                })
                              }}
                            >
                              <option value="narrator:narrator">旁白</option>
                              {scene.participants.map((participantId) => (
                                <option key={participantId} value={`character:${participantId}`}>
                                  {characters.find((item) => item.id === participantId)?.name ?? participantId}
                                </option>
                              ))}
                              {beat.speaker_type === 'character' && !scene.participants.includes(beat.speaker_id) ? (
                                <option value={`character:${beat.speaker_id}`}>{beat.speaker_id}（不在场）</option>
                              ) : null}
                            </select>
                          </td>
                          <td>
                            <input
                              className="write-input write-input--wide"
                              data-testid={`write-beat-intent-${sceneOrd}-${beatOrd}`}
                              value={beat.intent}
                              disabled={state.readOnly}
                              onChange={(event) =>
                                update((draft) => void (draft[sceneIndex]!.beats[beatIndex]!.intent = event.target.value))
                              }
                            />
                            {beatConflicts.length > 0 ? (
                              <div className="write-conflict is-soft" data-testid={`write-beat-conflict-${sceneOrd}-${beatOrd}`}>
                                {beatConflicts[0]!.message}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <input
                              className="write-input"
                              type="number"
                              min={1}
                              max={2000}
                              data-testid={`write-beat-maxwords-${sceneOrd}-${beatOrd}`}
                              value={beat.max_words ?? ''}
                              disabled={state.readOnly}
                              onChange={(event) =>
                                update((draft) => {
                                  const target = draft[sceneIndex]!.beats[beatIndex]!
                                  const value = Number(event.target.value)
                                  if (Number.isFinite(value) && value > 0) target.max_words = value
                                  else delete target.max_words
                                })
                              }
                            />
                          </td>
                          <td>
                            {state.scenes.find((item) => item.ord === sceneOrd)?.beats[beatIndex]?.status ?? '—'}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="plan-mini-btn"
                              disabled={state.readOnly || scene.beats.length === 1}
                              onClick={() => update((draft) => void draft[sceneIndex]!.beats.splice(beatIndex, 1))}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <div className="write-scene-block__foot">
                  <button
                    type="button"
                    className="plan-mini-btn"
                    data-testid={`write-beat-add-${sceneOrd}`}
                    disabled={state.readOnly}
                    onClick={() =>
                      update((draft) =>
                        void draft[sceneIndex]!.beats.push({
                          speaker_type: 'narrator',
                          speaker_id: 'narrator',
                          intent: '',
                          max_words: 160,
                          notes: ''
                        })
                      )
                    }
                  >
                    ＋拍
                  </button>
                  <span className="write-note">notes 字段不进任何 Agent 上下文（作者视角剧透写这里）。</span>
                </div>
              </div>
            )
          })}
          {renderReferences()}
        </div>
      </div>
    )
  }
}
