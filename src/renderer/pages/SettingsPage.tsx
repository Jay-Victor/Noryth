import { useApp } from '../stores/app'

export function SettingsPage(): React.JSX.Element {
  const appInfo = useApp((state) => state.appInfo)
  const exportDiagnostics = useApp((state) => state.exportDiagnostics)

  return (
    <div className="home">
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div className="kicker">设置</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: '8px 0 6px' }}>
          应用与诊断
        </h1>
        <p className="lead" style={{ marginBottom: 24 }}>
          阶段 01 只做本地设置与诊断包；供应商、绑定与测试连接在阶段 10 实现。项目目录里永远没有 API Key。
        </p>

        <div className="side-card">
          <h2>运行环境</h2>
          <div className="kv">
            <span>版本</span>
            <b>{appInfo ? `Noryth ${appInfo.version}` : '未知'}</b>
          </div>
          <div className="kv">
            <span>Electron / Chrome</span>
            <b>{appInfo ? `${appInfo.electron} / ${appInfo.chrome}` : '未知'}</b>
          </div>
          <div className="kv">
            <span>Node</span>
            <b>{appInfo?.node ?? '未知'}</b>
          </div>
          <div className="kv">
            <span>数据库 schema</span>
            <b>v{appInfo?.schemaVersion ?? '—'}</b>
          </div>
          <div className="kv">
            <span>打包形态</span>
            <b>{appInfo?.packaged ? '已打包' : '开发模式'}</b>
          </div>
        </div>

        <div className="side-card">
          <h2>诊断</h2>
          <p>
            诊断包只含应用版本、项目摘要与日志尾部；导出前会再次扫描 Key 形态并脱敏。不含正文。
          </p>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="button" onClick={() => void exportDiagnostics()}>
              导出诊断包
            </button>
          </div>
        </div>

        <div className="side-card">
          <h2>外观</h2>
          <p>M0 只交付亮色主题；暗色与强调色随设置中心（阶段 10）。</p>
        </div>
      </div>
    </div>
  )
}
