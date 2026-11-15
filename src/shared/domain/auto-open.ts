import type { AutoOpenReason } from '../schema/project'

/**
 * 启动自动打开的状态矩阵（AGENTS「完成标准 3」/ PHASE-11 §5.4）。
 *
 * 每个 reason 必须有确定的界面归属：要么静默（成功/关闭/没有上次项目），
 * 要么给一条可读提示。文案只回答「能不能继续」，原因进日志。
 * 新增 reason 必须同时改这里，否则 `tests/unit/auto-open-states.test.ts` 失败。
 */
export interface AutoOpenNotice {
  tone: 'info' | 'success' | 'error'
  title: string
  detail: string
  key: string
}

export const AUTO_OPEN_NOTICES: Record<AutoOpenReason, AutoOpenNotice | null> = {
  ok: null,
  disabled: null,
  no_last_project: null,
  missing: {
    tone: 'error',
    title: '上次项目路径不可用',
    detail: '条目已保留；用「重新定位」指向新位置',
    key: 'auto-open-missing'
  },
  locked: {
    tone: 'info',
    title: '上次项目在另一窗口打开',
    detail: '已停在首页；需要时用只读方式打开',
    key: 'auto-open-locked'
  },
  schema_newer: {
    tone: 'error',
    title: '上次项目由更新版本创建',
    detail: '升级到新版本后再打开',
    key: 'auto-open-schema'
  },
  failed: {
    tone: 'error',
    title: '上次项目无法自动打开',
    detail: '可从列表手动重试；失败原因在日志里',
    key: 'auto-open-failed'
  }
}
