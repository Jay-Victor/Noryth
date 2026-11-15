import { useMemo } from 'react'
import type { MemoryState } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 世界状态只读视图（UI-DESIGN §7.4 世界状态 / PRD §5.4）。
 *
 * M0 只读当前视图：事实表（truth / visibility / known_by / reveal_seq / 有效期）、
 * 角色信念（「角色以为什么」，可与事实矛盾）、关系边。
 * as-of 滑块与关系图是 M1。
 */

export function WorldStateView({ state }: { state: MemoryState }): React.JSX.Element {
  const checkIsolation = useMemory((store) => store.checkIsolation)
  const isolation = useMemory((store) => store.isolation)
  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of state.entries) map.set(entry.characterId, entry.characterName)
    for (const belief of state.beliefs) map.set(belief.characterId, belief.characterName)
    for (const edge of state.relationships) {
      map.set(edge.fromId, edge.fromName)
      map.set(edge.toId, edge.toName)
    }
    return map
  }, [state.entries, state.beliefs, state.relationships])

  return (
    <div className="memory-world" data-testid="memory-world">
      <section className="memory-group">
        <h4 className="memory-group__title">
          世界事实
          <span className="pane-header__meta">{state.worldFacts.length}</span>
        </h4>
        {state.worldFacts.length === 0 ? (
          <p className="write-note">还没有世界事实。作者可在世界状态显式新增（M1 编辑器）。</p>
        ) : (
          <table className="memory-table" data-testid="memory-world-facts">
            <thead>
              <tr>
                <th>主体</th>
                <th>谓词</th>
                <th>宾语</th>
                <th>真值</th>
                <th>可见性</th>
                <th>知情者</th>
                <th>有效期</th>
              </tr>
            </thead>
            <tbody>
              {state.worldFacts.map((fact, index) => (
                <tr
                  key={fact.id}
                  data-testid={`memory-world-fact-${index}`}
                  data-truth={fact.truth}
                  className={fact.validToSeq === null ? '' : 'is-stale'}
                >
                  <td>{fact.subject}</td>
                  <td>{fact.predicate}</td>
                  <td>{fact.object}</td>
                  <td>
                    <span className={`memory-truth is-${fact.truth}`}>
                      {fact.truth === 'objective' ? '客观' : '声称'}
                    </span>
                  </td>
                  <td>{fact.visibility === 'public' ? '公开' : '秘密'}</td>
                  <td>{fact.knownBy.map((id) => names.get(id) ?? id).join('、') || '—'}</td>
                  <td className="mono">
                    {fact.validFromSeq}–{fact.validToSeq ?? '现在'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="memory-group">
        <h4 className="memory-group__title">
          角色以为什么
          <span className="pane-header__meta">{state.beliefs.length}</span>
        </h4>
        {state.beliefs.length === 0 ? (
          <p className="write-note">还没有信念。台词只会进这里，不会变成客观事实。</p>
        ) : (
          <div data-testid="memory-beliefs">
            {state.beliefs.map((belief, index) => (
              <div key={belief.id} className="memory-belief" data-testid={`memory-belief-${index}`}>
                <span className="memory-belief__who">{belief.characterName}</span>
                <span>{belief.beliefText}</span>
                <span className="pane-header__meta">
                  置信 {belief.confidence.toFixed(2)} · seq {belief.learnedSeq} ·{' '}
                  {belief.status === 'active' ? '生效' : '已失效'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="memory-group">
        <h4 className="memory-group__title">
          关系边
          <span className="pane-header__meta">{state.relationships.length}</span>
        </h4>
        {state.relationships.length === 0 ? (
          <p className="write-note">还没有关系边。</p>
        ) : (
          <div data-testid="memory-relationships">
            {state.relationships.map((edge, index) => (
              <div key={edge.id} className="memory-relation" data-testid={`memory-relation-${index}`}>
                <span>
                  {edge.fromName} → {edge.toName}
                </span>
                <span className="memory-relation__axis">
                  {edge.axis === 'trust' ? '信任' : edge.axis === 'intimacy' ? '亲密' : '张力'}
                </span>
                <span className="mono">{edge.value.toFixed(2)}</span>
                <span className="pane-header__meta">since seq {edge.sinceSeq}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="memory-group">
        <h4 className="memory-group__title">隔离回归（H5）</h4>
        <p className="write-note">
          写向量后按每个角色自己的记忆检索一次；跨角色命中必须为 0，命中即 isolation_violation。
        </p>
        <button
          type="button"
          className="plan-btn"
          data-testid="memory-isolation-run"
          disabled={state.readOnly || state.entries.length === 0}
          onClick={() => void checkIsolation()}
        >
          跑隔离回归
        </button>
        {isolation ? (
          <div className="memory-isolation" data-testid="memory-isolation-report">
            <strong>{isolation.verified ? '通过：0 跨角色命中' : '未通过'}</strong>
            {isolation.probes.map((probe) => (
              <div key={probe.characterId} className="memory-isolation__row">
                <span className="mono">{probe.characterId}</span>
                <span>命中 {probe.hits}</span>
                <span>他人 {probe.foreign}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
