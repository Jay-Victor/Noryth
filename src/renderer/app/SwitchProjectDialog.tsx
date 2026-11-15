import { useOverlayDismiss } from '../hooks'
import { useApp } from '../stores/app'

const DOMAIN_LABELS: Record<'write' | 'plan', string> = {
  write: '创作台生成',
  plan: '规划会话'
}

/**
 * 切换项目确认（PHASE-11 §5.1 / UI-DESIGN §2.6 确认对话框 480）。
 *
 * 只在 main 报告「有任务在跑」时出现；确认后走 cancel → 等任务退出 → 关旧库开新库，
 * 已生成的内容保留在旧项目里，不静默丢稿。
 */
export function SwitchProjectDialog(): React.JSX.Element | null {
  const pending = useApp((state) => state.pendingSwitch)
  const confirmSwitch = useApp((state) => state.confirmSwitch)
  const cancelSwitch = useApp((state) => state.cancelSwitch)

  const open = pending !== null
  const overlayRef = useOverlayDismiss(open, cancelSwitch)

  if (!pending) return null
  const tasks =
    pending.domains.length > 0 ? pending.domains.map((domain) => DOMAIN_LABELS[domain]).join('、') : '后台任务'

  return (
    <div className="overlay" ref={overlayRef}>
      <div
        className="dialog dialog--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-title"
        data-testid="switch-dialog"
      >
        <header className="dialog__header">
          <h2 id="switch-title">切换到「{pending.title}」</h2>
          <p>当前项目还有任务在跑。</p>
        </header>
        <div className="dialog__body">
          <p style={{ margin: 0 }}>
            {tasks} 会被取消。已经生成的正文与草稿都保留在磁盘上，重新打开项目即可继续；正在生成的这一拍会标为中断。
          </p>
        </div>
        <footer className="dialog__footer">
          <span className="spacer" />
          <button type="button" className="button" data-testid="switch-cancel" onClick={cancelSwitch}>
            取消
          </button>
          <button
            type="button"
            className="button button--danger"
            data-testid="switch-confirm"
            onClick={() => void confirmSwitch()}
          >
            停止并切换
          </button>
        </footer>
      </div>
    </div>
  )
}
