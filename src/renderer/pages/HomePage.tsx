import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectSummary } from '../../shared/schema/project'
import { ellipsisPath, formatWords, relativeTime } from '../lib/format'
import { getBridge } from '../lib/bridge'
import { useApp } from '../stores/app'
import { Icon } from '../components/Icon'

function projectBadge(project: ProjectSummary): { label: string; tone: string } {
  if (!project.available) return { label: '路径不可用', tone: 'is-danger' }
  if (project.setupState === 'failed') return { label: '初始化未完成', tone: 'is-warn' }
  if (project.setupState === 'pending') return { label: '进行中', tone: 'is-live' }
  return { label: '已就绪', tone: '' }
}

export function HomePage(): React.JSX.Element {
  const projects = useApp((state) => state.projects)
  const current = useApp((state) => state.current)
  const busy = useApp((state) => state.busy)
  const openProject = useApp((state) => state.openProject)
  const setNewProjectOpen = useApp((state) => state.setNewProjectOpen)
  const revealProject = useApp((state) => state.revealProject)
  const setConfirmRemove = useApp((state) => state.setConfirmRemove)
  const relocateProject = useApp((state) => state.relocateProject)
  const toast = useApp((state) => state.toast)

  const [selected, setSelected] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const totals = useMemo(() => {
    return projects.reduce(
      (acc, project) => ({
        chapters: acc.chapters + project.chapterCount,
        words: acc.words + project.wordCount
      }),
      { chapters: 0, words: 0 }
    )
  }, [projects])

  useEffect(() => {
    if (!menuFor) return
    const onDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuFor])

  const pickProject = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) return
    const picked = await bridge.dialog.pickProject()
    if (!picked.ok) {
      toast({ tone: 'error', title: picked.error.message })
      return
    }
    if (!picked.data.path) return
    await openProject(picked.data.path)
  }

  const relocate = async (project: ProjectSummary): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) return
    const picked = await bridge.dialog.pickProject()
    if (!picked.ok || !picked.data.path) return
    await relocateProject(project.id, picked.data.path)
  }

  const renderRow = (project: ProjectSummary): React.JSX.Element => {
    const badge = projectBadge(project)
    const isOpen = current?.project.id === project.id
    return (
      <div
        key={project.id}
        className={`project-row${selected === project.id ? ' is-selected' : ''}`}
        role="button"
        tabIndex={0}
        data-project-id={project.id}
        aria-label={`项目 ${project.title}`}
        onClick={() => setSelected(project.id)}
        onDoubleClick={() => {
          if (project.available) void openProject(project.path)
          else toast({ tone: 'error', title: '路径不可用', detail: '请用「重新定位」指向项目文件夹' })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && project.available) void openProject(project.path)
          if (event.key === 'Delete') setConfirmRemove(project.id)
        }}
      >
        <span className={`status-dot${project.available ? '' : ' is-empty'}`} aria-hidden="true" />
        <div className="project-main">
          <div className="project-name">
            <span className="name">{project.title}</span>
            <span className={`badge ${badge.tone}`}>{badge.label}</span>
            {isOpen && current?.readOnly ? <span className="badge is-warn">只读 · 已开窗</span> : null}
          </div>
          <div className="project-desc">
            {project.genre || '未填题材'} · {project.pov === 'first' ? '第一人称' : project.pov === 'third_limited' ? '第三人称限知' : '第三人称全知'}
          </div>
          <div className="project-path">{ellipsisPath(project.path)}</div>
        </div>
        <div className="project-meta">
          <div>
            <b>{project.chapterCount}</b> 章 · <b>{formatWords(project.wordCount)}</b> 字
          </div>
          <div>{relativeTime(project.lastOpenedAt)}</div>
        </div>
        <button
          type="button"
          className="project-menu-button"
          aria-label="项目操作"
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation()
            setMenuFor(menuFor === project.id ? null : project.id)
          }}
        >
          <Icon name="more" size={16} />
        </button>
        {menuFor === project.id ? (
          <div className="project-menu" role="menu" ref={menuRef} onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuFor(null)
                void revealProject(project.id)
              }}
            >
              在文件夹中查看
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuFor(null)
                void relocate(project)
              }}
            >
              重新定位
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              onClick={() => {
                setMenuFor(null)
                setConfirmRemove(project.id)
              }}
            >
              从列表移除
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="home">
      <div className="home-inner">
        <section>
          <div className="kicker">本地优先 · 一幕一幕写</div>
          <div className="brandmark">Noryth</div>
          <h1>
            先让角色把这场戏演一遍，
            <br />
            再把它写下来。
          </h1>
          <p className="lead">
            作者定蓝图与分镜，角色与旁白按拍演出。每一句台词都能追问依据，每一次定稿都会变成下一章的资产。
          </p>

          <div className="section-label">
            <b>01</b> 启动 <span>选一个空文件夹，Noryth 会建库、建目录、写第一笔</span>
          </div>
          <div className="start-rows">
            <button type="button" className="start-row" onClick={() => void pickProject()} disabled={busy}>
              <span>
                <strong>打开项目</strong>
                <small>接受项目文件夹或 noryth.db；锁在另一窗口时只读打开</small>
              </span>
              <span className="start-row__arrow" aria-hidden="true">
                →
              </span>
            </button>
            <button type="button" className="start-row" onClick={() => setNewProjectOpen(true)} disabled={busy}>
              <span>
                <strong>新建项目</strong>
                <small>三步：位置 → 作品 → 确认；创建后可随时从列表移除</small>
              </span>
              <span className="start-row__arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>

          <div className="section-label">
            <b>02</b> 全部项目 <span>{projects.length} · 按最近打开排序</span>
          </div>
          {projects.length === 0 ? (
            <div className="empty-card" data-testid="project-empty">
              还没有项目。从上方 <strong>01 启动</strong> 开始：选一个空文件夹，Noryth 会建库、建目录、写第一个检查点。
            </div>
          ) : (
            <div className="project-list" data-testid="project-list">
              {projects.map(renderRow)}
            </div>
          )}
        </section>

        <aside>
          <div className="side-card">
            <h2>从零开始</h2>
            <div className="steps">
              <div className="step">
                <span>01</span>
                <div>
                  选空文件夹
                  <small>路径 &lt; 180 字符；同步盘会给警告</small>
                </div>
              </div>
              <div className="step">
                <span>02</span>
                <div>
                  蓝图 G1
                  <small>角色卡 voice 四项齐了才能确认</small>
                </div>
              </div>
              <div className="step">
                <span>03</span>
                <div>
                  开演第一场
                  <small>默认逐拍确认，自动模式需显式开启</small>
                </div>
              </div>
            </div>
          </div>

          <div className="side-card">
            <h2>工坊</h2>
            <div className="stats">
              <div className="stat">
                <b>{projects.length}</b>
                <span>项目</span>
              </div>
              <div className="stat">
                <b>{formatWords(totals.words)}</b>
                <span>累计定稿字数</span>
              </div>
              <div className="stat">
                <b>{totals.chapters}</b>
                <span>已定稿章节</span>
              </div>
            </div>
            <p style={{ marginTop: 10 }}>草稿不计入；第一个项目定稿后开始累计。</p>
          </div>

          <div className="side-card">
            <h2>开工之前</h2>
            <div className="kv">
              <span>分支</span>
              <b>每一拍</b>
            </div>
            <div className="kv">
              <span>文件</span>
              <b>库 + Markdown 镜像</b>
            </div>
            <div className="kv">
              <span>回退</span>
              <b>按 revision，不回收 seq</b>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
