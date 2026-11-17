import { z } from 'zod'

/**
 * 更新通道与状态（PHASE-18 M1-7）。
 *
 * 单一真源：主进程的 `update.ts` 只做检查/下载，类型与文案在这里，
 * AppInfo 与设置页共用同一份形状。
 */

export const UPDATE_CHANNELS = ['dev', 'beta', 'stable'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export const UPDATE_STATUSES = [
  'idle',
  'checking',
  'disabled',
  'up_to_date',
  'available',
  'downgrade',
  'downgrade_blocked',
  'prerelease_skipped',
  'failed'
] as const
export type UpdateStatus = (typeof UPDATE_STATUSES)[number]

export const UPDATE_STATUS_LABELS: Record<UpdateStatus, string> = {
  idle: '未检查',
  checking: '检查中…',
  disabled: '未配置更新地址（开发构建或未设置 NORYTH_UPDATE_FEED）',
  up_to_date: '已是最新',
  available: '有新版本',
  downgrade: '可回退到同 minor 的旧版本',
  downgrade_blocked: '远端版本更低且跨 minor：已拒绝回退',
  prerelease_skipped: 'stable 通道忽略预发布版本',
  failed: '检查失败（不阻塞启动）'
}

export const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  dev: 'dev · 每次开发构建',
  beta: 'beta · 内测',
  stable: 'stable · 里程碑'
}

export const UpdateStateSchema = z.strictObject({
  channel: z.enum(UPDATE_CHANNELS),
  /** 是否配置了 feed；未配置时 status 为 disabled，不假装能更新。 */
  configured: z.boolean(),
  status: z.enum(UPDATE_STATUSES),
  version: z.string().nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable()
})
export type UpdateState = z.infer<typeof UpdateStateSchema>
