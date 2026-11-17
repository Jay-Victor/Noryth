import { useEffect } from 'react'
import { useApp } from '../../stores/app'
import { useSettings } from '../../stores/settings'
import {
  UPDATE_CHANNEL_LABELS,
  UPDATE_STATUS_LABELS,
  type UpdateState
} from '../../../shared/schema/update'

/**
 * 常规（UI-DESIGN §8.2 / PHASE-10 I4 / PHASE-18 M1-7）。
 *
 * M0 只交付：语言（中文固定）、数据目录、Key 存储说明、诊断导出。
 * M1：更新通道与最近一次检查结果显示真实状态，手动检查只刷新状态，失败不阻塞。
 */

function UpdateCard({ update }: { update: UpdateState }): React.JSX.Element {
  const checkUpdates = useApp((state) => state.checkUpdates)
  const busy = useApp((state) => state.busy)
  const label = UPDATE_STATUS_LABELS[update.status]
  return (
    <section className="side-card">
      <h2>更新</h2>
      <div className="kv">
        <span>通道</span>
        <b data-testid="update-channel">{UPDATE_CHANNEL_LABELS[update.channel]}</b>
      </div>
      <div className="kv">
        <span>状态</span>
        <b data-testid="update-status" data-status={update.status}>
          {label}
        </b>
      </div>
      {update.version ? (
        <div className="kv">
          <span>远端版本</span>
          <b className="mono" data-testid="update-version">
            {update.version}
          </b>
        </div>
      ) : null}
      {update.checkedAt ? (
        <div className="kv">
          <span>上次检查</span>
          <b className="mono">{update.checkedAt.replace('T', ' ').slice(0, 19)}</b>
        </div>
      ) : null}
      {update.error ? (
        <p className="settings-warning" data-testid="update-error">
          {update.error}
        </p>
      ) : null}
      <p className="settings-hint">
        启动时后台检查一次；失败只记日志，不阻塞开窗与写作。只允许同一 minor 的回退，跨 minor 一律拒绝。
      </p>
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="button"
          data-testid="update-check"
          disabled={busy}
          onClick={() => void checkUpdates()}
        >
          检查更新
        </button>
      </div>
    </section>
  )
}
export function GeneralSection(): React.JSX.Element {
  const appInfo = useApp((state) => state.appInfo)
  const refreshAppInfo = useApp((state) => state.refreshAppInfo)
  const exportDiagnostics = useApp((state) => state.exportDiagnostics)
  const view = useSettings((state) => state.view)
  const setOpenLastProject = useSettings((state) => state.setOpenLastProject)
  const setReviewHetero = useSettings((state) => state.setReviewHetero)

  // 更新状态由主进程后台写入；进入设置页时补一次刷新，避免停在 boot 时的 idle。
  useEffect(() => {
    void refreshAppInfo()
  }, [refreshAppInfo])

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
          <b>{UPDATE_CHANNEL_LABELS[appInfo?.update.channel ?? 'stable']}</b>
        </div>
      </section>

      {appInfo ? <UpdateCard update={appInfo.update} /> : null}

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
        <h2>审批</h2>
        <label className="settings-toggle settings-toggle--stacked">
          <span>
            异构复检
            <small>
              开启后，若审批与生成是同一家且另有已验证的提供方，审批自动改用第二家；找不到第二家时报告标
              「异构不可用」，不阻断审批。M1 默认关闭。
            </small>
          </span>
          <select
            data-testid="review-hetero"
            value={view?.review.hetero ?? 'off'}
            onChange={(event) => void setReviewHetero(event.target.value === 'prefer' ? 'prefer' : 'off')}
          >
            <option value="off">关闭</option>
            <option value="prefer">尽量异构（prefer）</option>
          </select>
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
