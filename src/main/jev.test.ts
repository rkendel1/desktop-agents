import { describe, expect, it, vi } from 'vitest'
import { JevService, type StructuredDecisionModel } from './jev'
import { createTestDesktop } from './testSupport'
import type { JevQuestion } from '../shared/jev'

const question = (rules: JevQuestion['rules'], inputs: JevQuestion['inputs'] = [
  { id: 'stores', name: 'stores', value: ['FeltDB'] },
  { id: 'name', name: 'name', value: 'Foundry' },
  { id: 'expected', name: 'expected', value: 'Foundry' }
]): JevQuestion => ({ id: 'foundry-authority', subject: { kind: 'architecture', id: 'foundry' },
  question: 'Does Foundry satisfy the supplied rules?', inputs, rules, requestedDecision: 'pass-fail-review' })

const model = (result: unknown): StructuredDecisionModel => ({ evaluate: vi.fn(async () => result) })

describe('Jev deterministic evaluation', () => {
  it('evaluates equals, exactlyOne, exists, contains and notEmpty without a model', async () => {
    const rules = [
      { id: 'equals', expression: 'equals(name, expected)' }, { id: 'one', expression: 'exactlyOne(stores)' },
      { id: 'exists', expression: 'exists(name)' }, { id: 'contains', expression: 'contains(stores, "FeltDB")' },
      { id: 'not-empty', expression: 'notEmpty(name)' }
    ]
    const unused = model({})
    const result = await new JevService({ model: unused }).evaluate(question(rules))
    expect(result.decision.status).toBe('pass')
    expect(result.evaluations.map(item => item.result)).toEqual(['true', 'true', 'true', 'true', 'true'])
    expect(unused.evaluate).not.toHaveBeenCalled()
    expect(result.provenance).toMatchObject({ runtime: 'deterministic', model: 'none', questionId: 'foundry-authority' })
  })

  it('fails a false deterministic rule', async () => {
    const result = await new JevService().evaluate(question([{ id: 'one', expression: 'exactlyOne(stores)' }], [{ id: 'stores', name: 'stores', value: ['FeltDB', 'SQLite'] }]))
    expect(result.decision).toEqual({ value: false, status: 'fail' })
  })

  it('returns UNKNOWN for absent and explicitly unknown evidence without invoking a model', async () => {
    const local = model({})
    const absent = await new JevService({ model: local }).evaluate(question([{ id: 'exists', expression: 'exists(gitStatus)' }]))
    const unknown = await new JevService({ model: local }).evaluate(question([{ id: 'semantic', expression: 'semantic(testsPassed, "The tests passed")' }], [{ id: 'tests', name: 'testsPassed', value: { status: 'unknown' } }]))
    expect(absent.decision.status).toBe('unknown')
    expect(unknown.decision.status).toBe('unknown')
    expect(local.evaluate).not.toHaveBeenCalled()
  })

  it('returns REVIEW for explicitly conflicting evidence', async () => {
    const result = await new JevService().evaluate(question([{ id: 'exists', expression: 'exists(status)' }], [
      { id: 'status', name: 'status', value: { status: 'conflicting', values: ['clean', 'dirty'] } }
    ]))
    expect(result.decision.status).toBe('review')
    expect(result.uncertainty).toContain('CONFLICTING_EVIDENCE')
  })
})

describe('Jev local model path', () => {
  const semantic = question([{ id: 'meaning', expression: 'semantic(name, "The name identifies a software product")' }])
  const valid = { evaluations: [{ ruleId: 'meaning', result: 'true' }], uncertainty: [],
    provenance: { runtime: 'coreml', runtimeVersion: '0.2.3', model: 'laya', modelArtifact: 'sha256' }, inferenceMs: 12 }

  it('invokes the local model and accepts only structured output', async () => {
    const local = model(valid)
    const result = await new JevService({ model: local }).evaluate(semantic)
    expect(local.evaluate).toHaveBeenCalledTimes(1)
    expect(result.decision.status).toBe('pass')
    expect(result.provenance).toMatchObject({ runtime: 'coreml', runtimeVersion: '0.2.3', model: 'laya' })
  })

  it.each([
    ['malformed output', model({ prose: 'yes' }), 'MODEL_OUTPUT_INVALID'],
    ['model failure', { evaluate: async () => { throw new Error('native failure') } }, 'MODEL_FAILURE'],
    ['missing model', undefined, 'MODEL_UNAVAILABLE']
  ] as const)('fails closed for %s', async (_name, local, code) => {
    const result = await new JevService({ ...(local ? { model: local } : {}) }).evaluate(semantic)
    expect(result.decision.status).toBe('unknown')
    expect(result.uncertainty).toContain(code)
  })

  it('fails closed on model timeout', async () => {
    const local: StructuredDecisionModel = { evaluate: () => new Promise(() => undefined) }
    const result = await new JevService({ model: local, modelTimeoutMs: 5 }).evaluate(semantic)
    expect(result.uncertainty).toContain('MODEL_TIMEOUT')
  })

  it('fails closed on caller cancellation', async () => {
    const local: StructuredDecisionModel = { evaluate: () => new Promise(() => undefined) }
    const abort = new AbortController()
    const pending = new JevService({ model: local }).evaluate(semantic, {}, abort.signal)
    abort.abort()
    expect((await pending).uncertainty).toContain('MODEL_CANCELLED')
  })
})

it('persists evaluation, evidence, decision, context and provenance through FeltDB across restart', async () => {
  const desktop = await createTestDesktop()
  const context = { sourceAgentId: 'forge', sourceSessionId: 'session-1', projectId: 'project-1', invariantId: 'single-authority' }
  const result = await new JevService({ repository: desktop.repository }).evaluate(question([{ id: 'one', expression: 'exactlyOne(stores)' }]), context)
  expect((await desktop.repository.jevEvaluation(result.evaluationId))?.result.provenance).toMatchObject(context)
  const reopened = await desktop.restart()
  const stored = await reopened.jevEvaluation(result.evaluationId)
  expect(stored?.question.inputs[0]?.value).toEqual(['FeltDB'])
  expect(stored?.result.decision.status).toBe('pass')
  expect((await reopened.jevEvaluations('project-1')).map(item => item.result.evaluationId)).toContain(result.evaluationId)
})
