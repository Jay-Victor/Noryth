import { randomUUID } from 'node:crypto';

/** 前缀 + UUIDv4（去连字符）。ID 是随机量，不是序号——回退开分支时不能重复。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
