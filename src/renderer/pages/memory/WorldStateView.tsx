import { useMemo, useState } from 'react'
import { READER_STATE_LABELS, readerStateOf } from '../../../shared/domain/world-view'
import type { MemoryState, WorldProjectionState } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'
import { WorldTimeline } from './WorldTimeline'

/**
 * 世界状态（PHASE-13 M1-3 / M1-18；UI-DESIGN §7.4）。
 *
 * 上部是世界时间线（章 + 叙事序滑杆），下部三节：
 *   1. 世界事实（客观 / 声称分开标注；含秘密与揭示序）
 *   2. 角色以为什么（信念可与事实矛盾，UI 不合并）
 *   3. 关系边
 *
 * 作者可以显式新增事实、关闭事实——这是**唯一**的作者写入口，
 * 写入仍然只经 `applyAuthorFact`（memory/apply.ts），不新增第二条写路径。
 */

const TRUTH_LABEL: Record<string, string> = { objective: '客观', claim: '声称' }
const AXIS_LABEL: Record<string, string> = { trust: '信任', intimacy: '亲密', tension: '张力' }
const SOURCE_LABEL: Record<string, string> = { author: '作者', event: '事件', memory: '记忆' }

interface FactDraft {
  subject: string
  predicate: string
  object: string
  truth: 'objective' | 'claim'
  visibility: 'public' | 'secret'
  knownBy: string[]
  revealSeq: string
  validFromSeq: string
}

const EMPTY_DRAFT: FactDraft = {
  subject: '',
  predicate: '',
  object: '',
  truth: 'objective',
  visibility: 'public',
  knownBy: [],
  revealSeq: '',
  validFromSeq: ''
}

function namesOf(projection: WorldProjectionState): Map<string, string> {
  return new Map(projection.characters.map((character) => [character.id, character.name]))
}

