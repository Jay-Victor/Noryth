import { useEffect, useState } from 'react'
import { formatDistinctness, VOICE_THRESHOLD_NOTE } from '../../../shared/domain/voice'
import type { VoicePairMetricsState, VoiceSceneState } from '../../../shared/schema/voice'
import { getBridge } from '../../lib/bridge'

/**
 * 创作台场景头的声音徽标（PHASE-19 §5.3 / M2-2）。
 *
 * 只展示、不阻断：`voice` 不在 BLOCKING_ISSUE_TYPES，确认条与 G6 都不看它。
 * 数据来自只读 IPC `voice.scene`（主进程按需重算并落 voice_metric）；
 * 空场景 / 角色不足时整块隐藏，由审批台面板说明「数据不足」。
 */

function lowestPair(pairs: readonly VoicePairMetricsState[]): VoicePairMetricsState | null {
  if (pairs.length === 0) return null
  return pairs.reduce((lowest, pair) => (pair.score < lowest.score ? pair : lowest), pairs[0]!)
}

export function SceneVoiceBadge({ sceneId }: { sceneId: string }): React.JSX.Element | null {
  const [state, setState] = useState<VoiceSceneState | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState(null)
    setOpen(false)
    const bridge = getBridge()
    if (!bridge) return undefined
    void bridge.voice.scene({ sceneId }).then((result) => {
      if (cancelled) return
      setState(result.ok ? result.data : null)
    })
    return () => {
      cancelled = true
    }
  }, [sceneId])

  if (!state || !state.found || state.insufficientData) return null
  const pair = lowestPair(state.pairs)
  if (pair === null) return null

  return (
    <span className="write-voice" data-testid={`write-voice-${sceneId}`} data-low={state.belowThreshold ? '1' : '0'}>
      <button
        type="button"
        className={`write-voice__badge${state.belowThreshold ? ' is-low' : ''}`}
        data-testid={`write-voice-badge-${sceneId}`}
        title="声音区分度：同场角色两两比较；提示，不阻断"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        声音 {formatDistinctness(state.aggregate.pairwiseDistinctness)} · {pair.aName} / {pair.bName}
      </button>
      {open ? (
        <div className="write-voice__panel" data-testid={`write-voice-panel-${sceneId}`}>
          <p className="write-voice__threshold">
            阈值 {formatDistinctness(state.threshold.distinctnessMin)} · {state.threshold.version}
            {state.belowThreshold ? ' · 低于阈值（仅提示）' : ''}
          </p>
          <ul className="write-voice__pairs">
            {state.pairs.map((item) => (
              <li key={`${item.a}/${item.b}`} data-testid={`write-voice-pair-${item.a}-${item.b}`}>
                <span className="write-voice__names">
                  {item.aName} / {item.bName}
                </span>
                <span className="mono">{formatDistinctness(item.score)}</span>
                <span className="write-voice__parts">
                  句长 {formatDistinctness(item.sentenceLengthJsd)} · 口头禅 {formatDistinctness(item.catchphraseDelta)} ·
                  问句 {formatDistinctness(item.questionDelta)} · 第一人称 {formatDistinctness(item.firstPersonDelta)}
                </span>
              </li>
            ))}
          </ul>
          <p className="write-note">{VOICE_THRESHOLD_NOTE}</p>
        </div>
      ) : null}
    </span>
  )
}
