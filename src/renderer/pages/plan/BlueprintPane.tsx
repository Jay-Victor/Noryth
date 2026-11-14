import { useState } from 'react'
import type { PlanOutlineNode, PlanSaveOutlineInput } from '../../../shared/schema/plan'
import { useApp } from '../../stores/app'
import { FieldEditor } from './FieldEditor'
import { OutlineTree } from './OutlineTree'

export interface BlueprintPaneProps {
  nodes: PlanOutlineNode[]
  locked: boolean
  onSave: (input: PlanSaveOutlineInput) => Promise<void>
  onAdd: (parentId: string | null, kind: PlanOutlineNode['kind']) => Promise<boolean>
  onRemove: (nodeId: string) => Promise<void>
}

const KIND_LABEL: Record<PlanOutlineNode['kind'], string> = {
  main: '主线',
  volume: '卷',
  chapter: '章'
}

export function BlueprintPane({ nodes, locked, onSave, onAdd, onRemove }: BlueprintPaneProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(nodes[0]?.id ?? null)
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0] ?? null
  const current = useApp((store) => store.current)

  const add = async (parentId: string | null, kind: PlanOutlineNode['kind']): Promise<void> => {
    const created = await onAdd(parentId, kind)
    if (created) setSelectedId(null)
  }

  return (
    <div className="plan-blueprint" data-testid="blueprint-pane">
      <aside className="plan-blueprint__tree">
        <OutlineTree
          nodes={nodes}
          selectedId={selected?.id ?? null}
          locked={locked}
          onSelect={setSelectedId}
          onAdd={(parentId, kind) => void add(parentId, kind)}
        />
      </aside>
      <div className="plan-blueprint__fields">
        {selected ? (
          <>
            <header className="plan-node-head">
              <span className={`plan-kind-badge is-${selected.kind}`}>{KIND_LABEL[selected.kind]}</span>
              <span className="plan-node-meta">
                v{selected.version} · {selected.status === 'locked' ? '已锁定' : '草案'}
              </span>
              {!locked ? (
                <button
                  type="button"
                  className="plan-mini-btn is-danger"
                  data-testid="outline-remove"
                  onClick={() => {
                    void onRemove(selected.id)
                    setSelectedId(null)
                  }}
                >
                  删除节点
                </button>
              ) : null}
            </header>
            {locked ? (
              <p className="plan-notice" data-testid="blueprint-locked">
                G1 后蓝图只读；修改必须走变更流程（影响分析在 P1）。
              </p>
            ) : null}
            <FieldEditor
              label="标题"
              value={selected.title}
              disabled={locked}
              testId="outline-title"
              onSave={(value) => onSave({ nodeId: selected.id, title: value })}
            />
            <FieldEditor
              label={selected.kind === 'chapter' ? '章纲（一句话目标 / 场景 / 禁揭）' : '内容'}
              multiline
              rows={selected.kind === 'chapter' ? 8 : 6}
              value={selected.content}
              disabled={locked}
              testId="outline-content"
              onSave={(value) => onSave({ nodeId: selected.id, content: value })}
            />
            <p className="plan-field-foot">
              字段自动保存（800ms）；G1 后只读。{selected.kind === 'chapter' ? '章纲不进入角色上下文。' : ''}
            </p>
          </>
        ) : (
          <div className="plan-empty-skeleton" data-testid="blueprint-empty">
            <h3>空蓝图</h3>
            <dl>
              <dt>题材</dt>
              <dd>{current?.project.genre || '（未填）'}</dd>
              <dt>目标篇幅</dt>
              <dd>{current?.project.targetWords ? `${current.project.targetWords.toLocaleString('zh-CN')} 字` : '（未定）'}</dd>
              <dt>视角</dt>
              <dd>{current?.project.pov === 'first' ? '第一人称' : current?.project.pov === 'third_omniscient' ? '第三人称全知' : '第三人称限知'}</dd>
            </dl>
            <p>在左侧对话里说一句想法；规划 Agent 会给出可审的蓝图草案，点「应用建议」后才会写进这里。</p>
            {!locked ? (
              <button type="button" className="plan-btn is-primary" data-testid="blueprint-add-main" onClick={() => void add(null, 'main')}>
                手动新增主线
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
