import { useEffect, useMemo, useState } from 'react'
import { GRID, type LayoutMode } from '../../../shared/layout/grid'
import { MEMORY_JOB_LABELS, MEMORY_KIND_LABELS, type MemoryState } from '../../../shared/schema/memory'
import { Icon } from '../../components/Icon'
import { TreeRailTrigger } from '../../app/TreeRailTrigger'
import { useApp } from '../../stores/app'
import { useMemory, type MemoryTab } from '../../stores/memory'
import { AuditList } from './AuditList'
import { GateBar } from './GateBar'
import { MemoryBrowser } from './MemoryBrowser'
import { ProposalList } from './ProposalList'
import { ForeshadowPanel } from './ForeshadowPanel'
import { RelationshipGraph } from './RelationshipGraph'
import { WorldStateView } from './WorldStateView'

/**
 * 记忆台（UI-DESIGN §7 / PHASE-09）。
 *
 * 四分区：章与任务 / 摘要 + 讨论 / 提案·角色记忆·世界状态·审计 / 只读文件树。
 * 讨论永不写库；[应用 G7] 是唯一写入入口；正文在任何路径下都不可改。
 */

const TABS: Array<{ key: MemoryTab; label: string }> = [
  { key: 'proposals', label: '提案' },
  { key: 'entries', label: '角色记忆' },
  { key: 'world', label: '世界状态' },
  { key: 'relations', label: '关系图' },
  { key: 'foreshadows', label: '伏笔' },
  { key: 'audit', label: '审计' }
]

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

