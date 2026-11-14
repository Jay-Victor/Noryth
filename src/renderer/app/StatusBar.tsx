import { useApp } from '../stores/app'

export function StatusBar(): React.JSX.Element {
  const appInfo = useApp((state) => state.appInfo)
  const current = useApp((state) => state.current)

  const left = current
    ? `已保存 · schema v${current.project.schemaVersion}`
    : '本地优先 · 项目是文件夹'
  const center = !current
    ? '未打开项目'
    : current.readOnly
      ? '只读 · 写入已在主进程拒绝'
      : current.project.setupState === 'complete'
        ? '蓝图已确认'
        : '蓝图未确认'
  const right = appInfo
    ? `Noryth ${appInfo.version} · Electron ${appInfo.electron} · 离线可用`
    : 'Noryth'

  return (
    <footer className="statusbar">
      <span>{left}</span>
      <span className="statusbar__center" data-testid="status-center">
        {center}
      </span>
      <span className="statusbar__right">{right}</span>
    </footer>
  )
}
