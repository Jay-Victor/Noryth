/**
 * Agent 输出契约（03 §2）与模型端口。
 *
 * 模型没有写权限：这里只做"把一段文本变成合法提案"的校验，
 * 提案是否落库由 store 的命令层决定。core 不 import store、不碰网络。
 */
import { z } from 'zod';
import { canonicalJson } from './hash.js';

export const EMOTIONS = [
  'calm',
  'tense',
  'afraid',
  'angry',
  'sad',
  'relieved',
  'elated',
] as const;

export const AssertSchema = z.strictObject({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  claims_true: z.boolean().default(true),
});

export const CharacterOutputSchema = z.strictObject({
  line: z.string().default(''),
  action: z.string().default(''),
  thought: z.string().default(''),
  intent: z.string().default(''),
  addressed_to: z.array(z.string()).default([]),
  asserts: z.array(AssertSchema).default([]),
  reveals: z.array(z.string()).default([]),
  emotion: z.enum(EMOTIONS).default('calm'),
});

export type CharacterOutput = z.infer<typeof CharacterOutputSchema>;

export const NARRATOR_FOCUS = ['环境', '动作', '心理', '背景', '转场'] as const;

export const NarratorOutputSchema = z.strictObject({
  paragraphs: z.array(z.string().min(1)).min(1),
  focus: z.enum(NARRATOR_FOCUS).default('环境'),
});

export type NarratorOutput = z.infer<typeof NarratorOutputSchema>;

export type AgentOutput = CharacterOutput | NarratorOutput;

/** 模型端口：core 只定义契约，provider 在 CLI / desktop 注入。 */
export interface ModelRequest {
  kind: 'character' | 'narrator';
  agentId: string;
  agentName: string;
  seq: number;
  seed: number;
  /** closing = 收束旁白（场景已满足退出条件，再写 1 拍）。 */
  intent?: 'beat' | 'closing';
  prompt: { system: string; user: string };
}

export interface ModelPort {
  readonly name: string;
  generate(request: ModelRequest): Promise<string>;
}

export interface ClaimIndexEntry {
  factId: string;
  truth: number;
}

/** asserts 的匹配键：subject + predicate + 规范化 object。 */
export function assertKey(subject: string, predicate: string, object: unknown): string {
  return `${subject}\u0000${predicate}\u0000${canonicalJson(object)}`;
}

export interface KnowledgeViolation {
  kind: 'assert' | 'reveal';
  factId: string;
  detail: string;
}

/**
 * 提交前的知识边界校验（03 §8 第 1 类）：
 * - reveal 的 fact 必须在 actor 的 cognition 里；
 * - assert 若匹配到既有事实、而该事实不在 cognition 里 → 拒绝；
 * - 匹配不到事实的 assert 是新 claim，不改世界状态，放行。
 */
export function knowledgeViolations(
  output: CharacterOutput,
  knownFactIds: ReadonlySet<string>,
  claims: ReadonlyMap<string, ClaimIndexEntry>,
): KnowledgeViolation[] {
  const out: KnowledgeViolation[] = [];
  for (const factId of output.reveals) {
    if (!knownFactIds.has(factId)) {
      out.push({ kind: 'reveal', factId, detail: `reveals 了不知道的事实 ${factId}` });
    }
  }
  for (const assert of output.asserts) {
    const key = assertKey(assert.subject, assert.predicate, assert.object);
    const entry = claims.get(key);
    if (entry && !knownFactIds.has(entry.factId)) {
      out.push({
        kind: 'assert',
        factId: entry.factId,
        detail: `asserts 匹配到不知道的事实 ${entry.factId}（${assert.subject}·${assert.predicate}）`,
      });
    }
  }
  return out;
}

/** 解析模型文本；失败返回错误信息而不是抛错，调用方决定重试。 */
export function parseCharacterOutput(
  text: string,
): { ok: true; value: CharacterOutput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = CharacterOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, value: result.data };
}

export function parseNarratorOutput(
  text: string,
): { ok: true; value: NarratorOutput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = NarratorOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, value: result.data };
}

/** 模型常把 JSON 包在 ```json 围栏里；只剥围栏，不改内容。 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}
