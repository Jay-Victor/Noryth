import { useEffect, useState } from 'react'
import type { PlanG1Preview, PlanG1Result } from '../../../shared/schema/plan'
import { Icon } from '../../components/Icon'

/**
 * G1 行动条（PHASE-06 E4 / UI-DESIGN §4.6）。
 *
 * 有阻断时按钮禁用并显示第一条原因；确认前可看影响预览；
 * 建库失败只提供重试，不提供「回退蓝图」。
 */

export interface GateBarProps {
  g1: PlanG1Preview
  setupState: 'pending' | 'complete' | 'failed'
  blueprintVersion: number
  readOnly: boolean
  onConfirm: () => Promise<PlanG1Result | null>
  onRetry: () => Promise<PlanG1Result | null>
}

export function GateBar({ g1, setupState, blueprintVersion, readOnly, onConfirm, onRetry }: GateBarProps): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!previewOpen && !confirmOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPreviewOpen(false)
      setConfirmOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewOpen, confirmOpen])

  const complete = setupState === 'complete'
  const failed = setupState === 'failed'
  const needsRetry = failed || (g1.locked && !complete)
  const blocked = g1.blockers.length > 0
  const disabled = blocked || g1.locked || complete || readOnly || busy

  const label = complete
    ? `G1 已确认 · 蓝图 v${blueprintVersion}`
    : needsRetry
      ? '建库未完成 · 创作台仍禁用'
      : blocked
        ? `G1 蓝图确认 · ${g1.blockers.length} 项待办`
        : 'G1 蓝图确认 · 可确认'

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setConfirmOpen(false)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }

  return (
    <footer className="plan-gate-bar" data-testid="g1-bar" data-state={setupState}>
      <div className="plan-gate-main">
        <Icon name={complete ? 'lock' : 'arrow'} size={14} />
        <span className="plan-gate-label">{label}</span>
        {!complete && g1.firstBlocker ? (
          <span className="plan-gate-reason" data-testid="g1-blocker" title={g1.firstBlocker}>
            {g1.firstBlocker}
          </span>
        ) : null}
      </div>
      <div className="plan-gate-actions">
        <button
          type="button"
          className="plan-btn"
          data-testid="g1-preview"
          onClick={() => setPreviewOpen(true)}
        >
          影响预览
        </button>
        {needsRetry ? (
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="g1-retry"
            disabled={busy || readOnly}
            onClick={() => void retry()}
          >
            {busy ? '重试中…' : '重试建库'}
          </button>
        ) : (
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="g1-confirm"
            disabled={disabled}
            title={blocked ? g1.firstBlocker ?? undefined : complete ? 'G1 已确认' : readOnly ? '项目只读' : undefined}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? '确认中…' : complete ? '已确认' : '确认蓝图'}
          </button>
        )}
      </div>

      {previewOpen ? (
        <div className="plan-modal" role="dialog" aria-modal="true" data-testid="g1-preview-dialog">
          <div className="plan-modal__card">
            <h3>G1 影响预览</h3>
            <ul className="plan-impact-list">
              <li>注册 {g1.counts.characters} 个角色，创建 {g1.counts.characters} 个私有记忆库 + 1 个公共设定库</li>
              <li>写入 {g1.counts.facts} 条世界初值</li>
              <li>锁定蓝图 v{Math.max(1, blueprintVersion)}；之后修改走变更流程</li>
              <li>
                结构：{g1.counts.mains} 主线 / {g1.counts.volumes} 卷 / {g1.counts.chapters} 章
              </li>
            </ul>
            {blocked ? (
              <div className="plan-modal__blockers">
                <strong>当前阻断</strong>
                <ol>
                  {g1.blockers.slice(0, 8).map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="plan-modal__actions">
              <button type="button" className="plan-btn" onClick={() => setPreviewOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmOpen ? (
        <div className="plan-modal" role="dialog" aria-modal="true" data-testid="g1-confirm-dialog">
          <div className="plan-modal__card">
            <h3>确认 G1？</h3>
            <p>
              将创建 {g1.counts.characters} 个角色、{g1.counts.characters} 个私有记忆库 + 1 个公共设定库、
              {g1.counts.facts} 条世界初值；蓝图锁定 v{Math.max(1, blueprintVersion)}。
            </p>
            <p className="plan-modal__warn">确认后不可回退，只能走变更流程。建库失败时蓝图不回滚，可重试。</p>
            <div className="plan-modal__actions">
              <button type="button" className="plan-btn" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="plan-btn is-primary"
                data-testid="g1-confirm-ok"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? '确认中…' : '确认并建库'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </footer>
  )
}
