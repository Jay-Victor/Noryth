import { useApp } from '../../stores/app'
import { useSettings } from '../../stores/settings'

/**
 * 常规（UI-DESIGN §8.2 / PHASE-10 I4）。
 *
 * M0 只交付：语言（中文固定）、数据目录、Key 存储说明、诊断导出。
 * 更新通道与自动更新由 J4 接 electron-updater；这里显示当前状态，不做假开关。
 */
export function GeneralSection(): React.JSX.Element {
  const appInfo = useApp((state) => state.appInfo)
  const exportDiagnostics = useApp((state) => state.exportDiagnostics)
  const view = useSettings((state) => state.view)
  const setOpenLastProject = useSettings((state) => state.setOpenLastProject)

  return (
    <>
      <section className="side-card">
        <h2>应用</h2>
        <div className="kv">
          <span>版本</span>
          <b>{appInfo ? `Noryth ${appInfo.version}` : '未知'}</b>
        </div>
        <div className="kv">
          <span>运行环境</span>
          <b>{appInfo ? `Electron ${appInfo.electron} · Chromium ${appInfo.chrome}` : '未知'}</b>
        </div>
        <div className="kv">
          <span>数据库 schema</span>
          <b>v{appInfo?.schemaVersion ?? '—'}</b>
        </div>
        <div className="kv">
          <span>语言</span>
          <b>中文（M0 仅中文）</b>
        </div>
        <div className="kv">
          <span>更新通道</span>
          <b>{appInfo?.packaged ? 'stable · 启动检查，失败不阻塞' : 'dev · 不检查更新'}</b>
        </div>
      </section>

      <section className="side-card">
        <h2>数据</h2>
        <div className="kv">
          <span>设置文件</span>
          <b className="settings-path">{view?.settingsPath ?? '—'}</b>
        </div>
        <div className="kv">
          <span>Key 存储</span>
          <b className="settings-path">{view?.secretsPath ?? '—'}</b>
        </div>
        <p className="settings-hint">
          API Key 用 Windows DPAPI（safeStorage）加密后保存；项目目录、日志与诊断包都不含明文。
        </p>
        {view && !view.secureStorage ? (
          <p className="settings-warning" data-testid="secure-storage-warning">
            系统密钥存储不可用：Key 只在本次运行有效，不会写盘。重启后需要重新填写。
          </p>
        ) : null}
      </section>

      <section className="side-card">
        <h2>启动与窗口</h2>
        <label className="settings-toggle settings-toggle--stacked">
          <input
            type="checkbox"
            data-testid="open-last-project"
            checked={view?.openLastProject ?? true}
            onChange={(event) => void setOpenLastProject(event.target.checked)}
          />
          <span>
            启动时自动打开上次项目
            <small>关掉后启动停在首页。上次项目被占用或路径失效时不会自动打开，也不会自动只读打开。</small>
          </span>
        </label>
      </section>

      <section className="side-card">
        <h2>诊断</h2>
        <p>
          诊断包是 zip：只含应用版本、schema 版本、项目摘要、当前项目最近任务与日志尾部；导出前会再次扫描 Key 形态并脱敏。不含正文。
        </p>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="button" onClick={() => void exportDiagnostics()}>
            导出诊断包
          </button>
        </div>
      </section>
    </>
  )
}
