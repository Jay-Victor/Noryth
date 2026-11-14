import { useEffect, useState } from 'react'
import type { WriteBeatState, WriteState } from '../../../shared/schema/write'
import { useWrite } from '../../stores/write'

/**
 * 逐拍确认条（UI-DESIGN §5.4 / §9.1）：固定 56px。
 * - 左侧信息 `拍 12/24 · 沈昼 · 78 字`
 * - 依据 / 上下文 / 重生成 Ctrl+R / 编辑 E / 确认 ⏎
 * - 自动模式：确认条变为 `自动运行 · 12/24` + [暂停]；暂停原因是横幅。
 * - 只读项目：全部禁用（主进程也会拒绝）。
 */

export function ConfirmBar({
  state,
  beat,
  busy,
  onGenerate,
  onRegenerate,
  onConfirm,
  onEdit,
  onAuto,
  onPause,
  onResume,
  onCancel
}: {
  state: WriteState
  beat: WriteBeatState | null
  busy: boolean
  onGenerate: (beatId: string) => void
  onRegenerate: (beatId: string) => void
  onConfirm: (beatId: string) => void
  onEdit: (beatId: string, body: string) => void
  onAuto: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}): React.JSX.Element {
  const stalePrompt = useWrite((store) => store.stalePrompt)
  const [preflightOpen, setPreflightOpen] = useState(false)

  // 三选一对话框：默认「开新分支」（PRD §5.2 / UI-DESIGN §5.4）
  useEffect(() => {
    if (!stalePrompt) setPreflightOpen(false)
  }, [stalePrompt])

  const total = state.progress.totalBeats
  const position = beat ? state.scenes.flatMap((scene) => scene.beats).findIndex((item) => item.id === beat.id) + 1 : 0
  const disabled = state.readOnly || busy
  const waiting = beat ? beat.status === 'waiting_for_human' || beat.status === 'draft' : false
  const canConfirm = waiting && !state.readOnly && !busy

  if (state.autoRunning) {
    return (
      <div className="write-confirm-bar is-auto" data-testid="write-confirm-bar">
        <span className="write-confirm-info" data-testid="write-auto-progress">
          自动运行 · {state.progress.confirmed}/{total}
        </span>
        <span className="write-confirm-meta">出口满足 / 预算 / max_beats / 拒演 / 耗尽 任一触发即停</span>
        <button type="button" className="plan-btn" data-testid="write-pause" onClick={onPause}>
          暂停
        </button>
        <button type="button" className="plan-mini-btn" onClick={onCancel} disabled={state.readOnly}>
          取消
        </button>
      </div>
    )
  }

  return (
    <div className="write-confirm-bar" data-testid="write-confirm-bar">
      <span className="write-confirm-info" data-testid="write-beat-position">
        {beat ? `拍 ${position}/${total} · ${beat.speakerName} · ${beat.wordCount} 字` : `拍 0/${total}`}
      </span>

      <button
        type="button"
        className="write-chip"
        data-testid="write-confirm-grounding"
        disabled={!beat || beat.grounding.length === 0}
        title={beat?.grounding.map((item) => `${item.type}:${item.id}`).join('、') ?? ''}
      >
        依据 {beat?.grounding.length ?? 0}
      </button>

      <button
        type="button"
        className="write-chip"
        data-testid="write-context-checker"
        title={beat?.traceRef ?? '没有轨迹'}
        disabled
      >
        上下文
      </button>

      <button
        type="button"
        className="plan-btn"
        data-testid="write-generate"
        disabled={disabled || !beat || !(beat.status === 'proposed' || beat.status === 'rejected' || beat.status === 'interrupted')}
        onClick={() => beat && onGenerate(beat.id)}
      >
        生成
      </button>

      <button
        type="button"
        className="plan-mini-btn"
        data-testid="write-regenerate"
        disabled={disabled || !beat || !waiting}
        onClick={() => beat && onRegenerate(beat.id)}
      >
        重生成 Ctrl+R
      </button>

      <button
        type="button"
        className="plan-mini-btn"
        data-testid="write-edit"
        disabled={disabled || !beat || beat.body.trim().length === 0}
        onClick={() => beat && onEdit(beat.id, beat.body)}
      >
        编辑 E
      </button>

      <button
        type="button"
        className="plan-btn"
        data-testid="write-confirm"
        disabled={!canConfirm}
        onClick={() => beat && onConfirm(beat.id)}
      >
        确认 ⏎
      </button>

      {state.autoPaused && state.pauseReason ? (
        <button type="button" className="plan-btn" data-testid="write-resume" onClick={onResume} disabled={state.readOnly}>
          继续
        </button>
      ) : (
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="write-auto"
          disabled={state.readOnly || busy || state.scenes.length === 0}
          onClick={() => setPreflightOpen(true)}
        >
          自动模式
        </button>
      )}

      {preflightOpen && state.preflight ? (
        <div className="write-preflight" data-testid="write-preflight">
          <div className="write-preflight__head">自动模式预检</div>
          <ul>
            <li>将连续生成 {state.preflight.remainingBeats} 拍（本章上限 {state.preflight.maxBeats}）</li>
            <li>
              预估 token {state.preflight.estimatedTokens.min}–{state.preflight.estimatedTokens.max}（每拍中位数{' '}
              {state.preflight.estimatedTokensPerBeat}）
            </li>
            <li>
              预估费用 ¥{state.preflight.estimatedCostCny.min.toFixed(3)}–¥
              {state.preflight.estimatedCostCny.max.toFixed(3)}
            </li>
            <li>
              章预算 {state.budget.spent}/{state.budget.limit}，剩余 {state.budget.remaining}
            </li>
          </ul>
          {state.preflight.blockers.length > 0 ? (
            <p className="write-note">{state.preflight.blockers.join('；')}</p>
          ) : null}
          <div className="write-preflight__actions">
            <button
              type="button"
              className="plan-btn"
              data-testid="write-auto-confirm"
              disabled={!state.preflight.ready}
              onClick={() => {
                setPreflightOpen(false)
                onAuto()
              }}
            >
              开跑
            </button>
            <button type="button" className="plan-mini-btn" onClick={() => setPreflightOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {stalePrompt ? (
        <div className="write-stale-dialog" data-testid="write-stale-dialog">
          <div className="write-preflight__head">上游已改：接下来怎么处理？</div>
          <p className="write-note">默认开新分支：旧正文保留可读，不物理删除。</p>
          <div className="write-preflight__actions">
            <button
              type="button"
              className="plan-btn"
              data-testid="write-stale-branch"
              onClick={() => void useWrite.getState().resolveStale('branch')}
            >
              开新分支（默认）
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="write-stale-replace"
              onClick={() => void useWrite.getState().resolveStale('replace')}
            >
              仅替换
            </button>
            <button
              type="button"
              className="plan-mini-btn"
              data-testid="write-stale-rerun"
              onClick={() => void useWrite.getState().resolveStale('rerun')}
            >
              替换并重跑后续
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