function SummaryCard({ state }: { state: MemoryState }): React.JSX.Element {
  const busy = useMemory((store) => store.busy)
  const counts = useMemo(() => {
    const result = { memory: 0, relation: 0, world: 0, supersede: 0, belief: 0 }
    for (const item of state.proposals) {
      if (item.kind === 'world_fact') result.world += 1
      else if (item.kind === 'relationship') result.relation += 1
      else if (item.kind === 'belief') result.belief += 1
      else result.memory += 1
      if (typeof item.payload.supersedes_id === 'string') result.supersede += 1
    }
    return result
  }, [state.proposals])

  return (
    <div className="memory-summary" data-testid="memory-summary">
      <div className="memory-summary__head">
        <strong>
          {state.jobStatus === 'applied'
            ? '已固化'
            : state.chapterTitle
              ? `${state.chapterTitle} · 固化提案`
              : '还没有定稿章节'}
        </strong>
        <span className="pane-header__meta" data-testid="memory-summary-total">
          {state.proposals.length} 条
        </span>
      </div>
      <p>
        新增 {counts.memory} · 信念 {counts.belief} · 关系 {counts.relation} · 世界事实 {counts.world}
        {counts.supersede > 0 ? ` · 取代 ${counts.supersede}` : ''}
      </p>
      <p className="pane-header__meta">
        {state.embedding.model}（{state.embedding.dim} 维）· 向量 {state.embedding.vectorCount} 条
        {state.embedding.degraded ? ' · 哈希降级' : ''}
      </p>
      {state.rebuild.jobStatus === 'applied' ? (
        <p className="pane-header__meta" data-testid="memory-rebuild-result">
          上次重建：旧条目 {state.rebuild.inactiveCount} 条失效 · 新条目 {state.rebuild.rebuiltCount} 条生效
        </p>
      ) : null}
      {state.index.pendingCount > 0 ? (
        <div className="memory-index-note" data-testid="memory-index-note">
          <span>
            索引待重建：{state.index.pendingCount} / {state.index.totalCount} 条仍用其它模型
          </span>
          <button
            type="button"
            className="plan-btn"
            data-testid="memory-index-rebuild"
            disabled={!state.index.allowed || busy}
            title={state.index.reason ?? '按当前模型重算向量（分批 32，可恢复）'}
            onClick={() => void useMemory.getState().reindex()}
          >
            重建索引
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function MemoryPage({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const current = useApp((state) => state.current)
  const projectId = current?.project.id ?? null
  const state = useMemory((store) => store.state)
  const tab = useMemory((store) => store.tab)
  const busy = useMemory((store) => store.busy)
  const loading = useMemory((store) => store.loading)
  const streaming = useMemory((store) => store.streaming)
  const foreshadows = useMemory((store) => store.foreshadows)
  const [message, setMessage] = useState('')

  useEffect(() => {
    useMemory.getState().reset()
    if (projectId) void useMemory.getState().load()
  }, [projectId])

  // 伏笔 tab 首次进入时加载（距离按当前章算）。relation 图在组件内部按需加载。
  useEffect(() => {
    if (tab !== 'foreshadows') return
    if (foreshadows !== null) return
    void useMemory.getState().loadForeshadows(state?.chapterId ?? undefined)
  }, [tab, foreshadows, state?.chapterId])

  // 键盘：J/K 上下条；A 接受；X 拒绝；E 编辑（焦点在输入框时不生效）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const snapshot = useMemory.getState()
      const currentState = snapshot.state
      if (!currentState || snapshot.tab !== 'proposals') return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditable(event.target) || event.isComposing || event.keyCode === 229) return
      const proposals = currentState.proposals
      if (proposals.length === 0) return
      const index = proposals.findIndex((item) => item.id === snapshot.activeProposalId)
      const key = event.key.toLowerCase()
      if (key === 'j') {
        const next = proposals[Math.min(proposals.length - 1, index + 1)]
        if (next) snapshot.focusProposal(next.id)
        return
      }
      if (key === 'k') {
        const previous = proposals[Math.max(0, index - 1)]
        if (previous) snapshot.focusProposal(previous.id)
        return
      }
      const target = proposals[index] ?? proposals[0]
      if (!target || currentState.readOnly || snapshot.busy) return
      if (key === 'a') {
        event.preventDefault()
        void snapshot.decide(target.id, 'accept')
        return
      }
      if (key === 'x') {
        event.preventDefault()
        void snapshot.decide(target.id, 'reject')
        return
      }
      if (key === 'e') {
        event.preventDefault()
        snapshot.beginEdit(target.id, target.text)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!projectId) {
    return (
      <>
        <section className="pane pane--sessions" data-testid="pane-sessions">
          <div className="pane-header">章节</div>
        </section>
        <section className="pane pane--chat" data-testid="pane-chat">
          <div className="pane-header">对话</div>
          <div className="pane-body">
            <div className="pane-empty">
              <h3>先打开一个项目</h3>
              <p>记忆台只在项目内可用。</p>
            </div>
          </div>
        </section>
        <section className="pane pane--preview" data-testid="pane-preview">
          <div className="pane-header">提案</div>
        </section>
        <section className="pane pane--tree" data-testid="pane-tree">
          <div className="pane-header">文件树</div>
        </section>
      </>
    )
  }

  if (!state) {
    return (
      <section className="pane pane--chat" data-testid="pane-chat">
        <div className="pane-header">提案</div>
        <div className="pane-body">
          <div className="pane-empty">
            <h3>{loading ? '正在打开记忆台…' : '还没有章节'}</h3>
            <p>先在规划台完成 G1、在创作台定稿一章。</p>
          </div>
        </div>
      </section>
    )
  }

  const treeMode = GRID[mode].treeMode

  return (
    <>
      <section className="pane pane--sessions" data-testid="pane-sessions" aria-label="章节与固化任务">
        <div className="pane-header">
          <span>章节</span>
          <span className="pane-header__meta">{state.chapters.length}</span>
        </div>
        <div className="pane-body memory-chapters">
          {state.chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              className={`write-chapter-row${chapter.id === state.chapterId ? ' is-active' : ''}`}
              data-testid={`memory-chapter-${chapter.id}`}
              onClick={() => void useMemory.getState().setChapter(chapter.id)}
            >
              <span className="write-chapter-title">{chapter.title}</span>
              <span className="write-chapter-status" data-status={chapter.status}>
                {chapter.finalRevisionId ? '已定稿' : '未定稿'}
              </span>
              <span className="memory-chapter-items">
                {chapter.jobStatus ? `${chapter.appliedCount}/${chapter.itemCount}` : '—'}
              </span>
            </button>
          ))}

          <div className="write-scene-progress">
            <div className="write-subhead">固化任务</div>
            {state.jobs.length === 0 ? (
              <p className="write-note">还没有固化任务。</p>
            ) : (
              state.jobs.slice(0, 8).map((job) => (
                <div key={job.id} className="memory-job-row" data-testid={`memory-job-${job.id}`}>
                  <span className="memory-job-row__chapter">{job.chapterTitle}</span>
                  <span className="memory-job-row__status" data-status={job.status}>
                    {MEMORY_JOB_LABELS[job.status] ?? job.status}
                  </span>
                  <span className="pane-header__meta">
                    {job.appliedCount}/{job.itemCount}
                    {job.mismatches > 0 ? ` · 丢弃 ${job.mismatches}` : ''}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="write-scene-progress">
            <div className="write-subhead">统计</div>
            <div className="review-mini-stats">
              <span>记忆 {state.entries.length}</span>
              <span>事实 {state.worldFacts.length}</span>
              <span>信念 {state.beliefs.length}</span>
              <span>关系 {state.relationships.length}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="pane pane--chat" data-testid="pane-chat" aria-label="摘要与讨论">
        <div className="pane-header">
          <span>记忆对话</span>
          <span className="pane-header__meta">{state.model.label}</span>
        </div>
        <div className="pane-body memory-chat">
          <SummaryCard state={state} />

          <div className="write-chat-stream" data-testid="memory-chat-stream">
            {state.messages.length === 0 && streaming.length === 0 ? (
              <div className="chat-bubble is-agent">
                提案只解释来源与冲突，不改稿；[应用 G7] 是唯一写入入口。
                <div className="chat-bubble__meta">讨论不写库</div>
              </div>
            ) : (
              state.messages.map((item) => (
                <div
                  key={item.id}
                  className={`chat-bubble ${
                    item.role === 'author' ? 'is-author' : item.role === 'system' ? 'is-system' : 'is-agent'
                  }`}
                  data-testid={`memory-message-${item.role}`}
                >
                  {item.body || '…'}
                  {item.kind === 'proposal' ? <div className="chat-bubble__meta">提案已更新</div> : null}
                  {item.kind === 'apply' ? <div className="chat-bubble__meta">已应用</div> : null}
                </div>
              ))
            )}
            {streaming.length > 0 ? (
              <div className="chat-bubble is-agent" data-testid="memory-streaming">
                {streaming}
                <span className="write-caret" aria-hidden="true" />
              </div>
            ) : null}
          </div>

          <div className="write-composer">
            <textarea
              className="write-composer__input"
              data-testid="memory-composer"
              placeholder="追问来源、为什么重要、与哪条冲突（Ctrl+Enter 发送；讨论不改库）"
              value={message}
              rows={3}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  const text = message.trim()
                  if (text.length === 0 || busy) return
                  setMessage('')
                  void useMemory.getState().send(text)
                }
              }}
            />
            <button
              type="button"
              className="plan-btn"
              data-testid="memory-send"
              disabled={busy || message.trim().length === 0}
              onClick={() => {
                const text = message.trim()
                if (text.length === 0) return
                setMessage('')
                void useMemory.getState().send(text)
              }}
            >
              发送
            </button>
          </div>

          <GateBar state={state} />
        </div>
      </section>

      <section className="pane pane--preview" data-testid="pane-preview" aria-label="提案与记忆">
        <div className="pane-header memory-preview-head">
          <div className="write-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={`write-tab${tab === item.key ? ' is-active' : ''}`}
                data-testid={`memory-tab-${item.key}`}
                onClick={() => useMemory.getState().setTab(item.key)}
              >
                {item.label}
                {item.key === 'proposals' && state.g7.pendingCount > 0 ? (
                  <span className="write-tab__badge" data-testid="memory-pending-badge">
                    {state.g7.pendingCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <span className="pane-header__meta">
            {state.readOnly ? '只读' : state.jobStatus === 'applied' ? '已固化' : ''}
          </span>
          <button
            type="button"
            className="plan-btn memory-extract-btn"
            data-testid="memory-extract-button"
            disabled={
              state.readOnly ||
              state.running ||
              state.chapterId === null ||
              state.jobStatus === 'applied' ||
              !state.model.ready
            }
            title={state.jobStatus === 'applied' ? '本章已固化；重建是 M1' : '只读定稿重新抽取'}
            onClick={() => void useMemory.getState().extract()}
          >
            生成提案
          </button>
        </div>

        {tab === 'proposals' ? <ProposalList state={state} /> : null}
        {tab === 'entries' ? <MemoryBrowser state={state} /> : null}
        {tab === 'world' ? <WorldStateView state={state} /> : null}
        {tab === 'relations' ? <RelationshipGraph state={state} /> : null}
        {tab === 'foreshadows' ? (
          foreshadows === null ? (
            <div className="pane-empty" data-testid="foreshadow-loading">
              <h3>正在读取伏笔…</h3>
            </div>
          ) : (
            <ForeshadowPanel state={foreshadows} />
          )
        ) : null}
        {tab === 'audit' ? <AuditList state={state} /> : null}
      </section>

      <section className="pane pane--tree" data-testid="pane-tree" aria-label="只读文件树">
        {treeMode === 'pane' ? (
          <>
            <div className="pane-header">
              <span>纲要 / 记忆视图</span>
              <span className="pane-header__meta">只读</span>
            </div>
            <div className="pane-body write-tree">
              <div className="plan-subhead">章节</div>
              {state.chapters.map((chapter) => (
                <div key={chapter.id} className="plan-tree-file">
                  <Icon name="memory" size={12} />
                  <span className="mono">ch-{String(chapter.ord).padStart(3, '0')}.md</span>
                  <span className="plan-tree-status">{chapter.finalRevisionId ? 'final' : '—'}</span>
                </div>
              ))}
              <div className="plan-subhead">数据库视图</div>
              <div className="plan-tree-file">
                <Icon name="memory" size={12} />
                <span>角色记忆</span>
                <span className="pane-header__meta">{state.entries.length} 条</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="plan" size={12} />
                <span>世界事实</span>
                <span className="pane-header__meta">{state.worldFacts.length} 条</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="write" size={12} />
                <span>审计</span>
                <span className="pane-header__meta">{state.audit.length} 条</span>
              </div>
              <div className="plan-subhead">规则</div>
              <p className="write-note">
                记忆只从定稿抽取；只软失效不删除；正文与分镜在任何路径下都不可改。
              </p>
            </div>
          </>
        ) : (
          <div className="rail">
            <TreeRailTrigger />
            <span className="rail-item is-active" title={`提案 ${state.proposals.length}`}>
              <Icon name="memory" size={13} />
            </span>
            <span className="rail-item" title={`记忆 ${state.entries.length}`}>
              <Icon name="plan" size={13} />
            </span>
            <span className="rail-item" title={`审计 ${state.audit.length}`}>
              <Icon name="write" size={13} />
            </span>
          </div>
        )}
      </section>
    </>
  )
}

export function memoryKindLabel(kind: string): string {
  return MEMORY_KIND_LABELS[kind] ?? kind
}
