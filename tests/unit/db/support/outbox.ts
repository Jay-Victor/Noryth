import type { Db } from '../../../../src/main/db/project-db'
import { OutboxPublisher, type PublishReport } from '../../../../src/main/db/outbox'
import { renderChapterMarkdown } from '../../../../src/main/doc/mirror'
import type { OutboxRecord } from '../../../../src/main/db/repos/outbox'

/** 与阶段 07 的调用方式一致：渲染器由 doc 层提供。 */
export function publishOutbox(db: Db, projectDir: string, options: { maxAttempts?: number } = {}): PublishReport {
  return new OutboxPublisher({
    db,
    projectDir,
    maxAttempts: options.maxAttempts,
    render: (row: OutboxRecord) =>
      renderChapterMarkdown(db, { chapterId: row.chapterId!, revisionId: row.revisionId! })
  }).publishPending()
}
