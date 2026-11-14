import type { Db } from '../db/project-db'
import { OutboxPublisher, type PublishReport } from '../db/outbox'
import { renderChapterMarkdown } from './mirror'

/**
 * 打开项目后补发未完成的 Markdown 镜像（DEV-PLAN §5.8 / PRD §4.7）。
 *
 * 崩溃可能留下 `outbox.published_at IS NULL` 的行；启动时按退避窗口重试。
 * 发布失败只返回报告，不阻塞打开——DB 是权威，镜像可以稍后追。
 */
export function publishPendingMirrors(db: Db, projectDir: string): PublishReport {
  return new OutboxPublisher({
    db,
    projectDir,
    render: (row) => {
      if (!row.chapterId || !row.revisionId) {
        throw new Error(`outbox ${row.id} missing chapter/revision`)
      }
      return renderChapterMarkdown(db, { chapterId: row.chapterId, revisionId: row.revisionId })
    }
  }).publishPending()
}
