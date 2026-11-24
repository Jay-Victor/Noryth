import { useEffect, useState } from 'react'
import { useApp } from '../../stores/app'
import { useSettings } from '../../stores/settings'
import { AppearanceSection } from './AppearanceSection'
import { BindingTable } from './BindingTable'
import { RoutingCard } from './RoutingCard'
import { GeneralSection } from './GeneralSection'
import { ProviderSettingsCard } from './ProviderSettingsCard'

/**
 * 设置中心（PHASE-10 I1–I4 / UI-DESIGN §8）。
 *
 * M0 四类可导航：常规 / 外观 / Agent 管理 / 提供方；
 * 其余五类保留位置并标 M1，不删除入口，避免作者以为能力消失了。
 */

type Category = 'general' | 'appearance' | 'agents' | 'providers' | 'memory' | 'security' | 'notifications' | 'shortcuts' | 'advanced'

const CATEGORIES: Array<{ key: Category; label: string; enabled: boolean; milestone?: string }> = [
  { key: 'general', label: '常规', enabled: true },
  { key: 'appearance', label: '外观', enabled: true },
  { key: 'agents', label: 'Agent 管理', enabled: true },
  { key: 'providers', label: '提供方', enabled: true },
  { key: 'memory', label: '记忆与上下文', enabled: false, milestone: 'M1' },
  { key: 'security', label: '安全与权限', enabled: false, milestone: 'M1' },
  { key: 'notifications', label: '通知', enabled: false, milestone: 'M1' },
  { key: 'shortcuts', label: '快捷键', enabled: false, milestone: 'M1' },
  { key: 'advanced', label: '高级设置', enabled: false, milestone: 'M1' }
]

const TITLES: Record<Category, { title: string; lead: string }> = {
  general: { title: '常规', lead: '应用版本、数据目录与诊断。' },
  appearance: { title: '外观', lead: '主题、强调色与正文排版，切换即时生效。' },
  agents: { title: 'Agent 管理', lead: '六个 Agent 的绑定与继承链；改绑定只影响下一拍。' },
  providers: { title: '提供方', lead: '填 Key、测试连接、查看模型与计价。' },
  memory: { title: '记忆与上下文', lead: 'M1 开放。' },
  security: { title: '安全与权限', lead: 'M1 开放。' },
  notifications: { title: '通知', lead: 'M1 开放。' },
  shortcuts: { title: '快捷键', lead: 'M1 开放。' },
  advanced: { title: '高级设置', lead: 'M1 开放。' }
}

export function SettingsPage(): React.JSX.Element {
  const [category, setCategory] = useState<Category>('general')
  const current = useApp((state) => state.current)
  const view = useSettings((state) => state.view)
  const load = useSettings((state) => state.load)
  const loadProject = useSettings((state) => state.loadProject)
  const projectId = current?.project.id ?? null

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (projectId !== null) void loadProject(projectId)
  }, [projectId, loadProject])

  const meta = TITLES[category]

  return (
    <div className="settings" data-testid="settings-page" data-category={category}>
      <nav className="settings__nav" aria-label="设置分类">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="settings__navitem"
            data-active={entry.key === category}
            data-enabled={entry.enabled}
            data-testid={`settings-nav-${entry.key}`}
            title={entry.enabled ? undefined : `${entry.milestone ?? 'M1'} 开放`}
            onClick={() => setCategory(entry.key)}
          >
            {entry.label}
            {entry.enabled ? null : <span className="settings__navbadge">{entry.milestone}</span>}
          </button>
        ))}
      </nav>

      <div className="settings__body">
        <header className="settings__header">
          <div className="settings__crumb">设置 / {meta.title}</div>
          <h1>{meta.title}</h1>
          <p className="settings__lead">{meta.lead}</p>
          <div className="settings__status" data-testid="settings-status">
            {view ? (view.secureStorage ? 'Key 加密存储' : 'Key 仅本次运行') : '读取中…'}
          </div>
        </header>

        {category === 'general' ? <GeneralSection /> : null}
        {category === 'appearance' ? <AppearanceSection /> : null}
        {category === 'agents' ? (
          projectId === null ? (
            <section className="side-card">
              <h2>Agent 管理</h2>
              <p>打开一个项目后可以逐 Agent 绑定模型。</p>
            </section>
          ) : (
            <>
              <RoutingCard />
              <BindingTable />
            </>
          )
        ) : null}
        {category === 'providers' ? (
          <>
            {view ? (
              view.providers.map((provider) => (
                <ProviderSettingsCard key={provider.preset} provider={provider} />
              ))
            ) : (
              <section className="side-card">正在读取提供方…</section>
            )}
          </>
        ) : null}
        {!CATEGORIES.find((entry) => entry.key === category)?.enabled ? (
          <section className="side-card settings-disabled">
            <h2>{meta.title}</h2>
            <p>这一类配置在 M1 开放；M0 的写入权限、闸门与审计已由主进程强制，不依赖这里。</p>
          </section>
        ) : null}
      </div>
    </div>
  )
}
