import { GRID, type LayoutMode } from '../../shared/layout/grid'
import { Icon } from '../components/Icon'
import type { Page } from '../stores/app'

type Workbench = Exclude<Page, 'home' | 'settings' | 'slice'>

interface WorkbenchCopy {
  title: string
  sessions: string[]
  agentLine: string
  proseTitle: string
  prose: string[]
  tree: string[]
}

const COPY: Record<Workbench, WorkbenchCopy> = {
  plan: {
    title: '规划台',
    sessions: ['第一章 · 蓝图讨论', '角色卡 · 沈昼', '关系线 · 祠堂'],
    agentLine: '这里放规划 Agent 的对话：先给蓝图草案，再逐项确认角色与初始事实。',
    proseTitle: '蓝图草案',
    prose: [
      '第一卷 · 黑漆匣子。主线：一封遗书牵出账本，账本牵出祠堂。',
      '本章目标：沈昼在祠堂夜谈中第一次听见「黑漆匣子」这个词，但不知道它在哪里。',
      '禁揭：账本的真实持有者；沈父的死因；匣子的第三把钥匙。'
    ],
    tree: ['vol_01 第一卷', 'ch_001 祠堂夜谈', 'ch_002 遗书', 'char_沈昼', 'char_沈砚']
  },
  write: {
    title: '创作台',
    sessions: ['第一章 · 第 1 场', '第一章 · 第 2 场', '本章会话'],
    agentLine: '这里放编排 Agent 的对话：发牌、收束判定与暂停原因都会出现在这条流里。',
    proseTitle: '正文预览',
    prose: [
      '她把茶盏往他那边推了推，指尖在碗沿上停了一瞬。',
      '「你在我爹书房里，见过一只黑漆匣子吗？」',
      '他没有立刻回答。窗外的雨落在瓦上，像有人在数拍子。'
    ],
    tree: ['ch_001 祠堂夜谈', 'sc_001 夜谈', 'bt_001 沈昼', 'bt_002 旁白', '分镜.md']
  },
  review: {
    title: '审批台',
    sessions: ['第一章 · 第 1 轮', '第一章 · 第 2 轮', '待审章节'],
    agentLine: '这里放审批 Agent 的对话：只报问题与 patch 提案，不改定稿。',
    proseTitle: '审批报告',
    prose: [
      '结论：fail（2 个阻断，3 条建议）。',
      '阻断 1：bt_012 让沈昼说出了他不知道的账本位置（knowledge_leak）。',
      '阻断 2：bt_017 的发言人与分镜在场者不一致（unauthorized_speech）。'
    ],
    tree: ['报告 R1', 'patch #1', 'patch #2', '版本列表', 'diff']
  },
  memory: {
    title: '记忆台',
    sessions: ['第一章 · 固化任务', '历史任务', '维护'],
    agentLine: '这里放记忆管理 Agent 的对话：提案来自定稿，应用需要 G7。',
    proseTitle: '固化提案',
    prose: [
      '体验：沈昼第一次听见「黑漆匣子」，说话的人是沈砚。',
      '信念：沈砚知道匣子的位置（来源：bt_014，属于声称，不是客观事实）。',
      '关系：沈昼 → 沈砚，信任 −0.2，since_seq 空（等待应用）。'
    ],
    tree: ['提案 14 条', '角色记忆', '世界状态', '关系边', '审计']
  }
}

export function WorkbenchPage({ page, mode }: { page: Workbench; mode: LayoutMode }): React.JSX.Element {
  const copy = COPY[page]
  const treeMode = GRID[mode].treeMode
  const compactSessions = mode === 'W3'

  return (
    <>
      <section className="pane pane--sessions" data-testid="pane-sessions" aria-label="会话列表">
        <div className="pane-header">
          <span>会话</span>
          <span className="pane-header__meta">{copy.sessions.length}</span>
        </div>
        <div className="pane-body">
          {compactSessions ? (
            <div className="rail">
              {copy.sessions.map((session, index) => (
                <span key={session} className={`rail-item${index === 0 ? ' is-active' : ''}`} title={session}>
                  {String(index + 1).padStart(2, '0')}
                </span>
              ))}
            </div>
          ) : (
            copy.sessions.map((session, index) => (
              <div key={session} className={`session-row${index === 0 ? ' is-active' : ''}`}>
                <span className="session-row__dot" />
                <span>{session}</span>
                <span className="session-row__meta">{index === 0 ? '当前' : ''}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="pane pane--chat" data-testid="pane-chat" aria-label="对话">
        <div className="pane-header">
          <span>对话</span>
          <span className="pane-header__meta">阶段 06–09 实现</span>
        </div>
        <div className="pane-body">
          <div className="chat-stream">
            <div className="chat-bubble is-agent">
              {copy.agentLine}
              <div className="chat-bubble__meta">仅讨论 · 不写正文</div>
            </div>
            <div className="notice">
              <strong>本页尚未接入 Agent。</strong> 阶段 01 只交付外壳、栅格与项目生命周期；对话、流式与工具调用在阶段
              04–09 逐段落位。
            </div>
          </div>
        </div>
      </section>

      <section className="pane pane--preview" data-testid="pane-preview" aria-label="文件预览">
        <div className="pane-header">
          <span>{copy.proseTitle}</span>
          <span className="pane-header__meta">{copy.title} · 只读占位</span>
        </div>
        <div className="pane-body">
          <article className="prose-stage">
            <h3>{copy.proseTitle}</h3>
            {copy.prose.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </article>
        </div>
      </section>

      <section className="pane pane--tree" data-testid="pane-tree" aria-label="文件树">
        {treeMode === 'pane' ? (
          <>
            <div className="pane-header">
              <span>文件树</span>
              <span className="pane-header__meta">Ctrl B</span>
            </div>
            <div className="pane-body">
              {copy.tree.map((item, index) => (
                <div key={item} className={`session-row${index === 0 ? ' is-active' : ''}`}>
                  <span className="session-row__dot" />
                  <span className="mono">{item}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="rail">
            <span className="rail-item is-active" title="项目结构">
              <Icon name="plan" size={13} />
            </span>
            <span className="rail-item" title="章节">
              <Icon name="write" size={13} />
            </span>
            <span className="rail-item" title="记忆">
              <Icon name="memory" size={13} />
            </span>
            <span className="rail-item" title="数据库视图">
              <Icon name="review" size={13} />
            </span>
          </div>
        )}
      </section>
    </>
  )
}
