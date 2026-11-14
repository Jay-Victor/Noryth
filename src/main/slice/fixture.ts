import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { AppError } from '../../shared/domain/app-error'

/**
 * 切片 fixture 的契约（`tests/fixtures/slice/project.json`）。
 *
 * 数据只有 1 项目 / 1 章 / 1 场景 / 2 拍 / 5 角色；假模型的脚本也放在同一文件里，
 * 保证「建库」与「假模型产出」引用同一组记忆 ID，不会出现 grounding 指向不存在
 * 的引用。
 */

const GroundingFixtureSchema = z.strictObject({
  type: z.enum(['memory', 'belief', 'fact', 'canon', 'outline', 'manuscript']),
  id: z.string().min(1),
  quote: z.string().min(1)
})

export const SliceFakeBeatSchema = z.strictObject({
  intent: z.string().min(1),
  toolCall: z
    .strictObject({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown())
    })
    .optional(),
  /** 第一次生成用 bodies[0]；重生成依次用后面的，最后一条循环。 */
  bodies: z.array(z.string().min(1)).min(1),
  grounding: z.array(GroundingFixtureSchema)
})
export type SliceFakeBeat = z.infer<typeof SliceFakeBeatSchema>

export const SliceFixtureSchema = z.strictObject({
  $comment: z.string().optional(),
  project: z.strictObject({
    title: z.string().min(1),
    genre: z.string(),
    pov: z.enum(['first', 'third_limited', 'third_omniscient']),
    targetWords: z.number().int().positive().nullable(),
    embeddingModel: z.string().min(1),
    embeddingDim: z.number().int().positive(),
    defaultPreset: z.enum(['openai', 'deepseek', 'tongyi'])
  }),
  characters: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1),
        card: z.record(z.string(), z.unknown())
      })
    )
    .length(5),
  chapter: z.strictObject({
    id: z.string().min(1),
    ord: z.number().int().positive(),
    title: z.string().min(1),
    goal: z.string(),
    coreEvent: z.string(),
    forbiddenReveals: z.array(z.string())
  }),
  scene: z.strictObject({
    id: z.string().min(1),
    ord: z.number().int().positive(),
    location: z.string().min(1),
    participants: z.array(z.string().min(1)).min(1),
    goal: z.string(),
    entry: z.string(),
    exit: z.record(z.string(), z.unknown())
  }),
  beats: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        ord: z.number().int().positive(),
        speakerType: z.enum(['character', 'narrator']),
        speakerId: z.string().min(1),
        intent: z.string(),
        maxWords: z.number().int().positive().nullable()
      })
    )
    .length(2),
  memories: z.array(
    z.strictObject({
      id: z.string().min(1),
      characterId: z.string().min(1),
      kind: z.enum(['experience', 'fact', 'relationship', 'cognition']),
      text: z.string().min(1),
      importance: z.number().min(0).max(1),
      pinned: z.number().int().min(0).max(1),
      learnedSeq: z.number().int().nonnegative()
    })
  ),
  facts: z.array(
    z.strictObject({
      id: z.string().min(1),
      subject: z.string().min(1),
      predicate: z.string().min(1),
      object: z.string().min(1),
      visibility: z.enum(['public', 'secret']),
      revealSeq: z.number().int().nonnegative().nullable(),
      validFromSeq: z.number().int().nonnegative()
    })
  ),
  fakeModel: z.strictObject({ beats: z.array(SliceFakeBeatSchema).min(1) })
})
export type SliceFixture = z.infer<typeof SliceFixtureSchema>

export function parseSliceFixture(raw: unknown): SliceFixture {
  const parsed = SliceFixtureSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('internal_error', '切片 fixture 不符合契约', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    })
  }
  return parsed.data
}

export function loadSliceFixture(file: string): SliceFixture {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new AppError('internal_error', `无法读取切片 fixture: ${file}`, {
      message: error instanceof Error ? error.message : String(error)
    })
  }
  return parseSliceFixture(raw)
}
