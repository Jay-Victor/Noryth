import type { RefType, ToolRef } from '../types'

/** 引用构造器：只做形状归一，不做可见性判断。 */
export function makeRef(type: RefType, id: string, quote: string, seq?: number): ToolRef {
  return seq === undefined ? { type, id, quote } : { type, id, quote, seq }
}

export function refIds(refs: readonly ToolRef[]): string[] {
  return refs.map((ref) => `${ref.type}:${ref.id}`)
}
