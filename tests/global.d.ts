import type { NorythBridge } from '../src/shared/schema/bridge'

declare global {
  interface Window {
    noryth?: NorythBridge
  }
}

export {}
