import { useOverlayDismiss } from '../hooks'
import { useApp } from '../stores/app'

export function ConfirmRemoveDialog(): React.JSX.Element | null {
  const projectId = useApp((state) => state.confirmRemoveId)
  const projects = useApp((state) => state.projects)
  const setConfirmRemove = useApp((state) => state.setConfirmRemove)
  const removeProject = useApp((state) => state.removeProject)

  const open = projectId !== null
  const close = (): void => setConfirmRemove(null)
  const overlayRef = useOverlayDismiss(open, close)

  if (!open) return null
  const project = projects.find((item) => item.id === projectId)

  return (
    <div className="overlay" ref={overlayRef}>
      <div className="dialog dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="remove-title">
        <header className="dialog__header">
          <h2 id="remove-title">从项目库移除</h2>
          <p>只影响列表，不删除磁盘文件。</p>
        </header>
        <div className="dialog__body">
          <p style={{ margin: 0 }}>
            确定移除 <strong>{project?.title ?? '该项目'}</strong>？项目文件夹与 noryth.db 都会保留，可随时重新打开。
          </p>
        </div>
        <footer className="dialog__footer">
          <span className="spacer" />
          <button type="button" className="button" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              if (projectId) void removeProject(projectId)
              close()
            }}
          >
            从列表移除
          </button>
        </footer>
      </div>
    </div>
  )
}
