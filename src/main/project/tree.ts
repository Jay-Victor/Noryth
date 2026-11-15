import type { ProjectTree, ProjectTreeNode } from '../../shared/schema/project'
import { WRITE_CHAPTER_STATUS_LABELS } from '../../shared/schema/write'
import type { Repos } from '../db/repos'

/**
 * 文件树抽屉的数据源（PHASE-11 M1-16 / UI-DESIGN §2.6）。
 *
 * 与 W1 常驻树同源：项目结构（蓝图/角色/章节）+ 数据库视图（审批/记忆/世界状态）。
 * 节点只描述「点它去哪一页」，不携带正文；抽屉本身是临时选择器。
 */
export function buildProjectTree(repos: Repos, projectId: string): ProjectTree {
  const project = repos.project.get()
  if (!project || project.id !== projectId) {
    throw new Error('project row missing for tree')
  }
  const characters = repos.character.list(projectId)
  const chapters = repos.chapter.listSummaries(projectId)
  const pendingProposals = repos.memoryProposal
    .listByProject(projectId, 500)
    .filter((item) => item.decision === 'pending').length

  const group = (id: string, label: string): ProjectTreeNode => ({
    id,
    label,
    kind: 'group',
    depth: 0,
    page: null,
    chapterId: null,
    status: null
  })
  const file = (
    id: string,
    label: string,
    page: ProjectTreeNode['page'],
    status: string | null = null,
    depth = 1,
    chapterId: string | null = null
  ): ProjectTreeNode => ({ id, label, kind: 'file', depth, page, chapterId, status })

  const nodes: ProjectTreeNode[] = [
    group('g_plan', '蓝图与角色'),
    file('f_blueprint', '蓝图', 'plan', project.blueprintLockedAt ? 'G1 已锁定' : '待确认', 1),
    file('f_roster', '角色卡', 'plan', `${characters.length} 个角色`, 1),
    file('f_world', '世界规则', 'plan', null, 1),
    group('g_write', `章节 ${chapters.length}`),
    ...chapters.map((chapter) =>
      file(
        `ch_${chapter.id}`,
        `${String(chapter.ord).padStart(2, '0')} ${chapter.title}`,
        'write',
        `${WRITE_CHAPTER_STATUS_LABELS[chapter.status] ?? chapter.status} · ${chapter.wordCount} 字`,
        1,
        chapter.id
      )
    ),
    group('g_review', '审批'),
    file('f_review', '审批报告', 'review', null, 1),
    group('g_memory', '记忆与世界观'),
    file('f_proposals', '固化提案', 'memory', pendingProposals > 0 ? `${pendingProposals} 待决` : null, 1),
    file('f_memory_entries', '角色记忆', 'memory', null, 1),
    file('f_world_state', '世界状态', 'memory', null, 1),
    file('f_audit', '审计', 'memory', null, 1)
  ]

  return { projectId, projectTitle: project.title, nodes }
}
