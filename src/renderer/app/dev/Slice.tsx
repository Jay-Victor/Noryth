import { useEffect, useState } from 'react'
import {
  SLICE_BUSY_STATUSES,
  SLICE_STATUS_LABELS,
  type SliceBeatState
} from '../../../shared/schema/slice'
import { useSlice } from '../../stores/slice'

/**
 * 开发切片最小 UI（PHASE-05 §5.3）。
 *
 * 只验证状态：正文两段、拍状态、依据 chips、确认/重生成/编辑、trace 折叠。
 * 入口只通过 `#/dev/slice` 且未打包构建可达；不进入正式导航。
 */

const STATUS_LABEL = SLICE_STATUS_LABELS
const BUSY = SLICE_BUSY_STATUSES

function quoteLabel(type: string): string {
  switch (type) {
    case 'memory':
      return '记忆'
    case 'belief':
      return '信念'
    case 'fact':
      return '事实'
    case 'canon':
      return '设定'
    case 'outline':
      return '纲要'
    case 'manuscript':
      return '正文'
    default:
      return type
  }
}

function BeatBlock({ beat }: { beat: SliceBeatState }): React.JSX.Element {
  const streaming = useSlice((state) => state.streaming[beat.id])
  const busyBeatId = useSlice((state) => state.busyBeatId)
  const generate = useSlice((state) => state.generate)
  const regenerate = useSlice((state) => state.regenerate)
  const confirm = useSlice((state) => state.confirm)
  const edit = useSlice((state) => state.edit)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(beat.body)
  const [openQuote, setOpenQuote] = useState<string | null>(null)

  const busy = BUSY.includes(beat.status) || busyBeatId === beat.id
  const body = streaming !== undefined ? streaming : beat.body

  const startEdit = (): void => {
    setDraft(beat.body)
    setEditing(true)
  }
  const save = async (): Promise<void> => {
    await edit(beat.id, draft)
    setEditing(false)
  }

  return (
    <section className="slice-beat" data-testid={`slice-beat-ord-${beat.ord}`} data-beat-id={beat.id}>
      <header className="slice-beat__head">
        <span className="slice-beat__ord">{beat.ord}</span>
        <span className="slice-beat__speaker">
          {beat.speakerName}
          <span className="slice-beat__meta">{beat.speakerType === 'narrator' ? '旁白' : '角色'}</span>
        </span>
        <span
          className={`slice-status slice-status--${beat.status}`}
          data-testid={`slice-status-ord-${beat.ord}`}
          data-status={beat.status}
        >
          {STATUS_LABEL[beat.status]}
        </span>
        <span className="slice-beat__words">
          {beat.wordCount} / {beat.maxWords ?? '—'} 字
        </span>
      </header>

      <p className="slice-intent">意图：{beat.intent || '（分镜未写）'}</p>

      {editing ? (
        <div className="slice-edit">
          <textarea
            className="slice-edit__input"
            data-testid={`slice-edit-input-ord-${beat.ord}`}
            value={draft}
            rows={4}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="slice-actions">
            <button type="button" className="slice-btn is-primary" data-testid={`slice-edit-save-ord-${beat.ord}`} onClick={() => void save()}>
              保存编辑
            </button>
            <button type="button" className="slice-btn" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="slice-body" data-testid={`slice-body-ord-${beat.ord}`}>
          {body || (busy ? '…' : '（尚未生成）')}
        </p>
      )}

      {beat.grounding.length > 0 ? (
        <div className="slice-chips" data-testid={`slice-chips-ord-${beat.ord}`}>
          {beat.grounding.map((item) => {
            const key = `${item.type}:${item.id}`
            const open = openQuote === key
            return (
              <span key={key} className="slice-chip-wrap">
                <button
                  type="button"
                  className={`slice-chip${open ? ' is-open' : ''}`}
                  data-testid={`slice-chip-${item.type}-${item.id}`}
                  title={item.quote}
                  onClick={() => setOpenQuote(open ? null : key)}
                >
                  {quoteLabel(item.type)} · {item.id}
                </button>
                {open ? (
                  <span className="slice-quote" data-testid={`slice-quote-${item.type}-${item.id}`}>
                    {item.quote}
                  </span>
                ) : null}
              </span>
            )
          })}
        </div>
      ) : null}

      <div className="slice-actions">
        {beat.body.trim().length === 0 && !busy ? (
          <button
            type="button"
            className="slice-btn is-primary"
            data-testid={`slice-generate-ord-${beat.ord}`}
            onClick={() => void generate(beat.id)}
          >
            生成本拍
          </button>
        ) : null}
        {beat.status === 'waiting_for_human' && !busy ? (
          <button
            type="button"
            className="slice-btn is-primary"
            data-testid={`slice-confirm-ord-${beat.ord}`}
            onClick={() => void confirm(beat.id)}
          >
            确认
          </button>
        ) : null}
        {beat.body.trim().length > 0 && !busy ? (
          <button
            type="button"
            className="slice-btn"
            data-testid={`slice-regenerate-ord-${beat.ord}`}
            onClick={() => void regenerate(beat.id)}
          >
            重生成
          </button>
        ) : null}
        {beat.body.trim().length > 0 && !busy && !editing ? (
          <button
            type="button"
            className="slice-btn"
            data-testid={`slice-edit-toggle-ord-${beat.ord}`}
            onClick={startEdit}
          >
            编辑
          </button>
        ) : null}
        {busy ? <span className="slice-busy">生成中…</span> : null}
      </div>

      <details className="slice-trace" data-testid={`slice-trace-ord-${beat.ord}`}>
        <summary>轨迹与版本</summary>
        <dl>
          <dt>trace</dt>
          <dd className="mono">{beat.traceRef ?? '（未归档）'}</dd>
          <dt>revision</dt>
          <dd className="mono">{beat.revisionId}</dd>
          <dt>grounding</dt>
          <dd>{beat.grounding.length} 条（仅本轮工具返回的引用可通过校验）</dd>
        </dl>
      </details>
    </section>
  )
}

