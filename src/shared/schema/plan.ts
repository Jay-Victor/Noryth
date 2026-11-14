import { z } from 'zod'

/**
 * 规划台契约（PHASE-06 E1–E5）。
 *
 * 边界：
 * - 对话只产生「提案」；作者点「应用建议」才写草案。
 * - 草案（plan_* 表）与正式实体（outline_node / character / world_fact）分离；
 *   G1 之前不注册角色、不建库、不写世界状态。
 * - G1 后蓝图只读；继续修改走提案流程（P1 影响分析）。
 */

export const VOICE_KEYS = ['sentence_length', 'catchphrase', 'address_habit', 'banned_words'] as const
export type VoiceKey = (typeof VOICE_KEYS)[number]

export const VOICE_LABELS: Record<VoiceKey, string> = {
  sentence_length: '句长倾向',
  catchphrase: '口头禅',
  address_habit: '称呼习惯',
  banned_words: '禁用词'
}

export const CharacterVoiceSchema = z.strictObject({
  sentence_length: z.string().max(200).default(''),
  catchphrase: z.string().max(200).default(''),
  address_habit: z.string().max(200).default(''),
  banned_words: z.string().max(200).default('')
})
export type CharacterVoice = z.infer<typeof CharacterVoiceSchema>

export const CharacterCardSchema = z.strictObject({
  identity: z.string().max(300).default(''),
  appearance: z.string().max(500).default(''),
  voice: CharacterVoiceSchema.default({
    sentence_length: '',
    catchphrase: '',
    address_habit: '',
    banned_words: ''
  }),
  want: z.string().max(500).default(''),
  fear: z.string().max(500).default(''),
  taboo: z.string().max(500).default(''),
  initial_relationships: z.string().max(800).default(''),
  initial_known: z.string().max(800).default(''),
  initial_unknown: z.string().max(800).default(''),
  public_identity: z.string().max(300).optional(),
  public_voice: z.string().max(300).optional()
})
export type CharacterCard = z.infer<typeof CharacterCardSchema>

export function emptyCharacterCard(): CharacterCard {
  return CharacterCardSchema.parse({})
}

/**
 * 公开投影的输入：身份/语气摘要随 canonical 字段更新。
 * 规划台不单独编辑 public_*；若外面显式给了值，也以 canonical 字段为准，
 * 避免角色卡改了身份、旁白仍读到旧公开档案。
 */
export function withPublicFields(card: CharacterCard): CharacterCard {
  const voiceText = [card.voice.sentence_length, card.voice.catchphrase]
    .filter((part) => part.trim().length > 0)
    .join('；')
  return {
    ...card,
    public_identity: card.identity,
    public_voice: voiceText.length > 0 ? voiceText : (card.public_voice ?? '')
  }
}

/** 角色卡字段（解析失败时回落到空卡，不阻塞 UI 渲染）。 */
export function parseCharacterCard(json: string): CharacterCard {
  try {
    const parsed: unknown = JSON.parse(json)
    return normalizeCharacterCard(parsed)
  } catch {
    return emptyCharacterCard()
  }
}

/** 宽松归一化：只取已知字段，丢弃模型多给的键（不把未知字段写进卡）。 */
export function normalizeCharacterCard(value: unknown): CharacterCard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyCharacterCard()
  const direct = CharacterCardSchema.safeParse(value)
  if (direct.success) return direct.data
  const record = value as Record<string, unknown>
  const stringOf = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '')
  const voiceRaw = record.voice
  const voiceRecord =
    voiceRaw !== null && typeof voiceRaw === 'object' && !Array.isArray(voiceRaw)
      ? (voiceRaw as Record<string, unknown>)
      : {}
  const voiceOf = (key: VoiceKey): string =>
    typeof voiceRecord[key] === 'string' ? (voiceRecord[key] as string) : ''
  const result = CharacterCardSchema.safeParse({
    identity: stringOf('identity'),
    appearance: stringOf('appearance'),
    voice: {
      sentence_length: voiceOf('sentence_length'),
      catchphrase: voiceOf('catchphrase'),
      address_habit: voiceOf('address_habit'),
      banned_words: voiceOf('banned_words')
    },
    want: stringOf('want'),
    fear: stringOf('fear'),
    taboo: stringOf('taboo'),
    initial_relationships: stringOf('initial_relationships'),
    initial_known: stringOf('initial_known'),
    initial_unknown: stringOf('initial_unknown'),
    ...(typeof record.public_identity === 'string' ? { public_identity: record.public_identity } : {}),
    ...(typeof record.public_voice === 'string' ? { public_voice: record.public_voice } : {})
  })
  return result.success ? result.data : emptyCharacterCard()
}

