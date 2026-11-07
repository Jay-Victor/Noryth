/**
 * P1 · 上下文装配：把"这个角色此刻知道什么"变成一段提示词。
 *
 * 顺序是硬性的：先按 cognition 过滤事实，再拼装；调用方拿不到"未过滤的事实"
 * 这个中间态（01 §1 I1、§6 A3）。七段配额与降级走 context.ts，本文件只负责
 * 把领域数据切成段，并保证 tokens ≤ budget、绝不截断半句（A2）。
 */
import { packContext, type KeptItem, type PackItem, type PackResult, type PackSection } from './context.js';
import { PARAMS } from './params.js';
import { estTokens } from './tokens.js';
import { splitSentences } from './voice.js';
import { visibleFacts, type CognitionRecord, type KnowledgeFact } from './knowledge.js';

const {
  'context.budget_total': DEFAULT_BUDGET,
  'context.recent_max_beats': RECENT_MAX,
  'scene.max_level': MAX_LEVEL,
} = PARAMS;

/**
 * 已知事实封顶 34 条（01 §6 A2 的实测口径）。
 * 这不是分页：超出时按"最近写入优先"保留，因为新事实更可能与本拍相关。
 */
export const FACT_CAP = 34;

export interface AgentCardView {
  name: string;
  identity: string;
  personality: string;
  speechStyle: string;
  values: string;
  want: string;
}

export interface SceneCardView {
  title: string;
  location: string;
  storyStart: string;
  timeline: string;
  presentNames: readonly string[];
  goal: string;
  conflictLevel: number;
  situation: string;
}

export interface BeatView {
  seq: number;
  speaker: string;
  roleType: string;
  prose: string;
}

export interface FactView {
  id: string;
  subjectId: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  truth: number;
  secrecy: number;
  source: string;
  /** 用于审计的独特标记；不参与提示词。 */
  marker?: string;
  redactFor?: readonly string[];
  observable?: boolean;
}

export interface CognitionView {
  characterId: string;
  factId: string;
  attitude: string;
  certainty: number;
  percept?: string;
}

export interface RelationView {
  toName: string;
  axis: string;
  value: number;
  reason?: string;
}

export interface ClueView {
  id: string;
  text: string;
  stale?: boolean;
}

/**
 * 已授权进入该角色上下文的记忆节点（owner 为空或本人，且 sensitivity < 3）。
 * 检索在 store 侧完成——core 只负责拼装，不读库。
 */
export interface MemoryView {
  id: string;
  text: string;
  kind: string;
}

export interface CharacterContextInput {
  characterId: string;
  agent: AgentCardView;
  scene: SceneCardView;
  /** 书名；渲染进 system 首行，不参与评分。 */
  novelTitle?: string;
  /** 已按受众过滤的最近拍，旧 → 新。 */
  recent: readonly BeatView[];
  /** 本分支全部事实；过滤在本函数内完成。 */
  facts: readonly FactView[];
  cognition: readonly CognitionView[];
  relations: readonly RelationView[];
  clues: readonly ClueView[];
  /** 检索到的相关记忆；缺省为空，P1 的 4352 tok 实测口径不变。 */
  memories?: readonly MemoryView[];
  budget?: number;
}

export interface ContextPrompt {
  system: string;
  user: string;
}

export interface ContextResult {
  sections: PackSection[];
  packed: PackResult;
  prompt: ContextPrompt;
  tokens: number;
  budget: number;
  level: PackResult['level'];
  dropped: number;
  /** 实际进入上下文的 fact id；用于越权审计。 */
  factIds: string[];
  visibleFacts: FactView[];
}

function levelTexts(full: string, summary: string, triple: string, id: string): PackItem {
  return { full, summary, triple, id };
}

function sentences(text: string, count: number): string {
  return splitSentences(text).slice(0, count).join('');
}

