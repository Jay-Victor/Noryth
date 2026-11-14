export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '未打开'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '未知'
  const delta = now - time
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < 2 * minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 2 * day) return '昨天'
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`
  return new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 保留盘符与末级目录，中间省略（UI-DESIGN §3.2）。 */
export function ellipsisPath(path: string, max = 44): string {
  if (path.length <= max) return path
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return `${path.slice(0, max - 1)}…`
  const head = parts[0] ?? ''
  const tail = parts[parts.length - 1] ?? ''
  const candidate = `${head}\\…\\${tail}`
  return candidate.length <= max ? candidate : `${candidate.slice(0, max - 1)}…`
}

export function formatWords(words: number): string {
  if (words >= 10_000) return `${(words / 10_000).toFixed(1)} 万`
  return `${words}`
}
