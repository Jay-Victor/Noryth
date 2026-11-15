import { create } from 'zustand'
import type { ProjectTreeNode } from '../../shared/schema/project'
import { getBridge } from '../lib/bridge'
import { useApp } from './app'
import { useWrite } from './write'

/**
 * 文件树抽屉状态（PHASE-11 M1-16）。
 *
 * 抽屉是临时选择器：打开时拉一次树，选中文件即关闭。
 * 树数据来自 main（`project.tree`），不在 renderer 拼项目结构，
 * 也绝不缓存正文——节点只有「去哪一页」的信息。
 */
interface TreeState {
  open: boolean
  loading: boolean
  nodes: ProjectTreeNode[]
  projectId: string | null
  activeIndex: number
  error: string | null
  openDrawer(): Promise<void>
  toggle(): Promise<void>
  close(): void
  load(): Promise<void>
  setActive(index: number): void
  select(index: number): void
  reset(): void
}

export const useTree = create<TreeState>((set, get) => ({
  open: false,
  loading: false,
  nodes: [],
  projectId: null,
  activeIndex: -1,
  error: null,

  async openDrawer() {
    const projectId = useApp.getState().current?.project.id ?? null
    if (!projectId) return
    set({ open: true, activeIndex: get().nodes.length > 0 ? Math.max(0, get().activeIndex) : -1 })
    if (get().projectId !== projectId || get().nodes.length === 0) await get().load()
  },

  async toggle() {
    if (get().open) get().close()
    else await get().openDrawer()
  },

  close() {
    set({ open: false })
  },

  async load() {
    const bridge = getBridge()
    const projectId = useApp.getState().current?.project.id ?? null
    if (!bridge || !projectId) return
    set({ loading: true, error: null })
    const result = await bridge.project.tree()
    if (!result.ok) {
      set({ loading: false, error: result.error.message })
      useApp.getState().toast({ tone: 'error', title: result.error.message, detail: result.error.code })
      return
    }
    set({
      loading: false,
      nodes: result.data.nodes,
      projectId: result.data.projectId,
      activeIndex: result.data.nodes.length > 0 ? 0 : -1
    })
  },

  setActive(index) {
    set({ activeIndex: index })
  },

  select(index) {
    const node = get().nodes[index]
    if (!node) return
    if (node.kind === 'group' || !node.page) {
      set({ activeIndex: index })
      return
    }
    const app = useApp.getState()
    app.setPage(node.page)
    if (node.page === 'write' && node.chapterId) {
      void useWrite.getState().setChapter(node.chapterId)
    }
    // 抽屉是选择器：选中即关（UI-DESIGN §2.6）。
    set({ open: false, activeIndex: index })
  },

  reset() {
    set({ open: false, loading: false, nodes: [], projectId: null, activeIndex: -1, error: null })
  }
}))
