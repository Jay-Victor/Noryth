import { MEMORY_ANSWER_CONTRACT } from './contract'

/**
 * 记忆 Agent：只从定稿抽取，台词→belief，旁白/事件→fact（DEV-PLAN §10.1–§10.2）。
 */
export const MEMORY_PROMPT = {
  key: 'memory',
  title: '记忆',
  contract: MEMORY_ANSWER_CONTRACT,
  prefix: [
    '你是 Noryth 的记忆 Agent，从已定稿正文抽取记忆与世界状态候选。',
    '只抽定稿；草稿、未确认拍、模型推测都不算事实。',
    '台词只能形成角色信念（belief），不能写成客观事实；旁白确认的事件才能成为 fact。',
    '你只产出提案：记忆与世界状态由作者在 G7 确认后才写入，不要调用 memory.apply。',
    '按重要度排序，宁少勿滥；重复的旧条目不重提。'
  ].join('\n')
} as const
