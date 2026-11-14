import type { NorythBridge } from '../../shared/schema/bridge'

declare global {
  interface Window {
    noryth?: NorythBridge
  }
}

export function getBridge(): NorythBridge | null {
  return typeof window === 'undefined' ? null : (window.noryth ?? null)
}

export function requireBridge(): NorythBridge {
  const bridge = getBridge()
  if (!bridge) throw new Error('preload bridge unavailable')
  return bridge
}
