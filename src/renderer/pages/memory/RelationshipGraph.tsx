import { useEffect, useMemo, useState } from 'react'
import type { MemoryState, RelationGraphEdge } from '../../../shared/schema/memory'
import { useMemory } from '../../stores/memory'

/**
 * 关系图（PHASE-14 M1-5 / UI-DESIGN §7.4 关系图）。
 *
 * - 节点 = active 角色；边 = as-of 有效的关系边，三轴分色；
 * - 宽度 = |value|；虚线 + 箭头 = 单向（同轴没有反向边）；
 * - 时间轴回放：滑杆改 as_of，边值随投影变化（与服务端同一个口径）；
 * - 点边 → 来源面板（章 · 记忆 / 拍）；**不显示私有记忆正文**；
 * - 布局坐标由主进程算好（确定性圆环），renderer 只画，不做力导向。
 */

const AXIS_LABEL: Record<RelationGraphEdge['axis'], string> = {
  trust: '信任',
  intimacy: '亲密',
  tension: '张力'
}

const EDGE_RADIUS = 18
const NODE_RADIUS = 16

function arrow(x1: number, y1: number, x2: number, y2: number): { x1: number; y1: number; x2: number; y2: number } {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (length === 0) return { x1, y1, x2, y2 }
  const ux = dx / length
  const uy = dy / length
  return {
    x1: x1 + ux * EDGE_RADIUS,
    y1: y1 + uy * EDGE_RADIUS,
    x2: x2 - ux * (NODE_RADIUS + 4),
    y2: y2 - uy * (NODE_RADIUS + 4)
  }
}

