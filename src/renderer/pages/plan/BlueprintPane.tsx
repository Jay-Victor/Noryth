import { useEffect, useState } from 'react'
import type { BlueprintMetaPatch } from '../../../shared/schema/blueprint'
import type { PlanCharacterView, PlanOutlineNode, PlanSaveOutlineInput } from '../../../shared/schema/plan'
import { useApp } from '../../stores/app'
import { FieldEditor } from './FieldEditor'
import { OutlineMetaEditor } from './OutlineMetaEditor'
import { OutlineTree } from './OutlineTree'

export interface BlueprintPaneProps {
  nodes: PlanOutlineNode[]
  characters: PlanCharacterView[]
  locked: boolean
  readOnly: boolean
  /** 覆盖检查「定位」目标：选中该节点（null = 不动）。 */
  focusNodeId: string | null
  onSave: (input: PlanSaveOutlineInput) => Promise<void>
  /** G1 后：修改先落变更记录（影响分析），作者确认后才改大纲。 */
  onProposeChange: (nodeId: string, patch: { title?: string; content?: string }) => Promise<void>
  onSaveMeta: (nodeId: string, meta: BlueprintMetaPatch) => Promise<void>
  onAnalyzeMeta: (nodeId: string, meta: BlueprintMetaPatch) => Promise<unknown>
  onAdd: (parentId: string | null, kind: PlanOutlineNode['kind']) => Promise<boolean>
  onRemove: (nodeId: string) => Promise<void>
}

const KIND_LABEL: Record<PlanOutlineNode['kind'], string> = {
  main: '主线',
  volume: '卷',
  chapter: '章'
}

export function BlueprintPane({
  nodes,
  characters,
  locked,
  readOnly,
  focusNodeId,
  onSave,
  onProposeChange,
  onSaveMeta,
  onAnalyzeMeta,
  onAdd,
  onRemove
}: BlueprintPaneProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(nodes[0]?.id ?? null)
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0] ?? null
  const current = useApp((store) => store.current)

  useEffect(() => {
    if (focusNodeId !== null && nodes.some((node) => node.id === focusNodeId)) setSelectedId(focusNodeId)
  }, [focusNodeId, nodes])

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
                G1 后蓝图只读：改标题 / 内容会先生成变更记录（影响分析），确认应用后才改大纲。
              </p>
            ) : null}
            <FieldEditor
              label={locked ? '标题（提交变更）' : '标题'}
              value={selected.title}
              disabled={readOnly}
              testId="outline-title"
              onSave={(value) =>
                locked
                  ? void onProposeChange(selected.id, { title: value })
                  : onSave({ nodeId: selected.id, title: value })
              }
            />
            <FieldEditor
              label={
                locked
                  ? '内容（提交变更）'
                  : selected.kind === 'chapter'
                    ? '章纲（一句话目标 / 场景 / 禁揭）'
                    : '内容'
              }
              multiline
              rows={selected.kind === 'chapter' ? 8 : 6}
              value={selected.content}
              disabled={readOnly}
              testId="outline-content"
              onSave={(value) =>
                locked
                  ? void onProposeChange(selected.id, { content: value })
                  : onSave({ nodeId: selected.id, content: value })
              }
            />
            <p className="plan-field-foot">
              {locked ? '变更先进入变更记录；应用前大纲不变。' : '字段自动保存（800ms）。'}
              {selected.kind === 'chapter' ? '章纲不进入角色上下文。' : ''}
            </p>
            <OutlineMetaEditor
              key={selected.id}
              node={selected}
              nodes={nodes}
              characters={characters}
              locked={locked}
              readOnly={readOnly}
              onSave={onSaveMeta}
              onAnalyze={onAnalyzeMeta}
            />
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