/** voice 四项缺失；空串按缺失处理（PHASE-06 E3）。 */
export function missingVoiceFields(card: CharacterCard): VoiceKey[] {
  return VOICE_KEYS.filter((key) => card.voice[key].trim().length === 0)
}

export const PLAN_COVERAGE_NOTE = '覆盖检查未启用（P1）；当前不阻断 G1。'

export const PLAN_SESSION_STATUSES = ['active', 'archived'] as const
export const PlanSessionStatusSchema = z.enum(PLAN_SESSION_STATUSES)

export const PLAN_MESSAGE_ROLES = ['author', 'planner', 'system'] as const
export const PlanMessageRoleSchema = z.enum(PLAN_MESSAGE_ROLES)

export const PLAN_MESSAGE_KINDS = ['text', 'draft', 'coverage', 'g1', 'error'] as const
export const PlanMessageKindSchema = z.enum(PLAN_MESSAGE_KINDS)

export const PLAN_MESSAGE_STATUSES = ['streaming', 'done', 'stopped', 'failed'] as const
export const PlanMessageStatusSchema = z.enum(PLAN_MESSAGE_STATUSES)

export const PlanMessageMetaSchema = z.strictObject({
  /** 仅讨论 / 用于草案：决定消息底部标记（UI-DESIGN §4.3）。 */
  label: z.enum(['discussion', 'draft']).optional(),
  proposal_ids: z.array(z.string()).optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  interrupted: z.boolean().optional(),
  usage: z
    .strictObject({ tokens_in: z.number().int().nullable(), tokens_out: z.number().int().nullable() })
    .optional(),
  model: z.string().optional(),
  /** 重试前的已生成文本；保留在 meta 里，避免误以为被静默丢弃。 */
  previous_body: z.string().optional()
})
export type PlanMessageMeta = z.infer<typeof PlanMessageMetaSchema>

export const PlanSessionSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: PlanSessionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative()
})
export type PlanSessionView = z.infer<typeof PlanSessionSchema>

export const PlanMessageSchema = z.strictObject({
  id: z.string(),
  sessionId: z.string(),
  role: PlanMessageRoleSchema,
  kind: PlanMessageKindSchema,
  body: z.string(),
  status: PlanMessageStatusSchema,
  meta: PlanMessageMetaSchema,
  attempt: z.number().int().positive(),
  retryOf: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type PlanMessageView = z.infer<typeof PlanMessageSchema>

export const PlanOutlineNodeSchema = z.strictObject({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(['main', 'volume', 'chapter']),
  ord: z.number().int(),
  title: z.string(),
  content: z.string(),
  status: z.enum(['draft', 'approved', 'locked']),
  version: z.number().int()
})
export type PlanOutlineNode = z.infer<typeof PlanOutlineNodeSchema>

export const PlanCharacterSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  card: CharacterCardSchema,
  cardVersion: z.number().int().positive(),
  ord: z.number().int(),
  status: z.enum(['draft', 'registered']),
  registeredCharacterId: z.string().nullable()
})
export type PlanCharacterView = z.infer<typeof PlanCharacterSchema>

export const PlanFactSchema = z.strictObject({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  visibility: z.enum(['public', 'secret']),
  ord: z.number().int(),
  status: z.enum(['draft', 'applied'])
})
export type PlanFactView = z.infer<typeof PlanFactSchema>

export const PlanProposalSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['blueprint_patch', 'character_card', 'roster']),
  status: z.enum(['draft', 'applied', 'rejected']),
  summary: z.strictObject({
    added: z.number().int().optional(),
    updated: z.number().int().optional(),
    removed: z.number().int().optional(),
    characters: z.number().int().optional(),
    facts: z.number().int().optional(),
    character_name: z.string().optional(),
    affected_chapters: z.array(z.string()).optional(),
    note: z.string().optional()
  }),
  createdAt: z.string()
})
export type PlanProposalView = z.infer<typeof PlanProposalSchema>

