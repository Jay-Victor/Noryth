import type { PlanOutlineNode } from '../../../shared/schema/plan'

/**
 * 蓝图结构树：只做选择与新增入口；拖拽排序后置（PHASE-06 §7）。
 * 树里不提供文件写操作（UI-DESIGN §4.5）。
 */

const KIND_LABEL: Record<PlanOutlineNode['kind'], string> = {
  main: '主线',
  volume: '卷',
  chapter: '章'
}

const STATUS_LABEL: Record<PlanOutlineNode['status'], string> = {
  draft: '草案',
  approved: '已确认',
  locked: '锁定'
}

export interface OutlineTreeProps {
  nodes: PlanOutlineNode[]
  selectedId: string | null
  locked: boolean
  onSelect(id: string): void
  onAdd(parentId: string | null, kind: PlanOutlineNode['kind']): void
}

export function OutlineTree({ nodes, selectedId, locked, onSelect, onAdd }: OutlineTreeProps): React.JSX.Element {
  const childrenOf = (parentId: string | null): PlanOutlineNode[] =>
    nodes.filter((node) => node.parentId === parentId).sort((left, right) => left.ord - right.ord)

  const renderNode = (node: PlanOutlineNode, depth: number): React.JSX.Element => {
    const children = childrenOf(node.id)
    return (
      <div key={node.id} className="plan-tree-node">
        <button
          type="button"
          className={`plan-tree-row${node.id === selectedId ? ' is-active' : ''}`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => onSelect(node.id)}
          data-testid={`outline-node-${node.id}`}
          title={`${KIND_LABEL[node.kind]} · ${node.title}`}
        >
          <span className={`plan-tree-kind is-${node.kind}`}>{KIND_LABEL[node.kind]}</span>
          <span className="plan-tree-title">{node.title}</span>
          <span className={`plan-tree-status is-${node.status}`}>{STATUS_LABEL[node.status]}</span>
        </button>
        {!locked && node.kind !== 'chapter' ? (
          <button
            type="button"
            className="plan-tree-add"
            style={{ marginLeft: `${8 + depth * 12 + 12}px` }}
            onClick={() => onAdd(node.id, node.kind === 'main' ? 'volume' : 'chapter')}
            data-testid={`outline-add-child-${node.id}`}
            title={node.kind === 'main' ? '新增卷' : '新增章'}
          >
            ＋{node.kind === 'main' ? '卷' : '章'}
          </button>
        ) : null}
        {children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="plan-outline-tree" data-testid="outline-tree">
      <div className="plan-tree-head">
        <span>结构</span>
        {!locked ? (
          <button
            type="button"
            className="plan-mini-btn"
            data-testid="outline-add-main"
            onClick={() => onAdd(null, 'main')}
          >
            ＋主线
          </button>
        ) : (
          <span className="plan-lock-note">已锁定</span>
        )}
      </div>
      {nodes.length === 0 ? (
        <p className="plan-tree-empty">还没有大纲。左侧对话后点「应用建议」，或手动新增主线。</p>
      ) : (
        childrenOf(null).map((node) => renderNode(node, 0))
      )}
    </div>
  )
}