function AuthorFactForm({ projection }: { projection: WorldProjectionState }): React.JSX.Element {
  const addFact = useMemory((store) => store.addFact)
  const busy = useMemory((store) => store.busy)
  const [draft, setDraft] = useState<FactDraft>(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const patch = (next: Partial<FactDraft>): void => setDraft((current) => ({ ...current, ...next }))

  const submit = async (): Promise<void> => {
    setError(null)
    const reveal = draft.revealSeq.trim() === '' ? null : Number(draft.revealSeq)
    if (reveal !== null && (!Number.isInteger(reveal) || reveal < 0)) {
      setError('揭示序必须是非负整数（留空 = 永不自动揭示）')
      return
    }
    const validFrom = draft.validFromSeq.trim() === '' ? undefined : Number(draft.validFromSeq)
    if (validFrom !== undefined && (!Number.isInteger(validFrom) || validFrom < 0)) {
      setError('生效序必须是非负整数（留空 = 当前叙事序）')
      return
    }
    const ok = await addFact({
      ...(projection.chapterId === null ? {} : { chapterId: projection.chapterId }),
      asOf: projection.asOf,
      subject: draft.subject.trim(),
      predicate: draft.predicate.trim(),
      object: draft.object.trim(),
      truth: draft.truth,
      visibility: draft.visibility,
      knownBy: draft.knownBy,
      revealSeq: reveal,
      ...(validFrom === undefined ? {} : { validFromSeq: validFrom })
    })
    if (ok) setDraft(EMPTY_DRAFT)
  }

  return (
    <section className="memory-group" data-testid="world-author-editor">
      <h4 className="memory-group__title">
        新增事实（作者）
        <span className="pane-header__meta">source_type = author</span>
      </h4>
      <div className="world-form">
        <input
          className="world-form__input"
          data-testid="world-new-subject"
          placeholder="主体（如：账本）"
          value={draft.subject}
          maxLength={60}
          onChange={(event) => patch({ subject: event.target.value })}
        />
        <input
          className="world-form__input"
          data-testid="world-new-predicate"
          placeholder="谓词（如：位置）"
          value={draft.predicate}
          maxLength={40}
          onChange={(event) => patch({ predicate: event.target.value })}
        />
        <input
          className="world-form__input"
          data-testid="world-new-object"
          placeholder="宾语（如：祠堂供桌下）"
          value={draft.object}
          maxLength={200}
          onChange={(event) => patch({ object: event.target.value })}
        />
        <label className="world-form__field">
          真值
          <select
            className="world-form__input"
            data-testid="world-new-truth"
            value={draft.truth}
            onChange={(event) => patch({ truth: event.target.value === 'claim' ? 'claim' : 'objective' })}
          >
            <option value="objective">客观</option>
            <option value="claim">声称</option>
          </select>
        </label>
        <label className="world-form__field">
          可见性
          <select
            className="world-form__input"
            data-testid="world-new-visibility"
            value={draft.visibility}
            onChange={(event) => patch({ visibility: event.target.value === 'secret' ? 'secret' : 'public' })}
          >
            <option value="public">公开</option>
            <option value="secret">秘密</option>
          </select>
        </label>
        <label className="world-form__field">
          知情者
          <select
            className="world-form__input"
            data-testid="world-new-knownby"
            multiple
            size={Math.min(3, Math.max(2, projection.characters.length))}
            value={draft.knownBy}
            onChange={(event) =>
              patch({ knownBy: Array.from(event.target.selectedOptions).map((option) => option.value) })
            }
          >
            {projection.characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <label className="world-form__field">
          揭示序
          <input
            className="world-form__input"
            data-testid="world-new-reveal"
            inputMode="numeric"
            placeholder={`留空 = 不揭示（≤ ${projection.seqHead}）`}
            value={draft.revealSeq}
            onChange={(event) => patch({ revealSeq: event.target.value })}
          />
        </label>
        <label className="world-form__field">
          生效序
          <input
            className="world-form__input"
            data-testid="world-new-validfrom"
            inputMode="numeric"
            placeholder={`留空 = 当前 ${projection.seqHead}`}
            value={draft.validFromSeq}
            onChange={(event) => patch({ validFromSeq: event.target.value })}
          />
        </label>
      </div>
      <div className="world-form__actions">
        <button
          type="button"
          className="plan-btn"
          data-testid="world-fact-add"
          disabled={
            projection.readOnly ||
            busy ||
            draft.subject.trim() === '' ||
            draft.predicate.trim() === '' ||
            draft.object.trim() === ''
          }
          onClick={() => void submit()}
        >
          新增事实
        </button>
        <span className="write-note">
          单值谓词（位置 / 身份 / 生死…）会关闭旧值；多值谓词（喜欢 / 认识 / 去过…）并存。
        </span>
      </div>
      {error ? (
        <p className="write-note world-form__error" data-testid="world-fact-error">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export function WorldStateView({ state }: { state: MemoryState }): React.JSX.Element {
  const projection = useMemory((store) => store.projection)
  const projectionLoading = useMemory((store) => store.projectionLoading)
  const readerOnly = useMemory((store) => store.readerOnly)
  const closeFact = useMemory((store) => store.closeFact)
  const checkIsolation = useMemory((store) => store.checkIsolation)
  const isolation = useMemory((store) => store.isolation)
  const [closingId, setClosingId] = useState<string | null>(null)
  const names = useMemo(() => (projection ? namesOf(projection) : new Map<string, string>()), [projection])

  if (!projection) {
    return (
      <div className="memory-world" data-testid="memory-world">
        <p className="write-note">{projectionLoading ? '正在读世界状态…' : '世界状态还没有加载。'}</p>
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="world-reload"
          onClick={() =>
            void useMemory
              .getState()
              .loadProjection(state.chapterId === null ? {} : { chapterId: state.chapterId })
          }
        >
          重新读取
        </button>
      </div>
    )
  }

  const facts = readerOnly ? projection.facts.filter((fact) => fact.readerKnown) : projection.facts
  const beliefs = readerOnly ? [] : projection.beliefs
  const edges = readerOnly ? [] : projection.edges

  return (
    <div className="memory-world" data-testid="memory-world">
      <WorldTimeline
        projection={projection}
        chapters={state.chapters}
        defaultChapterId={state.chapterId}
      />

      <section className="memory-group">
        <h4 className="memory-group__title">
          世界事实
          <span className="pane-header__meta" data-testid="world-fact-count">
            {facts.length}
          </span>
        </h4>
        {facts.length === 0 ? (
          <p className="write-note">
            {readerOnly
              ? '读者在这个水位还不知道任何事实（公开且已揭示）。'
              : '这个水位还没有世界事实；作者可在下方显式新增。'}
          </p>
        ) : (
          <table className="memory-table" data-testid="memory-world-facts">
            <thead>
              <tr>
                <th>主体</th>
                <th>谓词</th>
                <th>宾语</th>
                <th>真值</th>
                <th>可见</th>
                <th>读者</th>
                <th>知情</th>
                <th>有效</th>
                <th>来源</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {facts.map((fact, index) => (
                <tr
                  key={fact.id}
                  data-testid={`memory-world-fact-${index}`}
                  data-truth={fact.truth}
                  data-reader-known={fact.readerKnown ? '1' : '0'}
                  className={fact.validToSeq === null ? '' : 'is-stale'}
                >
                  <td>{fact.subject}</td>
                  <td>{fact.predicate}</td>
                  <td>{fact.object}</td>
                  <td>
                    <span className={`memory-truth is-${fact.truth}`}>{TRUTH_LABEL[fact.truth] ?? fact.truth}</span>
                  </td>
                  <td>{fact.visibility === 'public' ? '公开' : '秘密'}</td>
                  <td className="mono">{READER_STATE_LABELS[readerStateOf(fact)]}</td>
                  <td>{fact.knownBy.map((id) => names.get(id) ?? id).join('、') || '—'}</td>
                  <td className="mono">
                    {fact.validFromSeq}–{fact.validToSeq ?? '现在'}
                  </td>
                  <td>{SOURCE_LABEL[fact.sourceType] ?? fact.sourceType}</td>
                  <td>
                    {projection.readOnly || fact.validToSeq !== null ? null : closingId === fact.id ? (
                      <span className="world-close-actions">
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`world-fact-close-confirm-${index}`}
                          onClick={() => {
                            setClosingId(null)
                            void closeFact(fact.id, '作者关闭事实')
                          }}
                        >
                          确认关闭
                        </button>
                        <button
                          type="button"
                          className="plan-mini-btn"
                          data-testid={`world-fact-close-cancel-${index}`}
                          onClick={() => setClosingId(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="plan-mini-btn"
                        data-testid={`world-fact-close-${index}`}
                        onClick={() => setClosingId(fact.id)}
                      >
                        关闭
                      </button>
                    )}
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
          <span className="pane-header__meta" data-testid="world-belief-count">
            {beliefs.length}
          </span>
        </h4>
        {readerOnly ? (
          <p className="write-note">读者视图不展示角色信念（信念不是公共设定）。</p>
        ) : beliefs.length === 0 ? (
          <p className="write-note">还没有信念。台词只会进这里，不会变成客观事实。</p>
        ) : (
          <div data-testid="memory-beliefs">
            {beliefs.map((belief, index) => (
              <div key={belief.id} className="memory-belief" data-testid={`memory-belief-${index}`}>
                <span className="memory-belief__who">
                  {names.get(belief.characterId) ?? belief.characterId}
                </span>
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
          <span className="pane-header__meta">{edges.length}</span>
        </h4>
        {readerOnly ? (
          <p className="write-note">读者视图不展示关系边（信任/亲密/张力是角色之间的私有状态）。</p>
        ) : projection.edges.length === 0 ? (
          <p className="write-note">这个水位还没有关系边。</p>
        ) : (
          <div data-testid="memory-relationships">
            {edges.map((edge, index) => (
              <div key={edge.id} className="memory-relation" data-testid={`memory-relation-${index}`}>
                <span>
                  {names.get(edge.fromId) ?? edge.fromId} → {names.get(edge.toId) ?? edge.toId}
                </span>
                <span className="memory-relation__axis">{AXIS_LABEL[edge.axis] ?? edge.axis}</span>
                <span className="mono">{edge.value.toFixed(2)}</span>
                <span className="pane-header__meta">since seq {edge.sinceSeq}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <AuthorFactForm projection={projection} />

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
