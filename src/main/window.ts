import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { assertSecurePreferences, hardenWindow, SECURE_WEB_PREFERENCES } from './security'

export interface CreateWindowOptions {
  preloadPath: string
  devUrl?: string
  /** 窗口/任务栏图标（M1-25）：打包后来自 extraResources/icons。 */
  icon?: string
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  assertSecurePreferences(SECURE_WEB_PREFERENCES)

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#f7f5f2',
    title: 'Noryth',
    titleBarStyle: 'hidden',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#f7f5f2',
            symbolColor: '#3a352f',
            height: 40
          }
        }
      : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: SECURE_WEB_PREFERENCES.contextIsolation,
      nodeIntegration: SECURE_WEB_PREFERENCES.nodeIntegration,
      sandbox: SECURE_WEB_PREFERENCES.sandbox,
      webSecurity: SECURE_WEB_PREFERENCES.webSecurity,
      spellcheck: false
    }
  })

  window.setMenuBarVisibility(false)
  hardenWindow(window, options.devUrl)

  window.once('ready-to-show', () => {
    window.show()
  })

  if (options.devUrl) {
    void window.loadURL(options.devUrl)
  } else {
    void window.loadURL('app://noryth/index.html')
  }

  return window
}

export function preloadPathFor(mainDir: string): string {
  return join(mainDir, '../preload/index.js')
}
