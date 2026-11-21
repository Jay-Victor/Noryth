import { useEffect, useState } from 'react'
import { formatDistinctness, VOICE_THRESHOLD_NOTE } from '../../../shared/domain/voice'
import type { ReviewSceneRef } from '../../../shared/schema/review'
import type { VoiceSceneState } from '../../../shared/schema/voice'
import { getBridge } from '../../lib/bridge'

/**
 * 审批台「声音」面板（PHASE-19 §5.3 / M2-2）。
 *
 * 逐角色表 + 两两矩阵；阈值版本来自主进程（不在 UI 写死 0.18）。
 * 只读：没有「重新计算」「改成阻断」按钮；低区分度不进入 G6 阻断条件。
 */

interface Loaded {
  scene: ReviewSceneRef
  state: VoiceSceneState | null
}

function Matrix({ loaded }: { loaded: Loaded[] }): React.JSX.Element | null {
  const withPairs = loaded.filter((item) => item.state !== null && item.state.pairs.length > 0)
  if (withPairs.length === 0) return null
  return (
    <div className="review-voice__matrix-wrap">
      {withPairs.map((item) => {
        const state = item.state!
        const names = state.characters.map((character) => character.name)
        const scoreOf = (a: string, b: string): number | null => {
          if (a === b) return null
          const pair = state.pairs.find(
            (candidate) =>
              (candidate.aName === a && candidate.bName === b) || (candidate.aName === b && candidate.bName === a)
          )
          return pair ? pair.score : null
        }
        return (
          <table
            key={item.scene.sceneId}
            className="review-voice__matrix"
            data-testid={`review-voice-matrix-${item.scene.sceneId}`}
          >
            <caption>
              场景 {item.scene.ord} · {item.scene.location}
            </caption>
            <thead>
              <tr>
                <th scope="col">角色</th>
                {names.map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {names.map((rowName) => (
                <tr key={rowName}>
                  <th scope="row">{rowName}</th>
                  {names.map((colName) => {
                    const score = scoreOf(rowName, colName)
                    return (
                      <td
                        key={colName}
                        className={score !== null && score < state.threshold.distinctnessMin ? 'is-low' : undefined}
                      >
                        {score === null ? '—' : formatDistinctness(score)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      })}
    </div>
  )
}

export function VoicePanel({ scenes }: { scenes: readonly ReviewSceneRef[] }): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded[]>([])
  const [loading, setLoading] = useState(false)
  const signature = scenes.map((scene) => scene.sceneId).join(',')

  useEffect(() => {
    let cancelled = false
    const bridge = getBridge()
    if (!bridge || scenes.length === 0) {
      setLoaded([])
      return undefined
    }
    setLoading(true)
    void Promise.all(
      scenes.map(async (scene) => {
        const result = await bridge.voice.scene({ sceneId: scene.sceneId })
        return { scene, state: result.ok ? result.data : null }
      })
    ).then((items) => {
      if (cancelled) return
      setLoaded(items)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [signature])

  const states = loaded.map((item) => item.state).filter((state): state is VoiceSceneState => state !== null)
  const usable = states.filter((state) => state.found && !state.insufficientData)
  const threshold = usable[0]?.threshold ?? states[0]?.threshold ?? null
  const lowCount = usable.filter((state) => state.belowThreshold).length

  return (
    <section className="review-section review-voice" data-testid="review-voice">
      <h4>
        声音 · 逐角色与两两
        {threshold ? <span className="review-note">（阈值 {formatDistinctness(threshold.distinctnessMin)} · {threshold.version}）</span> : null}
      </h4>
      {loading ? <p className="review-note">读取声音指标…</p> : null}
      {!loading && usable.length === 0 ? (
        <p className="review-note" data-testid="review-voice-empty">
          数据不足：这一章还没有可比较的角色对（空场景、人数不足，或还没有正文）。
        </p>
      ) : null}
      {!loading && usable.length > 0 ? (
        <>
          <p className="review-note" data-testid="review-voice-summary">
            {usable.length} 场有指标 · {lowCount} 场低于阈值 · {VOICE_THRESHOLD_NOTE}
          </p>
          {usable.map((state) => {
            const scene = loaded.find((item) => item.state === state)?.scene
            return (
              <div key={state.sceneId} className="review-voice__scene" data-testid={`review-voice-scene-${state.sceneId}`}>
                <div className="review-voice__head">
                  <strong>
                    场景 {scene?.ord ?? '?'} · {scene?.location ?? ''}
                  </strong>
                  <span className={`review-voice__score${state.belowThreshold ? ' is-low' : ''}`}>
                    最低一对 {formatDistinctness(state.aggregate.pairwiseDistinctness)}
                  </span>
                </div>
                <div className="review-voice__table-wrap">
                <table className="review-voice__table" data-testid={`review-voice-characters-${state.sceneId}`}>
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>拍</th>
                      <th>平均句长</th>
                      <th>口头禅率</th>
                      <th>问句率</th>
                      <th>第一人称率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.characters.map((character) => (
                      <tr key={character.characterId}>
                        <td>{character.name}</td>
                        <td className="mono">{character.beatCount}</td>
                        <td className="mono">{character.avgSentenceLength.toFixed(1)}</td>
                        <td className="mono">{formatDistinctness(character.catchphraseRate)}</td>
                        <td className="mono">{formatDistinctness(character.questionRate)}</td>
                        <td className="mono">{formatDistinctness(character.firstPersonRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )
          })}
          <Matrix loaded={loaded.filter((item) => item.state !== null && item.state.found && !item.state.insufficientData)} />
        </>
      ) : null}
    </section>
  )
}
