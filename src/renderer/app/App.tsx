import { useEffect } from 'react'
import { SHELL, gridTemplateColumns } from '../../shared/layout/grid'
import { getBridge } from '../lib/bridge'
import { useLayoutMode } from '../hooks'
import { useApp } from '../stores/app'
import { CommandPalette } from './CommandPalette'
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog'
import { NavRail } from './NavRail'
import { NewProjectDialog } from './NewProjectDialog'
import { StatusBar } from './StatusBar'
import { ReadOnlyBanner, TitleBar } from './TitleBar'
import { Toasts } from './Toasts'
import { HomePage } from '../pages/HomePage'
import { SettingsPage } from '../pages/SettingsPage'
import { WorkbenchPage } from '../pages/WorkbenchPage'

export function App(): React.JSX.Element {
  const ready = useApp((state) => state.ready)
  const bridgeMissing = useApp((state) => state.bridgeMissing)
  const page = useApp((state) => state.page)
  const current = useApp((state) => state.current)
  const init = useApp((state) => state.init)
  const mode = useLayoutMode()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return
    return bridge.events.onProjectState((event) => {
      useApp.getState().applyStateEvent(event)
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'k') {
        event.preventDefault()
        useApp.getState().setPalette(true)
      } else if (mod && event.key === ',') {
        event.preventDefault()
        useApp.getState().setPage('settings')
      } else if (mod && key === 'n') {
        event.preventDefault()
        useApp.getState().setNewProjectOpen(true)
      } else if (mod && key === 'o') {
        event.preventDefault()
        const bridge = getBridge()
        if (!bridge) return
        void bridge.dialog.pickProject().then((picked) => {
          if (picked.ok && picked.data.path) void useApp.getState().openProject(picked.data.path)
        })
      } else if (event.key === 'Escape') {
        const state = useApp.getState()
        if (state.paletteOpen) state.setPalette(false)
        if (state.newProjectOpen) state.setNewProjectOpen(false)
        if (state.confirmRemoveId) state.setConfirmRemove(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!ready) {
    return (
      <div className="fatal">
        <div className="fatal__card">
          <h1>Noryth</h1>
          <p>正在打开工作台…</p>
        </div>
      </div>
    )
  }

  if (bridgeMissing) {
    return (
      <div className="fatal">
        <div className="fatal__card">
          <h1>无法连接主进程</h1>
          <p>preload 没有注入 window.noryth。请从应用内启动，不要直接用浏览器打开页面。</p>
        </div>
      </div>
    )
  }

  const workbench = page === 'plan' || page === 'write' || page === 'review' || page === 'memory'

  return (
    <div className="app-shell" data-testid="app-ready" data-page={page} data-mode={mode}>
      <TitleBar />
      {current?.readOnly ? <ReadOnlyBanner /> : null}
      <div className="body">
        {page === 'home' ? (
          <div className="shell-grid" style={{ gridTemplateColumns: `${SHELL.nav}px minmax(0, 1fr)` }}>
            <NavRail />
            <HomePage />
          </div>
        ) : workbench ? (
          <div
            className="shell-grid"
            data-mode={mode}
            style={{ gridTemplateColumns: gridTemplateColumns(mode) }}
          >
            <NavRail />
            <WorkbenchPage page={page} mode={mode} />
          </div>
        ) : (
          <div className="shell-grid" style={{ gridTemplateColumns: `${SHELL.nav}px minmax(0, 1fr)` }}>
            <NavRail />
            <SettingsPage />
          </div>
        )}
      </div>
      <StatusBar />
      <CommandPalette />
      <NewProjectDialog />
      <ConfirmRemoveDialog />
      <Toasts />
    </div>
  )
}
