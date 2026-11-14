import { Icon, type IconName } from '../components/Icon'
import { navGuard, useApp, type NavPage } from '../stores/app'

const ITEMS: Array<{ page: NavPage; label: string; icon: IconName }> = [
  { page: 'home', label: '首页', icon: 'home' },
  { page: 'plan', label: '规划', icon: 'plan' },
  { page: 'write', label: '创作', icon: 'write' },
  { page: 'review', label: '审批', icon: 'review' },
  { page: 'memory', label: '记忆', icon: 'memory' }
]

export function NavRail(): React.JSX.Element {
  const page = useApp((state) => state.page)
  const current = useApp((state) => state.current)
  const setPage = useApp((state) => state.setPage)
  const toast = useApp((state) => state.toast)

  const renderItem = (item: { page: NavPage; label: string; icon: IconName }): React.JSX.Element => {
    const guard = navGuard(item.page, current)
    const active = page === item.page
    const onClick = (): void => {
      if (guard.disabled) {
        toast({ tone: 'info', title: guard.reason ?? '当前不可用', key: `nav-${item.page}` })
        return
      }
      setPage(item.page)
    }
    return (
      <button
        key={item.page}
        type="button"
        className={`nav-item${active ? ' is-active' : ''}${guard.disabled ? ' is-disabled' : ''}`}
        onClick={onClick}
        aria-disabled={guard.disabled}
        aria-current={active ? 'page' : undefined}
        title={guard.disabled ? guard.reason : item.label}
        data-nav={item.page}
      >
        <Icon name={item.icon} size={20} />
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <nav className="nav" aria-label="主导航">
      {ITEMS.map(renderItem)}
      <div className="nav-spacer" />
      {renderItem({ page: 'settings', label: '设置', icon: 'settings' })}
    </nav>
  )
}
