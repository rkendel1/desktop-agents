import { expect, it, vi } from 'vitest'
import { createJevTool } from './jevTools'
import { JevService } from './jev'
import type { JevQuestion, StoredJevEvaluation } from '../shared/jev'

it('lets an agent call the same constrained Jev service with durable source context', async () => {
  const saved: StoredJevEvaluation[] = []
  const repository = { saveJevEvaluation: vi.fn(async (evaluation: StoredJevEvaluation) => { saved.push(evaluation) }) }
  const tool = createJevTool(new JevService({ repository }), async () => ({ sourceAgentId: 'forge', sourceSessionId: 'session', projectId: 'project' }))
  const question: JevQuestion = { id: 'agent-review', subject: { kind: 'implementation' }, question: 'Are checks present?',
    inputs: [{ id: 'checks', name: 'checks', value: ['typecheck'] }], rules: [{ id: 'checks-exist', expression: 'notEmpty(checks)' }], requestedDecision: 'pass-fail-review' }
  const response = await tool.execute('call', { question } as never, new AbortController().signal)
  expect(JSON.parse((response.content[0] as { type: 'text'; text: string }).text)).toMatchObject({ decision: { status: 'pass' }, provenance: { sourceAgentId: 'forge', sourceSessionId: 'session', projectId: 'project' } })
  expect(repository.saveJevEvaluation).toHaveBeenCalledTimes(1)
  expect(saved[0]?.question).toEqual(question)
})