export function RelationshipGraph({ state }: { state: MemoryState }): React.JSX.Element {
  const graph = useMemory((store) => store.relations)
  const projection = useMemory((store) => store.projection)
  const loading = useMemory((store) => store.relationsLoading)
  const load = useMemory((store) => store.loadRelations)
  const [asOf, setAsOf] = useState<number | null>(null)
  const [focusId, setFocusId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (graph === null) {
      void load(state.chapterId === null ? {} : { chapterId: state.chapterId })
    }
  }, [graph, load, state.chapterId])

  useEffect(() => {
    setSelectedId(null)
    // 换章后回到该章的默认水位（滑杆不会停在别的章的位置）。
    setAsOf(null)
  }, [graph?.chapterId])

  const selected = useMemo(
    () => graph?.edges.find((edge) => edge.id === selectedId) ?? null,
    [graph, selectedId]
  )

  const commit = (nextAsOf: number | null, nextFocus: string): void => {
    setAsOf(nextAsOf)
    void load({
      ...(state.chapterId === null ? {} : { chapterId: state.chapterId }),
      ...(nextAsOf === null ? {} : { asOf: nextAsOf }),
      ...(nextFocus === '' ? {} : { focusId: nextFocus })
    })
  }

  if (graph === null) {
    return (
      <div className="memory-relations" data-testid="relations-empty">
        <div className="pane-empty">
          <h3>{loading ? '正在读取关系…' : '还没有关系数据'}</h3>
          <p>关系边由记忆固化写入；先定稿并应用一批记忆。</p>
        </div>
      </div>
    )
  }

  const currentAsOf = asOf ?? graph.asOf
  const nodes = graph.nodes

  return (
    <div className="memory-relations" data-testid="relations-graph">
      <div className="memory-relations__bar">
        <label>
          as_of
          <input
            type="range"
            min={0}
            max={Math.max(0, graph.seqHead)}
            value={currentAsOf}
            data-testid="relations-asof"
            aria-label="关系图时间轴"
            onChange={(event) => commit(Number(event.target.value), focusId)}
          />
        </label>
        <span className="mono" data-testid="relations-asof-value">
          {currentAsOf} / {graph.seqHead}
        </span>
        <label>
          聚焦
          <select
            data-testid="relations-focus"
            value={focusId}
            onChange={(event) => {
              setFocusId(event.target.value)
              commit(currentAsOf, event.target.value)
            }}
          >
            <option value="">全部角色</option>
            {(projection?.characters ?? graph.nodes.map((node) => ({ id: node.id, name: node.name }))).map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <span className="pane-header__meta">
          节点 {graph.counts.nodes} · 边 {graph.counts.edges} · 信任 {graph.counts.byAxis.trust} / 亲密{' '}
          {graph.counts.byAxis.intimacy} / 张力 {graph.counts.byAxis.tension} · 单向 {graph.counts.oneWay}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="pane-empty" data-testid="relations-no-nodes">
          <h3>没有 active 角色</h3>
          <p>关系图只画 active 角色；先在规划台注册角色。</p>
        </div>
      ) : (
        <div className="memory-relations__canvas">
          <svg
            viewBox="0 0 640 360"
            role="img"
            aria-label="角色关系图"
            data-testid="relations-svg"
            className="memory-relations__svg"
          >
            <defs>
              <marker id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="memory-relations__arrow" />
              </marker>
            </defs>
            {graph.edges.map((edge, index) => {
              const from = nodes.find((node) => node.id === edge.fromId)
              const to = nodes.find((node) => node.id === edge.toId)
              if (!from || !to) return null
              const line = arrow(from.x, from.y, to.x, to.y)
              const width = 1 + Math.min(1, Math.abs(edge.value)) * 3
              // 轻微弧线：双向边不再完全重叠，零宽/零高的直线也有可点面积（SVG bbox）。
              const midX = (line.x1 + line.x2) / 2
              const midY = (line.y1 + line.y2) / 2
              const dx = line.x2 - line.x1
              const dy = line.y2 - line.y1
              const length = Math.hypot(dx, dy) || 1
              const curveX = midX + (-dy / length) * 26
              const curveY = midY + (dx / length) * 26
              const path = `M ${line.x1} ${line.y1} Q ${curveX} ${curveY} ${line.x2} ${line.y2}`
              return (
                <g key={edge.id}>
                  <path
                    data-testid={`relations-edge-${index}`}
                    data-axis={edge.axis}
                    data-one-way={edge.bidirectional ? 'false' : 'true'}
                    className={`memory-relations__edge${selected?.id === edge.id ? ' is-active' : ''}`}
                    data-selected={selected?.id === edge.id ? 'true' : 'false'}
                    d={path}
                    fill="none"
                    strokeWidth={width}
                    strokeDasharray={edge.bidirectional ? undefined : '5 4'}
                    markerEnd={edge.bidirectional ? undefined : 'url(#rel-arrow)'}
                    onClick={() => setSelectedId(edge.id)}
                  >
                    <title>
                      {`${from.name} → ${to.name} · ${AXIS_LABEL[edge.axis]} ${edge.value.toFixed(2)}`}
                    </title>
                  </path>
                  {/* 可点区域：曲线中点的小圆（细线视觉不变，命中面积 24px）。 */}
                  <circle
                    data-testid={`relations-edge-hit-${index}`}
                    className="memory-relations__hit"
                    cx={0.25 * line.x1 + 0.5 * curveX + 0.25 * line.x2}
                    cy={0.25 * line.y1 + 0.5 * curveY + 0.25 * line.y2}
                    r={12}
                    onClick={() => setSelectedId(edge.id)}
                  />
                </g>
              )
            })}
            {nodes.map((node) => (
              <g key={node.id} data-testid={`relations-node-${node.id}`} transform={`translate(${node.x} ${node.y})`}>
                <circle r={NODE_RADIUS} className="memory-relations__node" />
                <text className="memory-relations__label" y={NODE_RADIUS + 13} textAnchor="middle">
                  {node.name}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}

      {selected ? (
        <div className="memory-relations__source" data-testid="relations-source">
          <strong>
            {nodes.find((node) => node.id === selected.fromId)?.name ?? selected.fromId} →{' '}
            {nodes.find((node) => node.id === selected.toId)?.name ?? selected.toId}
          </strong>
          <span>
            {AXIS_LABEL[selected.axis]} {selected.value.toFixed(2)} · since {selected.sinceSeq} ·{' '}
            {selected.validToSeq === null ? '有效' : `止于 ${selected.validToSeq}`}
          </span>
          <span data-testid="relations-source-label">来源：{selected.sourceLabel || '未知'}</span>
          <span className="mono">
            {selected.sourceType} · {selected.sourceId ?? '—'}
          </span>
          <span className="pane-header__meta">只读：关系只由记忆固化写入，本页不显示记忆正文。</span>
        </div>
      ) : (
        <p className="write-note" data-testid="relations-hint">
          点一条边看来源。虚线 = 单向未确认；宽度 = 强度。
        </p>
      )}
    </div>
  )
}
