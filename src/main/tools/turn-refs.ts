import type { RefType, ToolRef } from './types'

/**
 * 轮内引用登记表（DEV-PLAN §6.6）：
 * grounding 必须是本轮工具真实返回过的 refs 的子集；阶段 04 的校验器用它。
 */
export class TurnRefRegistry {
  private readonly byKey = new Map<string, ToolRef>()

  private keyOf(type: RefType, id: string): string {
    return `${type}:${id}`
  }

  register(refs: readonly ToolRef[]): void {
    for (const ref of refs) this.byKey.set(this.keyOf(ref.type, ref.id), ref)
  }

  has(type: RefType, id: string): boolean {
    return this.byKey.has(this.keyOf(type, id))
  }

  quoteOf(type: RefType, id: string): string | undefined {
    return this.byKey.get(this.keyOf(type, id))?.quote
  }

  list(): ToolRef[] {
    return [...this.byKey.values()]
  }

  clear(): void {
    this.byKey.clear()
  }
}
