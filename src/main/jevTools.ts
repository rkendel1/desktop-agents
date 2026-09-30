import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { JevService } from './jev'
import type { JevEvaluationContext } from '../shared/jev'

const parameters = Type.Object({
  question: Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    subject: Type.Object({ kind: Type.String({ minLength: 1, maxLength: 100 }), id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    question: Type.String({ minLength: 1, maxLength: 10000 }),
    inputs: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), name: Type.String({ minLength: 1, maxLength: 128 }), value: Type.Unknown() }), { maxItems: 128 }),
    rules: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), expression: Type.String({ minLength: 1, maxLength: 4000 }) }), { minItems: 1, maxItems: 128 }),
    requestedDecision: Type.Literal('pass-fail-review')
  })
})

/** A narrow capability tool: callers supply evidence; the tool cannot discover or mutate reality. */
export function createJevTool(service: JevService, context: () => Promise<JevEvaluationContext>): AgentTool {
  const tool: AgentTool<typeof parameters> = {
    name: 'evaluate_structured_evidence',
    label: 'Evaluate structured evidence',
    description: 'Ask Jev for a structured PASS/FAIL/REVIEW/UNKNOWN decision over explicit inputs and rules. Jev does not inspect files, run tools, browse, or collect evidence. Supported deterministic rules: exists(input), equals(input,value), contains(input,value), notEmpty(input), exactlyOne(input). semantic(input,"criterion") uses the offline local model only when the supplied evidence is known.',
    parameters,
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted()
      const result = await service.evaluate((args as { question: unknown }).question, await context(), signal)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    }
  }
  return tool as AgentTool
}