function factItem(fact: FactView, keepRank: number): PackItem {
  return {
    ...levelTexts(
      `${fact.subjectName}${fact.predicate}${fact.objectText}（来源：${fact.source}）`,
      `${fact.subjectName}${fact.predicate}${fact.objectText}`,
      `${fact.subjectName}|${fact.predicate}|${fact.objectText}`,
      `f:${fact.id}`,
    ),
    keepRank,
  };
}

/** 记忆节点排在事实之后：预算吃紧时先丢检索材料，不丢权威事实。 */
function memoryItem(memory: MemoryView, keepRank: number): PackItem {
  return {
    ...levelTexts(
      `（记忆·${memory.kind}）${memory.text}`,
      sentences(memory.text, 2),
      `${memory.kind}:${memory.id}`,
      `m:${memory.id}`,
    ),
    keepRank,
  };
}

function beatItem(beat: BeatView, keepRank: number): PackItem {
  return {
    ...levelTexts(
      beat.prose,
      sentences(beat.prose, 2),
      sentences(beat.prose, 1),
      `#${beat.seq} ${beat.speaker}`,
    ),
    keepRank,
  };
}

function cardItem(agent: AgentCardView): PackItem {
  const full = [
    `你是${agent.name}（${agent.identity}）。`,
    agent.personality,
    `说话方式：${agent.speechStyle}`,
    `在意：${agent.values}`,
    `现在最想要：${agent.want}`,
  ].join('\n');
  return {
    ...levelTexts(full, `${agent.identity}；想要：${agent.want}`, `${agent.name}·${agent.identity}`, agent.name),
    keepRank: 0,
  };
}

function sceneItem(scene: SceneCardView): PackItem {
  const full = [
    `地点：${scene.location}　时间：${scene.storyStart}（${scene.timeline}）`,
    `在场：${scene.presentNames.join('、')}`,
    `目标：${scene.goal}`,
    `冲突等级：${scene.conflictLevel}/${MAX_LEVEL}`,
    scene.situation,
  ].join('\n');
  return {
    ...levelTexts(
      full,
      `${scene.title}／${scene.location}／目标：${scene.goal}`,
      `${scene.title}／${scene.location}`,
      scene.title,
    ),
    keepRank: 0,
  };
}

const CHARACTER_CONTRACT = [
  '【输出】严格 JSON，不要代码块围栏：',
  '{"line":"","action":"","thought":"","intent":"","addressed_to":[],"asserts":[],"reveals":[],"emotion":""}',
  '【禁止】',
  '1. 不替任何人说话、不决定任何人的行动。',
  '2. 不使用【你知道什么】之外的专有名词、人名、地名、事件、称谓。',
  '3. thought 只写心理，action 只写别人看得见的。',
].join('\n');

const NARRATOR_CONTRACT = [
  '【输出】严格 JSON，不要代码块围栏：',
  '{"paragraphs":["…"],"focus":"环境|动作|心理|背景|转场"}',
  '【禁止】',
  '1. 不揭示任何未在白名单中的事实。',
  '2. 不写非视点角色的内心。',
  '3. 不评价人物，只呈现。',
].join('\n');

function contractItem(text: string): PackItem {
  return {
    ...levelTexts(text, '只输出约定的 JSON，不写解释。', '严格 JSON。', 'json'),
    keepRank: 0,
  };
}

function relationItem(relation: RelationView): PackItem {
  const value = relation.value.toFixed(2);
  return {
    ...levelTexts(
      `对${relation.toName}：${relation.axis} ${value}${relation.reason ? `（${relation.reason}）` : ''}`,
      `对${relation.toName} ${relation.axis} ${value}`,
      `${relation.toName}|${relation.axis}|${value}`,
      relation.toName,
    ),
    keepRank: 0,
  };
}

function clueItem(clue: ClueView): PackItem {
  return {
    ...levelTexts(clue.text, sentences(clue.text, 2), sentences(clue.text, 1), `c:${clue.id}`),
    keepRank: clue.stale ? 5 : 0,
  };
}

/**
 * 先过滤后装配。visibleFacts 是唯一入口：没有 cognition 行的事实不会进入 sections。
 * 事实按 source 的写入顺序无法得知，调用方用数组顺序表达"最近优先"。
 */
