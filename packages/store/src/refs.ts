/** 命令层共用的引用解析：id 或名字 → 实体行。 */
import type { CommandContext } from './commands.js';

export interface EntityRef {
  id: string;
  name: string;
  kind: string;
}

export function resolveEntity(ctx: CommandContext, ref: string): EntityRef | null {
  const byId = ctx.db
    .prepare('SELECT id, name, kind FROM entity WHERE id = ? AND branch_id = ?')
    .get(ref, ctx.branchId) as EntityRef | undefined;
  if (byId) return byId;
  const byName = ctx.db
    .prepare(
      `SELECT id, name, kind FROM entity
       WHERE branch_id = ? AND (
         name = ? OR EXISTS (SELECT 1 FROM json_each(entity.aliases) WHERE json_each.value = ?)
       )
       ORDER BY CASE kind WHEN 'character' THEN 0 ELSE 1 END, name LIMIT 1`,
    )
    .get(ctx.branchId, ref, ref) as EntityRef | undefined;
  return byName ?? null;
}

export function requireEntity(ctx: CommandContext, ref: string, label = '实体'): EntityRef {
  const entity = resolveEntity(ctx, ref);
  if (!entity) throw new Error(`${label}不存在或不属于当前分支：${ref}`);
  return entity;
}
