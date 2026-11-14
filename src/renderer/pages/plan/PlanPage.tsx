import { useEffect, useState } from 'react'
import { GRID, type LayoutMode } from '../../../shared/layout/grid'
import { Icon } from '../../components/Icon'
import { useApp } from '../../stores/app'
import { usePlan, type PlanTab } from '../../stores/plan'
import { BlueprintPane } from './BlueprintPane'
import { CharacterCardForm } from './CharacterCardForm'
import { ChatPane } from './ChatPane'
import { GateBar } from './GateBar'
import { WorldPane } from './WorldPane'

const TABS: Array<{ key: PlanTab; label: string }> = [
  { key: 'blueprint', label: '蓝图' },
  { key: 'characters', label: '角色卡' },
  { key: 'world', label: '世界观' },
  { key: 'coverage', label: '覆盖检查' }
]

export function PlanPage({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const current = useApp((state) => state.current)
  const projectId = current?.project.id ?? null
  const state = usePlan((store) => store.state)
  const tab = usePlan((store) => store.tab)
  const setTab = usePlan((store) => store.setTab)
  const loading = usePlan((store) => store.loading)
  const streaming = usePlan((store) => store.streaming)
  const busySessionId = usePlan((store) => store.busySessionId)
  const choice = usePlan((store) => store.choice)
  const saveStatus = usePlan((store) => store.saveStatus)
  const lastSavedAt = usePlan((store) => store.lastSavedAt)
  const [characterId, setCharacterId] = useState<string | null>(null)

  useEffect(() => {
    usePlan.getState().reset()
    if (projectId) void usePlan.getState().load()
  }, [projectId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      const index = Number(event.key)
      if (index >= 1 && index <= TABS.length) {
        event.preventDefault()
        setTab(TABS[index - 1]!.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setTab])

  if (!projectId) {
    return (
      <>
        <section className="pane pane--sessions" data-testid="pane-sessions">
          <div className="pane-header">会话</div>
        </section>
        <section className="pane pane--chat" data-testid="pane-chat">
          <div className="pane-header">对话</div>
          <div className="pane-body">
            <div className="pane-empty">
              <h3>先打开一个项目</h3>
              <p>规划台只在项目内可用。</p>
            </div>
          </div>
        </section>
        <section className="pane pane--preview" data-testid="pane-preview">
          <div className="pane-header">预览</div>
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
        <div className="pane-header">对话</div>
        <div className="pane-body">
          <div className="pane-empty">
            <h3>{loading ? '正在打开规划台…' : '规划台没有数据'}</h3>
            <p>如果一直停在这里，回首页重新打开项目。</p>
          </div>
        </div>
      </section>
    )
  }

  const locked = state.blueprint.lockedAt !== null || state.readOnly
  const selectedCharacter =
    state.characters.find((character) => character.id === characterId) ?? state.characters[0] ?? null
  const treeMode = GRID[mode].treeMode
  const blockers = state.g1.blockers
  const busy = busySessionId !== null

  const saveLabel =
    saveStatus === 'saving'
      ? '保存中…'
      : saveStatus === 'error'
        ? '保存失败'
        : lastSavedAt
          ? `已保存 ${lastSavedAt}`
          : '自动保存 800ms'

  return (
    <>
      <section className="pane pane--sessions" data-testid="pane-sessions" aria-label="会话列表">
        <div className="pane-header">
          <span>会话</span>
          <span className="pane-header__meta">{state.sessions.length}</span>
        </div>
        <div className="pane-body plan-sessions">
          <button
            type="button"
            className="plan-btn plan-sessions__new"
            data-testid="plan-new-session"
            disabled={state.readOnly}
            onClick={() => void usePlan.getState().createSession()}
          >
            ＋ 新建规划会话
          </button>
          {state.sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`plan-session-row${session.id === state.activeSessionId ? ' is-active' : ''}`}
              data-testid={`plan-session-${session.id}`}
              onClick={() => void usePlan.getState().selectSession(session.id)}
            >
              <span className={`plan-session-dot${session.id === state.activeSessionId ? ' is-live' : ''}`} />
              <span className="plan-session-title">{session.title}</span>
              <span className="plan-session-count">{session.messageCount}</span>
            </button>
          ))}

          <div className="plan-unresolved" data-testid="plan-unresolved">
            <div className="plan-subhead">G1 未决项 · {blockers.length}</div>
            {blockers.length === 0 ? (
              <p className="plan-note">没有阻断项。</p>
            ) : (
              blockers.slice(0, 5).map((blocker) => (
                <button
                  key={blocker}
                  type="button"
                  className="plan-unresolved__item"
                  data-testid="plan-unresolved-item"
                  onClick={() => setTab('blueprint')}
                  title={blocker}
                >
                  {blocker}
                </button>
              ))
            )}
            {blockers.length > 5 ? <p className="plan-note">还有 {blockers.length - 5} 项，见影响预览。</p> : null}
          </div>
        </div>
      </section>

      <ChatPane
        state={state}
        streaming={streaming}
        busy={busy}
        choice={choice}
        onSend={(text) => usePlan.getState().send(text)}
        onStop={() => usePlan.getState().stop()}
        onRetry={(messageId) => usePlan.getState().retry(messageId)}
        onApply={(proposalId) => usePlan.getState().applyProposal(proposalId)}
        onReject={(proposalId) => usePlan.getState().rejectProposal(proposalId)}
        onChoose={(choiceId, optionId) => usePlan.getState().choose(choiceId, optionId)}
        onCreateSession={() => usePlan.getState().createSession()}
      />

      <section className="pane pane--preview" data-testid="pane-preview" aria-label="文件预览">
        <div className="pane-header plan-preview-head">
          <div className="plan-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={`plan-tab${tab === item.key ? ' is-active' : ''}`}
                data-testid={`plan-tab-${item.key}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                {item.key === 'coverage' ? <span className="plan-tab__badge">0</span> : null}
              </button>
            ))}
          </div>
          <span className="pane-header__meta" data-testid="plan-save-status">
            {saveLabel} · v{state.blueprint.version}
            {state.blueprint.lockedAt ? ' · 已锁定' : ''}
          </span>
        </div>

        <div className="plan-preview-scroll">
          {state.setupState === 'failed' || (state.g1.locked && state.setupState !== 'complete') ? (
            <div className="plan-setup-banner" data-testid="setup-incomplete">
              <strong>setup_incomplete</strong>
              <span>角色库未建好，创作台保持禁用。蓝图已锁定，不会回滚；重试只补建库。</span>
              <button type="button" className="plan-btn" onClick={() => void usePlan.getState().retrySetup()}>
                重试建库
              </button>
            </div>
          ) : null}

          {tab === 'blueprint' ? (
            <BlueprintPane
              nodes={state.blueprint.nodes}
              locked={locked}
              onSave={(input) => usePlan.getState().saveOutline(input)}
              onAdd={(parentId, kind) => usePlan.getState().addOutline({ parentId, kind, title: kind === 'main' ? '新主线' : kind === 'volume' ? '新卷' : '新章' })}
              onRemove={(nodeId) => usePlan.getState().removeOutline(nodeId)}
            />
          ) : null}

          {tab === 'characters' ? (
            <div className="plan-characters" data-testid="characters-pane">
              <aside className="plan-character-list">
                <div className="plan-tree-head">
                  <span>角色 · {state.characters.length}</span>
                  {!locked ? (
                    <button
                      type="button"
                      className="plan-mini-btn"
                      data-testid="character-add"
                      onClick={() => {
                        void usePlan.getState().addCharacter({ name: `新角色 ${state.characters.length + 1}` })
                        setCharacterId(null)
                      }}
                    >
                      ＋角色
                    </button>
                  ) : null}
                </div>
                {state.characters.length === 0 ? (
                  <p className="plan-tree-empty">角色卡来自注册清单；G1 前可改，voice 四项缺一会阻断。</p>
                ) : (
                  state.characters.map((character) => (
                    <button
                      key={character.id}
                      type="button"
                      className={`plan-character-row${character.id === selectedCharacter?.id ? ' is-active' : ''}`}
                      data-testid={`character-row-${character.id}`}
                      onClick={() => setCharacterId(character.id)}
                    >
                      <span>{character.name}</span>
                      <span className="plan-character-row__meta">v{character.cardVersion}</span>
                    </button>
                  ))
                )}
              </aside>
              <div className="plan-character-detail">
                {selectedCharacter ? (
                  <CharacterCardForm
                    key={selectedCharacter.id}
                    character={selectedCharacter}
                    locked={locked}
                    onSave={(card) => usePlan.getState().saveCharacter(selectedCharacter.id, card)}
                    onRemove={
                      selectedCharacter.status === 'draft' && !locked
                        ? () => {
                            void usePlan.getState().removeCharacter(selectedCharacter.id)
                            setCharacterId(null)
                          }
                        : undefined
                    }
                  />
                ) : (
                  <div className="pane-empty">
                    <h3>还没有角色卡</h3>
                    <p>先让规划 Agent 提案，或手动新增一个角色。</p>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === 'world' ? (
            <WorldPane
              facts={state.facts}
              locked={locked}
              onSave={(input) => usePlan.getState().saveFact(input)}
              onAdd={(input) => usePlan.getState().addFact(input)}
              onRemove={(factId) => usePlan.getState().removeFact(factId)}
            />
          ) : null}

          {tab === 'coverage' ? (
            <div className="plan-coverage" data-testid="coverage-pane">
              <h3>覆盖检查</h3>
              <p className="plan-coverage__state">{state.coverage.note}</p>
              <ul className="plan-coverage__list">
                <li>卷纲关键事件是否有章纲落点</li>
                <li>主要角色是否有出场动机</li>
                <li>主线是否每 3–5 章推进一次</li>
                <li>章纲是否与角色卡能力/关系冲突</li>
              </ul>
              <p className="plan-note">M0 只保留入口与数据契约；不阻断 G1。</p>
            </div>
          ) : null}
        </div>

        <GateBar
          g1={state.g1}
          setupState={state.setupState}
          blueprintVersion={state.blueprint.version}
          readOnly={state.readOnly}
          onConfirm={() => usePlan.getState().confirmG1()}
          onRetry={() => usePlan.getState().retrySetup()}
        />
      </section>

      <section className="pane pane--tree" data-testid="pane-tree" aria-label="文件树">
        {treeMode === 'pane' ? (
          <>
            <div className="pane-header">
              <span>项目结构</span>
              <span className="pane-header__meta">Ctrl B</span>
            </div>
            <div className="pane-body plan-tree-pane">
              <div className="plan-subhead">蓝图</div>
              {state.blueprint.nodes.length === 0 ? (
                <p className="plan-note">空</p>
              ) : (
                state.blueprint.nodes.map((node) => (
                  <div key={node.id} className="plan-tree-file">
                    <span className="mono">{node.kind === 'main' ? '◈' : node.kind === 'volume' ? '▤' : '·'}</span>
                    <span>{node.title}</span>
                    <span className={`plan-tree-status is-${node.status}`}>
                      {node.status === 'locked' ? '锁定' : '草案'}
                    </span>
                  </div>
                ))
              )}

              <div className="plan-subhead">数据库视图</div>
              <div className="plan-tree-file">
                <Icon name="memory" size={12} />
                <span>记忆库</span>
                <span className="pane-header__meta">
                  {state.namespaces.privateCount} 私有 + {state.namespaces.publicCount} 公共
                  {state.namespaces.isolationVerified ? ' · 隔离通过' : ''}
                </span>
              </div>
              <div className="plan-tree-file">
                <Icon name="review" size={12} />
                <span>世界初值</span>
                <span className="pane-header__meta">{state.facts.length}</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="plan" size={12} />
                <span>角色</span>
                <span className="pane-header__meta">{state.characters.length}</span>
              </div>
              <div className="plan-tree-file">
                <Icon name="write" size={12} />
                <span>提案</span>
                <span className="pane-header__meta">{state.proposals.filter((proposal) => proposal.status === 'draft').length} 待处理</span>
              </div>
            </div>
          </>
        ) : (
          <div className="rail">
            <span className="rail-item is-active" title="项目结构">
              <Icon name="plan" size={13} />
            </span>
            <span className="rail-item" title={`角色 ${state.characters.length}`}>
              <Icon name="write" size={13} />
            </span>
            <span className="rail-item" title={`记忆库 ${state.namespaces.privateCount}+${state.namespaces.publicCount}`}>
              <Icon name="memory" size={13} />
            </span>
            <span className="rail-item" title={`提案 ${state.proposals.length}`}>
              <Icon name="review" size={13} />
            </span>
          </div>
        )}
      </section>
    </>
  )
}