export function assembleCharacterContext(input: CharacterContextInput): ContextResult {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const knowledge: KnowledgeFact[] = input.facts.map((f) => ({
    id: f.id,
    object: f.objectText,
    secrecy: f.secrecy,
    redactFor: f.redactFor ? new Set(f.redactFor) : undefined,
  }));
  const cognition: CognitionRecord[] = input.cognition.map((c) => ({
    characterId: c.characterId,
    factId: c.factId,
    learnedSeq: 0,
    attitude: c.attitude as CognitionRecord['attitude'],
    certainty: c.certainty,
    percept: c.percept as CognitionRecord['percept'],
  }));
  const visible = visibleFacts(knowledge, input.characterId, cognition);
  const visibleIds = new Set(visible.map((f) => f.id));
  const facts = input.facts.filter((f) => visibleIds.has(f.id)).slice(0, FACT_CAP);
  const factById = new Map(facts.map((f) => [f.id, f]));
  const recent = input.recent.slice(-RECENT_MAX);

  const sections: PackSection[] = [
    { name: 'card', items: [cardItem(input.agent)] },
    { name: 'scene', items: [sceneItem(input.scene)] },
    {
      name: 'recent',
      items: recent.map((beat, i) => beatItem(beat, recent.length - 1 - i)),
    },
    {
      name: 'memory',
      items: [
        ...facts.map((fact, i) => factItem(factById.get(fact.id) ?? fact, i)),
        ...(input.memories ?? []).map((memory, i) => memoryItem(memory, FACT_CAP + i)),
      ],
    },
    { name: 'relation', items: input.relations.map(relationItem) },
    { name: 'clue', items: input.clues.map(clueItem) },
    { name: 'contract', items: [contractItem(CHARACTER_CONTRACT)] },
  ];

  return finish(
    sections,
    budget,
    input.agent,
    input.novelTitle ?? '未命名项目',
    facts.map((f) => f.id),
    facts,
  );
}

export interface NarratorContextInput {
  agent: AgentCardView;
  scene: SceneCardView;
  novelTitle?: string;
  recent: readonly BeatView[];
  facts: readonly FactView[];
  cognition: readonly CognitionView[];
  /** 在场者的 entity id；用于判定"是否有在场者知道这条秘密"。 */
  present?: readonly string[];
  clues: readonly ClueView[];
  budget?: number;
}

/**
 * 旁白的事实白名单（03 §2.2）：
 *   地点/场面 + 在场者可观察的事实 + secrecy ≤ 1 的公开信息
 *   − secrecy ≥ 2 且在场无人知道的事
 * 秘密不进旁白：它要写"他攥紧了拳头"，只能来自可见行为。
 */
export function narratorWhitelist(input: NarratorContextInput): FactView[] {
  const presentIds = new Set(input.present ?? []);
  const presentNames = input.scene.presentNames;
  const known = new Set<string>();
  for (const c of input.cognition) {
    if (presentIds.has(c.characterId)) known.add(c.factId);
  }
  return input.facts.filter((fact) => {
    let include: boolean;
    if (fact.secrecy >= 2) {
      // 高敏事实：只有在场者知道、或它本身就是在场者可观察的状态，才进白名单。
      include =
        known.has(fact.id) ||
        (presentNames.includes(fact.subjectName) && fact.observable === true);
    } else {
      include = true;
    }
    return include;
  });
}

export function assembleNarratorContext(input: NarratorContextInput): ContextResult {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const facts = narratorWhitelist(input);
  const sections: PackSection[] = [
    { name: 'card', items: [cardItem(input.agent)] },
    { name: 'scene', items: [sceneItem(input.scene)] },
    { name: 'recent', items: input.recent.slice(-2).map((b, i) => beatItem(b, i)) },
    { name: 'memory', items: facts.map((f, i) => factItem(f, i)) },
    // 旁白不持有关系轴：它对谁都没有态度。
    { name: 'relation', items: [] },
    { name: 'clue', items: input.clues.map(clueItem) },
    { name: 'contract', items: [contractItem(NARRATOR_CONTRACT)] },
  ];
  return finish(
    sections,
    budget,
    input.agent,
    input.novelTitle ?? '未命名项目',
    facts.map((f) => f.id),
    facts,
  );
}

