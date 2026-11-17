import { describe, expect, it } from 'vitest'
import {
  assertSecurePreferences,
  devCsp,
  isAllowedNavigation,
  PROD_CSP,
  SECURE_WEB_PREFERENCES
} from '../../src/main/security'

/**
 * 安全基线（DEV-PLAN §4.4）：窗口偏好、导航白名单、CSP。
 *
 * 这些是启动断言与 `will-navigate` 的纯逻辑；外链入口当前不存在
 * （应用内没有指向外部站点的链接），所以只断言「外部地址不被允许」。
 */

describe('安全基线', () => {
  it('窗口偏好是硬编码的安全值，断言函数会拒绝被改坏的配置', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
    expect(() => assertSecurePreferences(SECURE_WEB_PREFERENCES)).not.toThrow()
    expect(() => assertSecurePreferences({ ...SECURE_WEB_PREFERENCES, contextIsolation: false })).toThrow(
      /contextIsolation/
    )
    expect(() => assertSecurePreferences({ ...SECURE_WEB_PREFERENCES, nodeIntegration: true })).toThrow(
      /nodeIntegration/
    )
    expect(() => assertSecurePreferences({ ...SECURE_WEB_PREFERENCES, sandbox: false })).toThrow(/sandbox/)
    expect(() => assertSecurePreferences({ ...SECURE_WEB_PREFERENCES, webSecurity: false })).toThrow(
      /webSecurity/
    )
  })

  it('导航白名单：只放行 app://noryth 与 dev server 同源', () => {
    expect(isAllowedNavigation('app://noryth/index.html', undefined)).toBe(true)
    expect(isAllowedNavigation('app://noryth/#/write', undefined)).toBe(true)
    expect(isAllowedNavigation('https://example.com/', undefined)).toBe(false)
    expect(isAllowedNavigation('file:///C:/secret.txt', undefined)).toBe(false)
    expect(isAllowedNavigation('javascript:alert(1)', undefined)).toBe(false)
    expect(isAllowedNavigation('not a url', undefined)).toBe(false)

    const dev = 'http://localhost:5173/'
    expect(isAllowedNavigation('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5174/', dev)).toBe(false)
    // 开发地址也在时，app 协议仍然允许（生产资源回退）。
    expect(isAllowedNavigation('app://noryth/index.html', dev)).toBe(true)
  })

  it('CSP：生产禁网络，开发只放行 dev server', () => {
    expect(PROD_CSP).toContain("default-src 'self'")
    expect(PROD_CSP).toContain("connect-src 'none'")
    expect(PROD_CSP).toContain("object-src 'none'")

    const dev = devCsp('http://localhost:5173/')
    expect(dev).toContain('http://localhost:5173')
    expect(dev).toContain('ws://localhost:5173')
    expect(dev).not.toContain("connect-src 'none'")
  })
})