export function SlicePage(): React.JSX.Element {
  const state = useSlice((store) => store.state)
  const error = useSlice((store) => store.error)
  const busyBeatId = useSlice((store) => store.busyBeatId)
  const load = useSlice((store) => store.load)
  const seed = useSlice((store) => store.seed)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="slice-page" data-testid="slice-page" data-busy={busyBeatId ?? ''}>
      <header className="slice-header">
        <div>
          <h2>开发切片 · 一拍跑通</h2>
          <p className="slice-sub">
            仅开发构建可见；假模型 + 4 个只读工具 + 真实 commitBeat。入口不进入正式导航。
          </p>
        </div>
        <button type="button" className="slice-btn" data-testid="slice-seed" onClick={() => void seed()}>
          初始化 / 重建 fixture
        </button>
      </header>

      {error ? (
        <p className="slice-error" data-testid="slice-error">
          {error}
        </p>
      ) : null}

      {state ? (
        <div className="slice-meta">
          <span data-testid="slice-chapter">
            {state.chapterOrd}. {state.chapterTitle}
          </span>
          <span className="mono" data-testid="slice-revision">
            {state.revisionId ?? '（无 revision）'} · {state.contentHash?.slice(0, 12) ?? '—'}
          </span>
          <span data-testid="slice-last-job">
            {state.lastJob ? `${state.lastJob.status}${state.lastJob.errorCode ? ` / ${state.lastJob.errorCode}` : ''}` : '无任务'}
          </span>
        </div>
      ) : null}

      {state && state.beats.length === 0 ? (
        <p className="slice-empty" data-testid="slice-empty">
          这个项目还没有切片数据。点「初始化」写入 1 章 / 1 场 / 2 拍 / 5 角色。
        </p>
      ) : null}

      <div className="slice-beats">
        {state?.beats.map((beat) => <BeatBlock key={`${beat.ord}:${beat.revisionId}`} beat={beat} />)}
      </div>
    </main>
  )
}
