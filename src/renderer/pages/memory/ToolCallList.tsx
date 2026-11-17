import { useEffect } from 'react'
import type { ToolCallListState, ToolCallState } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 工具调用审计（PHASE-18 M1-23 / UI-DESIGN §7.4 审计）。
 *
 * 只读：tool、版本、actor、章、耗时、degraded、错误码。
 * - 不显示 args：审计表里只有 `args_hash`，API 也不返回参数原文（PRD §4.9.7）。
 * - 不提供「重放工具」：重放走 job 幂等，不在 UI 手工触发。
 * - 过滤：章 / Agent / 状态；分页固定 50（主进程钳制上限）。
 */

const DEGRADED_LABELS: Record<string, string> = {
  none: '',
  summary: '摘要',
  facts_only: '仅事实',
  empty: '空结果',
  schema_fallback: '结构回退',
  fail: '失败'
}

function ToolCallRow({ item, index }: { item: ToolCallState; index: number }): React.JSX.Element {
  return (
    <article
      className={`tool-call-row is-${item.status}`}
      data-testid={`tool-call-row-${index}`}
      data-tool={item.tool}
      data-status={item.status}
    >
      <span className="tool-call-row__time mono">{item.createdAt.slice(11, 19)}</span>
      <span className="tool-call-row__tool mono">
        {item.tool}
        {item.toolVersion ? <em>@{item.toolVersion}</em> : null}
      </span>
      <span className="tool-call-row__actor">{item.actorLabel}</span>
      <span className="tool-call-row__chapter">{item.chapterTitle ?? '—'}</span>
      <span className="tool-call-row__latency mono">{item.latencyMs}ms</span>
      <span className="tool-call-row__degraded">
        {item.degraded === 'none' ? '' : (DEGRADED_LABELS[item.degraded] ?? item.degraded)}
      </span>
      <span className="tool-call-row__status">
        {item.status === 'ok' ? 'ok' : (item.errorCode ?? 'error')}
      </span>
    </article>
  )
}

function Footer({ state }: { state: ToolCallListState }): React.JSX.Element {
  const load = useMemory((store) => store.loadToolCalls)
  const loading = useMemory((store) => store.toolCallsLoading)
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize))
  return (
    <div className="tool-call-footer">
      <span className="pane-header__meta" data-testid="tool-call-total">
        共 {state.total} 条 · 第 {state.page} / {pages} 页 · 每页 {state.pageSize}
      </span>
      <span className="tool-call-footer__spacer" />
      <button
        type="button"
        className="plan-btn"
        data-testid="tool-call-prev"
        disabled={state.page <= 1 || loading}
        onClick={() => void load({ page: Math.max(1, state.page - 1) })}
      >
        上一页
      </button>
      <button
        type="button"
        className="plan-btn"
        data-testid="tool-call-next"
        disabled={state.page >= pages || loading}
        onClick={() => void load({ page: state.page + 1 })}
      >
        下一页
      </button>
    </div>
  )
}

export function ToolCallList(): React.JSX.Element {
  const state = useMemory((store) => store.toolCalls)
  const loading = useMemory((store) => store.toolCallsLoading)
  const filters = useMemory((store) => store.toolCallFilters)
  const load = useMemory((store) => store.loadToolCalls)

  useEffect(() => {
    // 进入工具调用视图时按当前过滤条件取第一页；重复进入保留过滤条件。
    // zustand 的 action 引用稳定，这个 effect 只跑一次。
    void load()
  }, [load])

  return (
    <div className="tool-calls" data-testid="tool-call-list">
      <div className="tool-call-filters">
        <label className="tool-call-filter">
          <span>章</span>
          <select
            data-testid="tool-call-filter-chapter"
            value={filters.chapterId}
            onChange={(event) => void load({ chapterId: event.target.value, page: 1 })}
          >
            <option value="">全部</option>
            {(state?.chapters ?? []).map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                第 {chapter.ord} 章 · {chapter.title}
              </option>
            ))}
          </select>
        </label>
        <label className="tool-call-filter">
          <span>Agent</span>
          <select
            data-testid="tool-call-filter-actor"
            value={filters.actorId}
            onChange={(event) => void load({ actorId: event.target.value, page: 1 })}
          >
            <option value="">全部</option>
            {(state?.actors ?? []).map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tool-call-filter">
          <span>状态</span>
          <select
            data-testid="tool-call-filter-status"
            value={filters.status}
            onChange={(event) =>
              void load({ status: event.target.value === 'error' ? 'error' : event.target.value === 'ok' ? 'ok' : 'all', page: 1 })
            }
          >
            <option value="all">全部</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
          </select>
        </label>
        <span className="tool-call-filters__spacer" />
        <span className="pane-header__meta">只读 · 不显示参数 · 不提供重放</span>
      </div>

      {state === null ? (
        <div className="pane-empty" data-testid="tool-call-loading">
          <h3>{loading ? '正在读取工具调用…' : '还没有工具调用记录'}</h3>
          <p>工具调用在生成、审批与检索回合里自动落库；审计表只存参数哈希。</p>
        </div>
      ) : state.items.length === 0 ? (
        <div className="pane-empty" data-testid="tool-call-empty">
          <h3>没有匹配的工具调用</h3>
          <p>换个章、Agent 或状态试试；空结果不代表越权调用不存在。</p>
        </div>
      ) : (
        <>
          <div className="tool-call-head" aria-hidden="true">
            <span>时间</span>
            <span>工具</span>
            <span>Agent</span>
            <span>章</span>
            <span>耗时</span>
            <span>降级</span>
            <span>状态</span>
          </div>
          <div className="tool-call-rows">
            {state.items.map((item, index) => (
              <ToolCallRow key={item.id} item={item} index={index} />
            ))}
          </div>
        </>
      )}

      {state === null ? null : <Footer state={state} />}
    </div>
  )
}
