import { useState } from 'react'
import {
  VOICE_KEYS,
  VOICE_LABELS,
  missingVoiceFields,
  type CharacterCard,
  type PlanCharacterView
} from '../../../shared/schema/plan'
import { useApp } from '../../stores/app'
import { FieldEditor } from './FieldEditor'

/**
 * 角色卡编辑器（PHASE-06 E3）。
 *
 * 必填：身份、voice 四项、欲望、恐惧、禁忌；其余字段可后补。
 * G1 后只读：改卡走 T32 提案，不在规划台静默改已注册角色。
 */

export interface CharacterCardFormProps {
  character: PlanCharacterView
  locked: boolean
  onSave: (card: CharacterCard) => Promise<string[] | null>
  onRemove?: () => void
}

export function CharacterCardForm({ character, locked, onSave, onRemove }: CharacterCardFormProps): React.JSX.Element {
  const toast = useApp((state) => state.toast)
  const [card, setCard] = useState(character.card)
  const [affected, setAffected] = useState<string[]>([])

  const update = async (patch: Partial<CharacterCard>): Promise<void> => {
    const next: CharacterCard = { ...card, ...patch }
    setCard(next)
    const chapters = await onSave(next)
    if (chapters && chapters.length > 0) {
      setAffected(chapters)
      toast({
        tone: 'info',
        title: `角色卡 v${character.cardVersion + 1} 已保存`,
        detail: `影响 ${chapters.length} 个章节：${chapters.join('、')}`,
        key: `plan-card-${character.id}`
      })
    }
  }

  const updateVoice = async (key: (typeof VOICE_KEYS)[number], value: string): Promise<void> => {
    await update({ voice: { ...card.voice, [key]: value } })
  }

  const missing = missingVoiceFields(card)

  return (
    <section className="plan-card-form" data-testid="character-card-form" data-character-id={character.id}>
      <header className="plan-card-head">
        <div>
          <h3>{character.name}</h3>
          <p className="plan-card-meta">
            card v{character.cardVersion} · {character.status === 'registered' ? '已注册' : '草案'} · ID{' '}
            <span className="mono">{character.id}</span>
          </p>
        </div>
        {!locked && onRemove ? (
          <button type="button" className="plan-mini-btn is-danger" onClick={onRemove} data-testid="character-remove">
            删除
          </button>
        ) : null}
      </header>

      {locked ? (
        <p className="plan-notice" data-testid="character-locked">
          蓝图已锁定或项目只读，角色卡只读。改卡必须走提案（T32），并在应用前列出受影响章节。
        </p>
      ) : missing.length > 0 ? (
        <p className="plan-warn" data-testid="voice-missing">
          voice 缺 {missing.length} 项：{missing.map((key) => VOICE_LABELS[key]).join('、')}；缺项会阻断 G1。
        </p>
      ) : null}

      <FieldEditor
        label="身份"
        required
        value={card.identity}
        disabled={locked}
        testId="card-identity"
        onSave={(value) => update({ identity: value })}
      />
      <FieldEditor
        label="外貌"
        value={card.appearance}
        disabled={locked}
        testId="card-appearance"
        onSave={(value) => update({ appearance: value })}
      />

      <div className="plan-subhead">voice · 声音区分度（四项必填）</div>
      {VOICE_KEYS.map((key) => (
        <FieldEditor
          key={key}
          label={VOICE_LABELS[key]}
          required
          value={card.voice[key]}
          disabled={locked}
          testId={`card-voice-${key}`}
          onSave={(value) => updateVoice(key, value)}
        />
      ))}

      <div className="plan-subhead">动机与边界</div>
      <FieldEditor label="欲望" required value={card.want} disabled={locked} testId="card-want" onSave={(value) => update({ want: value })} />
      <FieldEditor label="恐惧" required value={card.fear} disabled={locked} testId="card-fear" onSave={(value) => update({ fear: value })} />
      <FieldEditor label="禁忌" required value={card.taboo} disabled={locked} testId="card-taboo" onSave={(value) => update({ taboo: value })} />

      <div className="plan-subhead">初始关系与已知</div>
      <FieldEditor
        label="初始关系"
        multiline
        rows={2}
        value={card.initial_relationships}
        disabled={locked}
        testId="card-relationships"
        onSave={(value) => update({ initial_relationships: value })}
      />
      <FieldEditor
        label="初始已知"
        multiline
        rows={2}
        value={card.initial_known}
        disabled={locked}
        testId="card-known"
        onSave={(value) => update({ initial_known: value })}
      />
      <FieldEditor
        label="初始未知"
        multiline
        rows={2}
        value={card.initial_unknown}
        disabled={locked}
        testId="card-unknown"
        onSave={(value) => update({ initial_unknown: value })}
      />

      {affected.length > 0 ? (
        <p className="plan-note" data-testid="character-affected">
          受影响章节：{affected.join('、')}
        </p>
      ) : null}
    </section>
  )
}
