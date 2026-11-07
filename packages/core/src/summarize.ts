/**
 * P2 · 场景摘要（确定性抽取）。
 *
 * 摘要必须可回溯（03 §6）：它不是新的世界真相，只是被压缩的记忆节点；
 * 原文（event 节点）永不删除，只降权。DERIVED_FROM 边由命令层写入，
 * 触发器 `ck_memory_has_children` 保证有子节点的摘要删不掉。
 *
 * P2 不调用模型写摘要：同步阶段的摘要必须是确定性的（回退能复演），
 * 模型润色留给 P3 的 summarize 作业。这里做的是"可断言的抽取"：
 * 标题 + 目标 + 第一段环境描写 + 最后一拍的第一句。
 */

export interface SummaryBeat {
  seq: number;
  roleType: string;
  speaker: string;
  prose: string;
}

const MAX_SUMMARY_CHARS = 240;

/** 取第一句：句号/感叹/问号/换行都算边界；没有边界时整段保留。 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const match = /[^。！？!?\n]+[。！？!?]?/.exec(trimmed);
  return (match?.[0] ?? trimmed).trim();
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const boundary = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  if (boundary >= Math.floor(limit * 0.5)) return head.slice(0, boundary + 1);
  return head;
}

/**
 * 确定性摘要文本。没有旁白时用第一拍，没有台词时退回标题 + 目标。
 * 空场景返回空串——调用方据此跳过摘要节点，不写"（空）"充数。
 */
export function sceneSummaryText(input: {
  title: string;
  goal: string;
  beats: readonly SummaryBeat[];
}): string {
  const body = input.beats.filter(
    (beat) => beat.roleType === 'character' || beat.roleType === 'narrator',
  );
  if (body.length === 0) return '';
  const parts: string[] = [input.title.trim()];
  const goal = input.goal.trim();
  if (goal.length > 0) parts.push(goal);
  const narrator = body.find((beat) => beat.roleType === 'narrator');
  const opener = firstSentence((narrator ?? body[0]!).prose);
  if (opener.length > 0) parts.push(opener);
  const last = body[body.length - 1]!;
  const closing = firstSentence(last.prose);
  if (closing.length > 0 && closing !== opener) parts.push(`${last.speaker}：${closing}`);
  return clip(parts.join('。'), MAX_SUMMARY_CHARS);
}

/** 压缩后原文降权，不删除：保留 50%，下限 0.05（schema 的 importance 下界）。 */
export function downweightedImportance(importance: number): number {
  return Math.max(0.05, Number((importance * 0.5).toFixed(3)));
}
