import { z } from 'zod'
import { AppError } from '../../../shared/domain/app-error'
import { defineTool } from '../define'
import { AUDIT, degradeFor, limitsFor } from './shared'

/** T42：作者交互（PRD §4.10.5）。自动模式 / 批处理中拒绝。 */

const authorRequestChoice = defineTool({
  toolId: 'T42',
  name: 'author.request_choice',
  version: '1.0.0',
  family: 'interaction',
  summary: '向作者提出带 2–4 个选项的问题并等待选择；自动模式与批处理中不可用',
  actors: ['planner'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['mode'],
  input: z.strictObject({
    question: z.string().min(2).max(300),
    options: z
      .array(z.strictObject({ id: z.string().min(1).max(40), label: z.string().min(1).max(80) }))
      .min(2)
      .max(4)
  }),
  output: z.strictObject({ choice: z.strictObject({ id: z.string(), label: z.string() }) }),
  limits: limitsFor('interaction'),
  degrade: degradeFor('interaction'),
  audit: AUDIT,
  milestone: 'M0',
  handler: async (args, ctx, services) => {
    if (ctx.mode !== 'interactive') {
      throw new AppError('invalid_args', 'author.request_choice 只在交互会话可用')
    }
    if (!services.choices) {
      throw new AppError('tool_unavailable', '没有挂载作者选择通道')
    }
    const choice = await services.choices.ask(args.question, args.options)
    if (!choice) throw new AppError('invalid_args', '作者取消了选择')
    return { data: { choice: { id: choice.id, label: choice.label } } }
  }
})

export const INTERACTION_TOOLS = [authorRequestChoice]
