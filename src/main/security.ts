import type { BrowserWindow, WebPreferences } from 'electron'

/** 生产 CSP：renderer 不发网络请求（DEV-PLAN §4.4）。 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** 开发 CSP：只放行 Vite dev server 与 HMR websocket。 */
export function devCsp(rendererUrl: string): string {
  const url = new URL(rendererUrl)
  const ws = `ws://${url.host}`
  const http = `http://${url.host}`
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${http}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${http} ${ws}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true
} as const

export function assertSecurePreferences(prefs: WebPreferences): void {
  if (prefs.contextIsolation !== true) throw new Error('contextIsolation must be true')
  if (prefs.nodeIntegration !== false) throw new Error('nodeIntegration must be false')
  if (prefs.sandbox !== true) throw new Error('sandbox must be true')
  if (prefs.webSecurity === false) throw new Error('webSecurity must not be disabled')
}

export function isAllowedNavigation(target: string, devUrl: string | undefined): boolean {
  try {
    const url = new URL(target)
    if (url.protocol === 'app:' && url.host === 'noryth') return true
    if (devUrl) {
      const dev = new URL(devUrl)
      return url.origin === dev.origin
    }
    return false
  } catch {
    return false
  }
}

/** 导航与新窗口一律拒绝外部地址；外链只允许 https 走系统浏览器（本阶段无外链入口）。 */
export function hardenWindow(window: BrowserWindow, devUrl: string | undefined): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devUrl)) event.preventDefault()
  })
}
