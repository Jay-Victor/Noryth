import { useEffect } from 'react'
import type { ProjectTreeNode } from '../../shared/schema/project'
import { VirtualList } from '../components/VirtualList'
import { Icon } from '../components/Icon'
import { useLayoutMode, useOverlayDismiss } from '../hooks'
import { useApp } from '../stores/app'
import { useTree } from '../stores/tree'
import { useWrite } from '../stores/write'

const WORKBENCH = new Set(['plan', 'write', 'review', 'memory'])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * 文件树抽屉（PHASE-11 M1-16 / UI-DESIGN §2.6）。
 *
 * W2/W3 下文件树是 44px 轨道，Ctrl+B 或点轨道展开 320px overlay 抽屉。
 * 三条硬约束：
 * 1. 不改变正文列宽——overlay 不参与栅格（position: fixed）；
 * 2. 焦点可进出——role=dialog + 焦点陷阱，Esc 回到触发元素；
 * 3. 不打断输入——IME composition 期间或拍编辑中不开抽屉。
 */
export function FileTreeDrawer(): React.JSX.Element | null {
  const open = useTree((state) => state.open)
  const nodes = useTree((state) => state.nodes)
  const loading = useTree((state) => state.loading)
  const activeIndex = useTree((state) => state.activeIndex)
  const projectTitle = useApp((state) => state.current?.project.title ?? '')
  const mode = useLayoutMode()

  const close = (): void => useTree.getState().close()
  const overlayRef = useOverlayDismiss(open, close)

  // Ctrl+B 只在工作台 scope 生效；W1 有常驻树，不需要抽屉。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.key.toLowerCase() !== 'b') return
      if (event.isComposing || event.keyCode === 229) return
      const app = useApp.getState()
      if (!WORKBENCH.has(app.page)) return
      if (!app.current) return
      if (mode === 'W1') return
      // 正文拍编辑中不抢焦点，避免中文输入法被打断。
      if (useWrite.getState().editingBeatId) return
      if (isEditableTarget(event.target) && useTree.getState().open) return
      event.preventDefault()
      void useTree.getState().toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode])

  // 换项目时清空抽屉，避免显示上一个项目的树。
  const projectId = useApp((state) => state.current?.project.id ?? null)
  useEffect(() => {
    useTree.getState().reset()
  }, [projectId])

  if (!open || mode === 'W1' || !projectId) return null

  const renderRow = (node: ProjectTreeNode, index: number, active: boolean): React.ReactNode => {
    if (node.kind === 'group') {
      return (
        <div className="tree-drawer__group" style={{ paddingLeft: 8 + node.depth * 12 }}>
          <span>{node.label}</span>
        </div>
      )
    }
    return (
      <button
        type="button"
        className={`tree-drawer__file${active ? ' is-active' : ''}`}
        style={{ paddingLeft: 8 + node.depth * 12 }}
        data-testid={`tree-node-${node.id}`}
        data-page={node.page ?? ''}
        onClick={() => useTree.getState().select(index)}
      >
        <Icon name="write" size={12} />
        <span className="tree-drawer__label">{node.label}</span>
        {node.status ? <span className="tree-drawer__meta">{node.status}</span> : null}
      </button>
    )
  }

  return (
    <div className="tree-drawer-layer" ref={overlayRef} data-testid="tree-drawer-layer">
      <aside
        className="tree-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="文件树"
        data-testid="tree-drawer"
      >
        <header className="tree-drawer__head">
          <span className="tree-drawer__title">{projectTitle || '项目'}</span>
          <button
            type="button"
            className="tree-drawer__close"
            aria-label="关闭文件树"
            data-testid="tree-drawer-close"
            onClick={close}
          >
            Esc
          </button>
        </header>
        <div
          className="tree-drawer__body"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            useTree.getState().select(useTree.getState().activeIndex)
          }}
        >
          {loading ? (
            <p className="tree-drawer__note">正在读取项目结构…</p>
          ) : nodes.length === 0 ? (
            <p className="tree-drawer__note">还没有可打开的文件。</p>
          ) : (
            <VirtualList
              items={nodes}
              activeIndex={activeIndex}
              onActivate={(index) => useTree.getState().setActive(index)}
              renderRow={renderRow}
              ariaLabel="项目文件"
              testId="tree-drawer-list"
            />
          )}
        </div>
      </aside>
      <button type="button" className="tree-drawer__scrim" aria-label="关闭文件树" tabIndex={-1} onClick={close} />
    </div>
  )
}
