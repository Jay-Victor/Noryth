import type { Repos } from '../db/repos'

/**
 * 启动扫描（PRD §9.4 / §6.6 / PHASE-05 §5.4）：
 *
 * 进程崩溃或强杀后，`job.status='running'` 的任务永远不会自己结束；
 * 对应拍停在 `generating` / `regenerating`。打开项目时把它们统一标
 * `interrupted`，让作者可以重试——不自动重放有副作用的任务。
 *
 * 已确认的拍不在此列：它们的状态不是 generating，正文也不会被这里碰。
 */
export interface RecoveryReport {
  jobs: string[]
  beats: string[]
}

export function recoverInterrupted(repos: Repos): RecoveryReport {
  const project = repos.project.get()
  if (!project) return { jobs: [], beats: [] }

  const jobs = repos.job.listByStatus(project.id, 'running')
  for (const job of jobs) repos.job.setStatus(job.id, 'interrupted', { errorCode: 'interrupted' })

  const beats = repos.beat.listByStatuses(['generating', 'regenerating'])
  for (const beat of beats) repos.beat.setStatus(beat.id, 'interrupted')

  return { jobs: jobs.map((job) => job.id), beats: beats.map((beat) => beat.id) }
}
