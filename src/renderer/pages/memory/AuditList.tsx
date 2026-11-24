import type { MemoryState } from '../../../shared/schema/memory'
import { MEMORY_DOWNGRADE_LABELS } from '../../../shared/schema/memory'

/**
 * 审计视图（UI-DESIGN §7.4 审计 / PRD §5.4）。
 *
 * 每条记忆的来源章节 / revision / 拍；标记错误与取代都留痕。
 * 工具调用审计（tool、版本、耗时、degraded、错误码）在阶段 10 的工具面板里
 * 统一展示；这里先给出记忆动作链，不显示 args 原文。
 */

const ACTION_LABELS: Record<string, string> = {
  extract: '抽取',
  apply: '应用',
  invalidate: '标记失效',
  rebuild: '重建',
  supersede: '取代',
  evidence_mismatch: '证据不符',
  archive: '软归档',
  restore: '恢复'
}

export function AuditList({ state }: { state: MemoryState }): React.JSX.Element {
  if (state.audit.length === 0) {
    return (
      <div className="memory-audit" data-testid="memory-audit-empty">
        <div className="pane-empty">
          <h3>还没有审计记录</h3>
          <p>抽取、应用、取代与标错都会写在这里；不物理删除。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-audit" data-testid="memory-audit">
      {state.audit.map((record, index) => {
        const detail = record.detail
        const downgrades = Array.isArray(detail.downgraded)
          ? detail.downgraded.filter((value): value is string => typeof value === 'string')
          : []
        return (
          <article
            key={record.id}
            className={`memory-audit__row is-${record.action}`}
            data-testid={`memory-audit-${index}`}
            data-action={record.action}
          >
            <header className="memory-audit__head">
              <span className="memory-audit__action">{ACTION_LABELS[record.action] ?? record.action}</span>
              <span className="mono">{record.entityType}</span>
              <span className="memory-audit__id mono">{record.entityId}</span>
              <span className="memory-audit__spacer" />
              <span className="pane-header__meta">{record.actor}</span>
              <span className="pane-header__meta">{record.createdAt.slice(11, 19)}</span>
            </header>
            <p className="memory-audit__detail">
              {typeof detail.text === 'string' ? detail.text : null}
              {typeof detail.reason === 'string' ? `原因：${detail.reason}` : null}
              {typeof detail.quote === 'string' ? `证据：${detail.quote}` : null}
              {typeof detail.kind === 'string' ? `类型：${detail.kind}` : null}
              {typeof detail.subject === 'string' &&
              typeof detail.predicate === 'string' &&
              typeof detail.object === 'string'
                ? `${detail.subject} ${detail.predicate} ${detail.object}`
                : null}
              {downgrades.length > 0
                ? ` · ${downgrades.map((value) => MEMORY_DOWNGRADE_LABELS[value] ?? value).join('；')}`
                : null}
            </p>
          </article>
        )
      })}
    </div>
  )
}
