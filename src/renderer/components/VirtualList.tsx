import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 固定行高虚拟列表（PHASE-11 M1-9 / DEV-PLAN §11.8）。
 *
 * 设计约束：
 * - 行高固定 32：章节/文件/会话三类列表都不需要自适应高度，固定行高才能 O(1) 定位；
 * - overscan 8：上下各预渲染 8 行，滚动时不会出现空白带；
 * - `content-visibility: auto`：浏览器跳过屏外行的布局与绘制；
 * - roving tabindex：整张列表只有一个 Tab 停靠点，方向键移动焦点；
 *   业务快捷键（J/K、Enter）由页面 store 决定，不依赖 DOM 顺序。
 *
 * 不引入第三方虚拟化库：一个组件 100 行，比多一个依赖更好维护。
 */

export interface VirtualListProps<T> {
  items: readonly T[]
  rowHeight?: number
  overscan?: number
  /** 当前活动行；-1 表示没有。 */
  activeIndex: number
  onActivate(index: number): void
  renderRow(item: T, index: number, active: boolean): ReactNode
  ariaLabel?: string
  testId?: string
  className?: string
}

export interface VirtualWindow {
  start: number
  end: number
}

/**
 * 可视窗口计算（纯函数，单测直接覆盖 1,000 行场景）。
 * `end` 是排他的；两侧各留 overscan 行，滚动时不会出现空白带。
 */
export function visibleRange(input: {
  total: number
  scrollTop: number
  rowHeight: number
  viewportHeight: number
  overscan: number
}): VirtualWindow {
  const { total, scrollTop, rowHeight, viewportHeight, overscan } = input
  if (total <= 0) return { start: 0, end: 0 }
  const visibleRows = Math.max(1, Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight))
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(total, firstVisible + visibleRows + overscan)
  return { start, end }
}

export function VirtualList<T>({
  items,
  rowHeight = 32,
  overscan = 8,
  activeIndex,
  onActivate,
  renderRow,
  ariaLabel,
  testId,
  className
}: VirtualListProps<T>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = (): void => setHeight(node.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 活动行变化时把焦点带过去（键盘/外部 store 都能驱动）。
  useEffect(() => {
    if (activeIndex < 0) return
    const node = viewportRef.current
    if (!node || !node.contains(document.activeElement)) return
    const target = node.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    target?.focus({ preventScroll: true })
    if (!target) return
    const top = activeIndex * rowHeight
    if (top < node.scrollTop) node.scrollTop = top
    else if (top + rowHeight > node.scrollTop + node.clientHeight) {
      node.scrollTop = top + rowHeight - node.clientHeight
    }
  }, [activeIndex, rowHeight])

  const total = items.length
  const { start, end } = visibleRange({
    total,
    scrollTop,
    rowHeight,
    viewportHeight: height || rowHeight * 10,
    overscan
  })
  const slice = items.slice(start, end)

  const move = (delta: number): void => {
    if (total === 0) return
    const base = activeIndex < 0 ? 0 : activeIndex
    const next = Math.min(total - 1, Math.max(0, base + delta))
    onActivate(next)
  }

  return (
    <div
      ref={viewportRef}
      className={`vlist${className ? ` ${className}` : ''}`}
      role="listbox"
      aria-label={ariaLabel}
      data-testid={testId}
      tabIndex={-1}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onActivate(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          onActivate(total - 1)
        }
      }}
    >
      <div className="vlist__spacer" style={{ height: total * rowHeight }}>
        {slice.map((item, offset) => {
          const index = start + offset
          const active = index === activeIndex
          return (
            <div
              key={index}
              className="vlist__row"
              role="option"
              aria-selected={active}
              data-index={index}
              tabIndex={active ? 0 : -1}
              style={{
                top: index * rowHeight,
                height: rowHeight,
                contentVisibility: 'auto' as const,
                containIntrinsicHeight: `${rowHeight}px`
              }}
              onClick={() => onActivate(index)}
            >
              {renderRow(item, index, active)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