export const PlanNamespaceSummarySchema = z.strictObject({
  privateCount: z.number().int().nonnegative(),
  publicCount: z.number().int().nonnegative(),
  isolationVerified: z.boolean()
})

export const PlanG1PreviewSchema = z.strictObject({
  blockers: z.array(z.string()),
  firstBlocker: z.string().nullable(),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  counts: z.strictObject({
    characters: z.number().int().nonnegative(),
    mains: z.number().int().nonnegative(),
    volumes: z.number().int().nonnegative(),
    chapters: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    namespaces: z.number().int().nonnegative()
  })
})
export type PlanG1Preview = z.infer<typeof PlanG1PreviewSchema>

export const PlanCoverageSchema = z.strictObject({
  enabled: z.literal(false),
  note: z.string(),
  items: z.array(z.strictObject({ code: z.string(), message: z.string() }))
})

export const PlanModelStatusSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  label: z.string(),
  /** false：没有可用 Key / 假适配器；发送会给出 model_auth/setup_incomplete。 */
  ready: z.boolean()
})
export type PlanModelStatus = z.infer<typeof PlanModelStatusSchema>

export const PlanStateSchema = z.strictObject({
  projectId: z.string(),
  setupState: z.enum(['pending', 'complete', 'failed']),
  readOnly: z.boolean(),
  blueprint: z.strictObject({
    version: z.number().int().nonnegative(),
    lockedAt: z.string().nullable(),
    nodes: z.array(PlanOutlineNodeSchema)
  }),
  characters: z.array(PlanCharacterSchema),
  facts: z.array(PlanFactSchema),
  sessions: z.array(PlanSessionSchema),
  activeSessionId: z.string().nullable(),
  messages: z.array(PlanMessageSchema),
  proposals: z.array(PlanProposalSchema),
  namespaces: PlanNamespaceSummarySchema,
  g1: PlanG1PreviewSchema,
  coverage: PlanCoverageSchema,
  model: PlanModelStatusSchema
})
export type PlanState = z.infer<typeof PlanStateSchema>

export const PlanEmptyInputSchema = z.strictObject({})

export const PlanStateInputSchema = z.strictObject({
  sessionId: z.string().min(1).optional()
})
export type PlanStateInput = z.infer<typeof PlanStateInputSchema>

export const PlanSessionCreateInputSchema = z.strictObject({
  title: z.string().min(1).max(80).optional()
})
export type PlanSessionCreateInput = z.infer<typeof PlanSessionCreateInputSchema>

export const PlanSessionIdInputSchema = z.strictObject({ sessionId: z.string().min(1) })
export type PlanSessionIdInput = z.infer<typeof PlanSessionIdInputSchema>

export const PlanSessionRenameInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  title: z.string().min(1).max(80)
})
export type PlanSessionRenameInput = z.infer<typeof PlanSessionRenameInputSchema>

export const PlanSendInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(8000)
})
export type PlanSendInput = z.infer<typeof PlanSendInputSchema>

export const PlanMessageIdInputSchema = z.strictObject({ messageId: z.string().min(1) })

export const PlanSaveOutlineInputSchema = z.strictObject({
  nodeId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(20_000).optional()
})
export type PlanSaveOutlineInput = z.infer<typeof PlanSaveOutlineInputSchema>

export const PlanAddOutlineInputSchema = z.strictObject({
  parentId: z.string().min(1).nullable(),
  kind: z.enum(['main', 'volume', 'chapter']),
  ord: z.number().int().min(0).max(10_000).optional(),
  title: z.string().min(1).max(200),
  content: z.string().max(20_000).optional()
})
export type PlanAddOutlineInput = z.infer<typeof PlanAddOutlineInputSchema>

export const PlanRemoveOutlineInputSchema = z.strictObject({ nodeId: z.string().min(1) })