function renderSection(
  name: string,
  kept: readonly KeptItem[],
  level: PackResult['level'],
): string {
  const key = level === 'id+drop' ? 'id' : level;
  return kept
    .filter((entry) => entry.section === name)
    .map((entry) => entry.item[key])
    .join('\n');
}

function renderPrompt(
  packed: PackResult,
  agent: AgentCardView,
  novelTitle: string,
): ContextPrompt {
  const level = packed.level;
  const system = [
    `你是《${novelTitle}》中的 ${agent.name}（${agent.identity}）。`,
    '你不是 AI，也不知道"旁白""其他角色""剧情"这些概念的存在。',
    '',
    '【你是什么人】',
    renderSection('card', packed.kept, level),
    '',
    renderSection('contract', packed.kept, level),
  ].join('\n');
  const memory = renderSection('memory', packed.kept, level);
  const relation = renderSection('relation', packed.kept, level);
  const clue = renderSection('clue', packed.kept, level);
  const recent = renderSection('recent', packed.kept, level);
  const user = [
    '【此刻】',
    renderSection('scene', packed.kept, level),
    '',
    '【你知道什么】',
    memory || '（无相关记忆）',
    '',
    '【对在场者的态度】',
    relation || '（无）',
    '',
    '【未结线索】',
    clue || '（无）',
    '',
    '【最近发生】',
    recent || '（无）',
  ].join('\n');
  return { system, user };
}

/**
 * 预算闭环：packContext 只管条目，提示词还有固定骨架与分隔符。
 * 这里实测整段提示词的 token，超了就把预算下调后重装，最多 4 轮。
 * 最终仍放不下 → 抛错（预算小到装不下输出契约，是调用方的错）。
 */
function finish(
  sections: PackSection[],
  budget: number,
  agent: AgentCardView,
  novelTitle: string,
  factIds: string[],
  facts: FactView[],
): ContextResult {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`上下文预算必须是正数：${budget}`);
  }
  let target = budget;
  let last: { packed: PackResult; prompt: ContextPrompt; tokens: number } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const packed = packContext(sections, target);
    const prompt = renderPrompt(packed, agent, novelTitle);
    const tokens = estTokens(prompt.system) + estTokens(prompt.user);
    last = { packed, prompt, tokens };
    if (tokens <= budget) break;
    target = Math.max(0, target - (tokens - budget) - 1);
  }
  if (!last) throw new Error('上下文装配没有产生结果');
  if (last.tokens > budget) {
    throw new Error(`上下文预算过小：骨架 ${last.tokens} tok > budget ${budget}`);
  }
  return {
    sections,
    packed: last.packed,
    prompt: last.prompt,
    tokens: last.tokens,
    budget,
    level: last.packed.level,
    dropped: last.packed.dropped,
    factIds,
    visibleFacts: facts,
  };
}

/**
 * 越权审计：未在 cognition 中的事实，其独特标记不得出现在提示词里。
 * 只统计带 marker 的事实（生产路径用对象文本，测试用唯一串），避免误报。
 */
export function countLeakedFacts(
  prompt: ContextPrompt,
  facts: readonly FactView[],
  cognition: readonly CognitionView[],
  characterId: string,
): { count: number; ids: string[] } {
  const known = new Set(
    cognition.filter((c) => c.characterId === characterId).map((c) => c.factId),
  );
  const text = `${prompt.system}\n${prompt.user}`;
  const ids = facts
    .filter((f) => !known.has(f.id))
    .filter((f) => (f.marker ?? '').length > 0 && text.includes(f.marker!))
    .map((f) => f.id);
  return { count: ids.length, ids };
}
