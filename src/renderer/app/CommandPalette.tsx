import { useEffect, useMemo, useState } from 'react'
import { getBridge } from '../lib/bridge'
import { useOverlayDismiss } from '../hooks'
import { navGuard, useApp, type NavPage } from '../stores/app'

interface Command {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  reason?: string
  run(): void | Promise<void>
}

const PAGE_COMMANDS: Array<{ page: NavPage; label: string }> = [
  { page: 'home', label: '首页 · 项目库' },
  { page: 'plan', label: '规划台' },
  { page: 'write', label: '创作台' },
  { page: 'review', label: '审批台' },
  { page: 'memory', label: '记忆台' },
  { page: 'settings', label: '设置' }
]

export function CommandPalette(): React.JSX.Element | null {
  const open = useApp((state) => state.paletteOpen)
  const setPalette = useApp((state) => state.setPalette)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const close = (): void => {
    setPalette(false)
    setQuery('')
    setActive(0)
  }
  const overlayRef = useOverlayDismiss(open, close)

  useEffect(() => {
    setActive(0)
  }, [query])

  const commands = useMemo<Command[]>(() => {
    const state = useApp.getState()
    const list: Command[] = [
      {
        id: 'new-project',
        label: '新建项目',
        hint: 'Ctrl N',
        run: () => useApp.getState().setNewProjectOpen(true)
      },
      {
        id: 'open-project',
        label: '打开项目…',
        hint: 'Ctrl O',
        run: async () => {
          const bridge = getBridge()
          if (!bridge) return
          const picked = await bridge.dialog.pickProject()
          if (picked.ok && picked.data.path) await useApp.getState().openProject(picked.data.path)
        }
      }
    ]

    for (const entry of PAGE_COMMANDS) {
      const guard = navGuard(entry.page, state.current)
      list.push({
        id: `page-${entry.page}`,
        label: entry.label,
        disabled: guard.disabled,
        ...(guard.reason ? { reason: guard.reason } : {}),
        run: () => useApp.getState().setPage(entry.page)
      })
    }

    if (state.current) {
      list.push({
        id: 'close-project',
        label: `关闭项目「${state.current.project.title}」`,
        run: () => void useApp.getState().closeProject()
      })
    }

    list.push({
      id: 'diagnostics',
      label: '导出诊断包',
      run: () => useApp.getState().exportDiagnostics()
    })
    return list
  }, [open])

  const filtered = commands.filter((command) => {
    if (!query.trim()) return true
    return command.label.toLowerCase().includes(query.trim().toLowerCase())
  })

  if (!open) return null

  const runCommand = async (command: Command | undefined): Promise<void> => {
    if (!command) return
    if (command.disabled) {
      useApp.getState().toast({ tone: 'info', title: command.reason ?? '当前不可用' })
      return
    }
    close()
    await command.run()
  }

  return (
    <div className="overlay overlay--palette" ref={overlayRef} onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          className="palette__input"
          value={query}
          placeholder="搜索命令：新建项目、打开、切页、诊断…"
          aria-label="搜索命令"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((index) => Math.min(filtered.length - 1, index + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(0, index - 1))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              void runCommand(filtered[active])
            }
          }}
        />
        <div className="palette__list" role="listbox">
          {filtered.length === 0 ? (
            <div className="palette__empty">没有匹配的命令。</div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`palette__item${index === active ? ' is-active' : ''}${command.disabled ? ' is-disabled' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => void runCommand(command)}
              >
                <span>{command.label}</span>
                <small>{command.disabled ? command.reason : command.hint}</small>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
