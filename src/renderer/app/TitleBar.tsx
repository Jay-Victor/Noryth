import { useApp, type Page } from '../stores/app'
import { Icon } from '../components/Icon'

const PAGE_LABEL: Record<Page, string> = {
  home: '项目库',
  plan: '规划台',
  write: '创作台',
  review: '审批台',
  memory: '记忆台',
  settings: '设置'
}

export function TitleBar(): React.JSX.Element {
  const page = useApp((state) => state.page)
  const current = useApp((state) => state.current)
  const setPalette = useApp((state) => state.setPalette)

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span>NORYTH</span>
        <small>剧场式小说工作台</small>
      </div>
      <div className="titlebar__crumb">
        <span aria-hidden="true">/</span> {PAGE_LABEL[page]}
        {current ? <span> · {current.project.title}</span> : null}
      </div>
      <div className="titlebar__hint">
        <button type="button" onClick={() => setPalette(true)} aria-label="打开命令面板（Ctrl K）">
          <Icon name="palette" size={13} />
          <span>命令</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
    </header>
  )
}

export function ReadOnlyBanner(): React.JSX.Element {
  const current = useApp((state) => state.current)
  return (
    <div className="readonly-banner" role="status">
      <Icon name="lock" size={14} />
      <span>
        此项目已在另一窗口打开，当前为只读
        {current?.lockHolder
          ? `（持有窗口 pid ${current.lockHolder.pid} · ${current.lockHolder.host}）`
          : ''}
      </span>
    </div>
  )
}
