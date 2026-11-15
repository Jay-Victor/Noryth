import { Icon } from '../components/Icon'
import { useTree } from '../stores/tree'

/**
 * W2/W3 的 44px 轨道首项：点开文件树抽屉（PHASE-11 M1-16）。
 *
 * 用它而不是给每个页面各写一份，是为了四个工作台共享同一入口与同一 title。
 * 200% 缩放下按钮 28×28 + title/aria-label，文字不截断（不使用文字节点）。
 */
export function TreeRailTrigger(): React.JSX.Element {
  const open = useTree((state) => state.open)
  return (
    <button
      type="button"
      className={`rail-item${open ? ' is-active' : ''}`}
      title="文件树（Ctrl B）"
      aria-label="打开文件树"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="tree-open"
      onClick={() => void useTree.getState().toggle()}
    >
      <Icon name="tree" size={13} />
    </button>
  )
}
