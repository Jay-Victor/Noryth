import { useEffect, useRef, useState } from 'react'
import type { PlanChoiceRequest, PlanMessageView, PlanProposalView, PlanState } from '../../../shared/schema/plan'
import { useApp } from '../../stores/app'

/**
 * 规划对话（PHASE-06 E1 / UI-DESIGN §4.3）。
 *
 * 对话只产生建议；消息底部的「仅讨论 / 用于草案」是承诺边界。
 * 停止保留已生成文本；重试复用同一条回复；提案应用必须由作者点击。
 */

export interface ChatPaneProps {
  state: PlanState
  streaming: Record<string, string>
  busy: boolean
  choice: PlanChoiceRequest | null
  onSend: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onRetry: (messageId: string) => Promise<void>
  onApply: (proposalId: string) => Promise<unknown>
  onReject: (proposalId: string) => Promise<void>
  onChoose: (choiceId: string, optionId: string) => Promise<void>
  onCreateSession: () => Promise<string | null>
}

function proposalLine(proposal: PlanProposalView): string {
  if (proposal.kind === 'blueprint_patch') {
    return `蓝图补丁 · 新增 ${proposal.summary.added ?? 0} / 修改 ${proposal.summary.updated ?? 0} / 删除 ${proposal.summary.removed ?? 0}`
  }
  if (proposal.kind === 'roster') {
    return `注册清单 · ${proposal.summary.characters ?? 0} 个角色 / ${proposal.summary.facts ?? 0} 条世界初值`
  }
  return `${proposal.summary.character_name ?? '角色卡'} 改版${proposal.summary.affected_chapters?.length ? ` · 影响 ${proposal.summary.affected_chapters.length} 章` : ''}`
}

function ProposalCard({
  proposal,
  readOnly,
  onApply,
  onReject
}: {
  proposal: PlanProposalView
  readOnly: boolean
  onApply: (proposalId: string) => Promise<unknown>
  onReject: (proposalId: string) => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="plan-proposal" data-testid={`plan-proposal-${proposal.id}`} data-kind={proposal.kind}>
      <div className="plan-proposal__body">
        <span className="plan-proposal__title">建议 · {proposalLine(proposal)}</span>
        <span className="plan-proposal__note">应用后草案版本 +1；不应用不会改任何文件。</span>
      </div>
      <div className="plan-proposal__actions">
        <button
          type="button"
          className="plan-btn is-primary"
          data-testid={`plan-apply-${proposal.id}`}
          disabled={busy || readOnly}
          onClick={() => {
            setBusy(true)
            void onApply(proposal.id).finally(() => setBusy(false))
          }}
        >
          {busy ? '应用中…' : '应用建议'}
        </button>
        <button
          type="button"
          className="plan-btn"
          data-testid={`plan-reject-${proposal.id}`}
          disabled={busy || readOnly}
          onClick={() => {
            setBusy(true)
            void onReject(proposal.id).finally(() => setBusy(false))
          }}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

function Message({
  message,
  body,
  proposals,
  readOnly,
  onRetry,
  onApply,
  onReject
}: {
  message: PlanMessageView
  body: string
  proposals: PlanProposalView[]
  readOnly: boolean
  onRetry: (messageId: string) => Promise<void>
  onApply: (proposalId: string) => Promise<unknown>
  onReject: (proposalId: string) => Promise<void>
}): React.JSX.Element {
  if (message.role === 'system') {
    const tone = message.kind === 'g1' ? 'is-g1' : message.kind === 'coverage' ? 'is-coverage' : ''
    return (
      <div className={`plan-system-card ${tone}`} data-testid="plan-message-system" data-kind={message.kind}>
        <span className="plan-system-card__tag">
          {message.kind === 'g1' ? 'G1' : message.kind === 'coverage' ? '覆盖检查' : '系统'}
        </span>
        <span>{body}</span>
      </div>
    )
  }

  const isAuthor = message.role === 'author'
  const streaming = message.status === 'streaming'
  const label = message.meta.label === 'draft' ? '用于草案' : '仅讨论'
  const draftProposals = proposals.filter(
    (proposal) => proposal.status === 'draft' && (message.meta.proposal_ids ?? []).includes(proposal.id)
  )

  return (
    <div
      className={`plan-msg ${isAuthor ? 'is-author' : 'is-agent'}`}
      data-testid={isAuthor ? 'plan-message-author' : 'plan-message-planner'}
      data-status={message.status}
    >
      <div className="plan-msg__bubble">
        <span className="plan-msg__who">{isAuthor ? '你' : '规划 Agent'}</span>
        <p className="plan-msg__body" data-testid={streaming ? 'plan-streaming' : undefined}>
          {body.length > 0 ? body : streaming ? '…' : '（空）'}
        </p>
        {!isAuthor ? (
          <span className="plan-msg__meta">
            {label}
            {message.status === 'stopped' ? ' · 已停止（已保留生成文本）' : ''}
            {message.status === 'failed'
              ? ` · 失败${message.meta.error_code ? `（${message.meta.error_code}）` : ''}`
              : ''}
            {message.attempt > 1 ? ` · 第 ${message.attempt} 次` : ''}
          </span>
        ) : null}
      </div>

      {draftProposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} readOnly={readOnly} onApply={onApply} onReject={onReject} />
      ))}

      {!isAuthor && (message.status === 'stopped' || message.status === 'failed') ? (
        <button
          type="button"
          className="plan-mini-btn"
          data-testid="plan-retry"
          disabled={readOnly}
          onClick={() => void onRetry(message.id)}
        >
          重试这条
        </button>
      ) : null}
    </div>
  )
}

