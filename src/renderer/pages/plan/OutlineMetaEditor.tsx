import { useEffect, useState } from 'react'
import type { BlueprintKeyEvent, BlueprintMetaPatch } from '../../../shared/schema/blueprint'
import type { PlanCharacterView, PlanOutlineNode } from '../../../shared/schema/plan'

/**
 * 结构化纲要素标注（PHASE-15 §5.1）。
 *
 * 覆盖检查只认 `outline_node.meta_json` 里的确定字段，不解析自然语言 goal，
 * 所以作者必须显式标注「关键事件 / 出场角色 / POV / 主线推进」。
 *
 * G1 前直接保存到草案；G1 后蓝图只读，保存按钮换成「提交变更（影响分析）」，
 * 走 `blueprint_change` 的同一流程——不绕过影响分析。
 */

export interface OutlineMetaEditorProps {
  node: PlanOutlineNode
  nodes: PlanOutlineNode[]
  characters: PlanCharacterView[]
  locked: boolean
  readOnly: boolean
  onSave(nodeId: string, meta: BlueprintMetaPatch): Promise<void>
  onAnalyze(nodeId: string, meta: BlueprintMetaPatch): Promise<unknown>
}

const emptyDraft = (node: PlanOutlineNode): BlueprintMetaPatch => ({
  key_events: node.meta.key_events ?? [],
  character_ids: node.meta.character_ids ?? [],
  pov_character_id: node.meta.pov_character_id ?? null,
  mainline: node.meta.mainline === true
})

export function OutlineMetaEditor({
  node,
  nodes,
  characters,
  locked,
  readOnly,
  onSave,
  onAnalyze
}: OutlineMetaEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<BlueprintMetaPatch>(emptyDraft(node))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(emptyDraft(node))
  }, [node])

  const chapterNodes = nodes.filter((candidate) => candidate.kind === 'chapter')
  const isChapter = node.kind === 'chapter'
  const isVolume = node.kind === 'volume'

  const toggleCharacter = (id: string): void => {
    const current = new Set(draft.character_ids ?? [])
    if (current.has(id)) current.delete(id)
    else current.add(id)
    setDraft({ ...draft, character_ids: [...current] })
  }

  const patchEvent = (index: number, patch: Partial<BlueprintKeyEvent>): void => {
    const events = (draft.key_events ?? []).map((event, position) =>
      position === index ? { ...event, ...patch } : event
    )
    setDraft({ ...draft, key_events: events })
  }

  const addEvent = (): void => {
    const events = draft.key_events ?? []
    const index = events.length + 1
    setDraft({
      ...draft,
      key_events: [...events, { id: `ev_${index}`, text: '' }]
    })
  }

  const removeEvent = (index: number): void => {
    setDraft({ ...draft, key_events: (draft.key_events ?? []).filter((_, position) => position !== index) })
  }

  const normalized = (): BlueprintMetaPatch => ({
    ...(isVolume ? { key_events: (draft.key_events ?? []).filter((event) => event.text.trim().length > 0) } : {}),
    ...(isVolume || isChapter ? { character_ids: draft.character_ids ?? [] } : {}),
    ...(isChapter ? { pov_character_id: draft.pov_character_id ?? null } : {}),
    ...(isChapter ? { mainline: draft.mainline === true } : {})
  })

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (locked) await onAnalyze(node.id, normalized())
      else await onSave(node.id, normalized())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="plan-meta" data-testid="outline-meta-editor" aria-label="结构化纲要素">
      <div className="plan-meta__head">
        <strong>结构化标注</strong>
        <span className="plan-node-meta">
          {locked ? 'G1 后修改走变更流程（影响分析 → 确认应用）' : '覆盖检查只读这些字段，不解析自然语言'}
        </span>
      </div>

      {isChapter ? (
        <div className="plan-meta__row">
          <label className="plan-meta__label" htmlFor="meta-mainline">
            <input
              id="meta-mainline"
              type="checkbox"
              data-testid="meta-mainline"
              checked={draft.mainline === true}
              disabled={readOnly}
              onChange={(event) => setDraft({ ...draft, mainline: event.target.checked })}
            />
            主线推进章
          </label>
          <label className="plan-meta__label" htmlFor="meta-pov">
            POV
            <select
              id="meta-pov"
              data-testid="meta-pov"
              value={draft.pov_character_id ?? ''}
              disabled={readOnly}
              onChange={(event) =>
                setDraft({ ...draft, pov_character_id: event.target.value.length === 0 ? null : event.target.value })
              }
            >
              <option value="">（未标注）</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {isVolume || isChapter ? (
        <div className="plan-meta__row plan-meta__chars" data-testid="meta-characters">
          <span className="plan-meta__label">出场角色</span>
          {characters.length === 0 ? (
            <span className="plan-note">还没有角色卡</span>
          ) : (
            characters.map((character) => {
              const active = (draft.character_ids ?? []).includes(character.id)
              return (
                <button
                  key={character.id}
                  type="button"
                  className={`plan-chip${active ? ' is-active' : ''}`}
                  data-testid={`meta-character-${character.id}`}
                  aria-pressed={active}
                  disabled={readOnly}
                  onClick={() => toggleCharacter(character.id)}
                >
                  {character.name}
                </button>
              )
            })
          )}
        </div>
      ) : null}

      {isVolume ? (
        <div className="plan-meta__events" data-testid="meta-key-events">
          <div className="plan-meta__label">关键事件（每项需要一个章落点）</div>
          {(draft.key_events ?? []).map((event, index) => (
            <div key={`${event.id}-${index}`} className="plan-meta__event">
              <input
                className="plan-meta__text"
                data-testid={`meta-event-text-${index}`}
                value={event.text}
                placeholder="例如：匣子在祠堂被打开"
                disabled={readOnly}
                onChange={(changeEvent) => patchEvent(index, { text: changeEvent.target.value })}
              />
              <select
                data-testid={`meta-event-chapter-${index}`}
                value={event.chapter_node_id ?? ''}
                disabled={readOnly}
                onChange={(changeEvent) =>
                  patchEvent(index, { chapter_node_id: changeEvent.target.value.length === 0 ? undefined : changeEvent.target.value })
                }
              >
                <option value="">（无落点）</option>
                {chapterNodes.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="plan-mini-btn is-danger"
                data-testid={`meta-event-remove-${index}`}
                disabled={readOnly}
                onClick={() => removeEvent(index)}
              >
                删除
              </button>
            </div>
          ))}
          <button type="button" className="plan-mini-btn" data-testid="meta-event-add" disabled={readOnly} onClick={addEvent}>
            ＋关键事件
          </button>
        </div>
      ) : null}

      <div className="plan-meta__actions">
        <button
          type="button"
          className="plan-btn"
          data-testid="meta-save"
          disabled={readOnly || busy}
          onClick={() => void submit()}
        >
          {busy ? '保存中…' : locked ? '提交变更（影响分析）' : '保存标注'}
        </button>
      </div>
    </section>
  )
}