export const PlanCharacterSaveInputSchema = z.strictObject({
  characterId: z.string().min(1),
  card: CharacterCardSchema
})
export type PlanCharacterSaveInput = z.infer<typeof PlanCharacterSaveInputSchema>

export const PlanCharacterAddInputSchema = z.strictObject({
  name: z.string().min(1).max(40),
  card: CharacterCardSchema.optional()
})
export type PlanCharacterAddInput = z.infer<typeof PlanCharacterAddInputSchema>

export const PlanCharacterIdInputSchema = z.strictObject({ characterId: z.string().min(1) })

export const PlanFactSaveInputSchema = z.strictObject({
  factId: z.string().min(1),
  subject: z.string().min(1).max(80),
  predicate: z.string().min(1).max(80),
  object: z.string().min(1).max(300),
  visibility: z.enum(['public', 'secret'])
})
export type PlanFactSaveInput = z.infer<typeof PlanFactSaveInputSchema>

export const PlanFactAddInputSchema = z.strictObject({
  subject: z.string().min(1).max(80),
  predicate: z.string().min(1).max(80),
  object: z.string().min(1).max(300),
  visibility: z.enum(['public', 'secret']).default('public')
})
export type PlanFactAddInput = z.infer<typeof PlanFactAddInputSchema>

export const PlanFactIdInputSchema = z.strictObject({ factId: z.string().min(1) })

export const PlanProposalIdInputSchema = z.strictObject({ proposalId: z.string().min(1) })

export const PlanSaveResultSchema = z.strictObject({
  saved: z.boolean(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string()
})
export type PlanSaveResult = z.infer<typeof PlanSaveResultSchema>

export const PlanSendResultSchema = z.strictObject({
  sessionId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string(),
  status: z.literal('streaming')
})
export type PlanSendResult = z.infer<typeof PlanSendResultSchema>

export const PlanG1ResultSchema = z.strictObject({
  gateId: z.string().nullable(),
  setupState: z.enum(['pending', 'complete', 'failed']),
  blueprintVersion: z.number().int().nonnegative(),
  lockedAt: z.string().nullable(),
  registeredCount: z.number().int().nonnegative(),
  namespaces: z.array(
    z.strictObject({
      characterId: z.string().nullable(),
      kind: z.enum(['private', 'public']),
      name: z.string()
    })
  ),
  isolationVerified: z.boolean(),
  /** 建库失败时非空；UI 显示横幅 + 重试。 */
  setupError: z.string().nullable()
})
export type PlanG1Result = z.infer<typeof PlanG1ResultSchema>

export const PlanProposalApplyResultSchema = z.strictObject({
  proposalId: z.string(),
  status: z.literal('applied'),
  blueprintVersion: z.number().int().nonnegative(),
  charactersCreated: z.number().int().nonnegative(),
  factsCreated: z.number().int().nonnegative(),
  nodesCreated: z.number().int().nonnegative(),
  affectedChapters: z.array(z.string())
})
export type PlanProposalApplyResult = z.infer<typeof PlanProposalApplyResultSchema>

export const PLAN_EVENT_PHASES = ['start', 'delta', 'done', 'stopped', 'failed'] as const
export const PlanEventPhaseSchema = z.enum(PLAN_EVENT_PHASES)

export const PlanEventSchema = z.strictObject({
  projectId: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  phase: PlanEventPhaseSchema,
  delta: z.string().optional(),
  full: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  label: z.enum(['discussion', 'draft']).optional(),
  proposalIds: z.array(z.string()).optional()
})
export type PlanEvent = z.infer<typeof PlanEventSchema>

/** T42 author.request_choice：规划 Agent 在会话中向作者要一个选择。 */
export const PlanChoiceOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1)
})
export const PlanChoiceRequestSchema = z.strictObject({
  projectId: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  choiceId: z.string(),
  question: z.string(),
  options: z.array(PlanChoiceOptionSchema).min(2).max(4)
})
export type PlanChoiceRequest = z.infer<typeof PlanChoiceRequestSchema>

export const PlanChooseInputSchema = z.strictObject({
  choiceId: z.string().min(1),
  optionId: z.string().min(1)
})
export type PlanChooseInput = z.infer<typeof PlanChooseInputSchema>