export function ChatPane({
  state,
  streaming,
  busy,
  choice,
  onSend,
  onStop,
  onRetry,
  onApply,
  onReject,
  onChoose,
  onCreateSession
}: ChatPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement | null>(null)
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) ?? null
  const setPage = useApp((store) => store.setPage)

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [state.messages.length, streaming, state.activeSessionId, choice])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || busy) return
    setDraft('')
    await onSend(text)
  }

  return (
    <section className="pane pane--chat" data-testid="pane-chat" aria-label="对话">
      <div className="pane-header">
        <span>对话 · {activeSession?.title ?? '规划'}</span>
        <button
          type="button"
          className={`plan-model-badge${state.model.ready ? '' : ' is-offline'}`}
          data-testid="plan-model"
          title={state.model.ready ? `${state.model.label} · 点击打开设置` : '未配置 API Key：阶段 10 在设置页接入'}
          onClick={() => setPage('settings')}
        >
          {state.model.label}
        </button>
      </div>

      <div className="pane-body plan-chat-body" ref={scroller} data-testid="plan-chat">
        {!activeSession ? (
          <div className="pane-empty">
            <h3>还没有规划会话</h3>
            <p>对话只改草案，不直接写文件。先开一个会话，把一句想法说清楚。</p>
            <button
              type="button"
              className="plan-btn is-primary"
              data-testid="plan-new-session-empty"
              onClick={() => void onCreateSession()}
            >
              新建规划会话
            </button>
          </div>
        ) : state.messages.length === 0 ? (
          <div className="plan-chat-intro">
            <p>先给一句想法：题材、人物、最想写的那场戏，都可以。</p>
            <p className="plan-note">
              对话里提出的结构会变成「建议」；你点「应用建议」后草案才会变。蓝图通过 G1 之前不注册角色、不建库。
            </p>
          </div>
        ) : (
          <div className="plan-msg-list">
            {state.messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                body={streaming[message.id] ?? message.body}
                proposals={state.proposals}
                readOnly={state.readOnly}
                onRetry={onRetry}
                onApply={onApply}
                onReject={onReject}
              />
            ))}
          </div>
        )}
      </div>

      {choice ? (
        <div className="plan-choice" data-testid="plan-choice">
          <p className="plan-choice__question">{choice.question}</p>
          <div className="plan-choice__options">
            {choice.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="plan-btn is-primary"
                data-testid={`plan-choice-${option.id}`}
                disabled={state.readOnly}
                onClick={() => void onChoose(choice.choiceId, option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="plan-composer" data-testid="plan-composer">
        <textarea
          className="plan-composer__input"
          data-testid="plan-composer-input"
          value={draft}
          rows={3}
          placeholder={activeSession ? '说清楚你要写什么；Ctrl+Enter 发送' : '先新建会话'}
          disabled={!activeSession || state.readOnly}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="plan-composer__actions">
          <span className="plan-composer__hint">仅讨论 · 不写文件</span>
          {busy ? (
            <button type="button" className="plan-btn" data-testid="plan-stop" onClick={() => void onStop()}>
              停止
            </button>
          ) : null}
          <button
            type="button"
            className="plan-btn is-primary"
            data-testid="plan-send"
            disabled={!activeSession || state.readOnly || busy || draft.trim().length === 0}
            onClick={() => void send()}
          >
            发送
          </button>
        </div>
      </div>
    </section>
  )
}
