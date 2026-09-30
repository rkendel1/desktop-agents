import { describe, expect, it } from 'vitest'
import { JevValidationError, architectureInvariantQuestion, parseJevRule, validateJevQuestion, type JevQuestion } from './jev'

const valid = (): JevQuestion => ({
  id: 'question-1', subject: { kind: 'architecture', id: 'foundry' }, question: 'Is the invariant satisfied?',
  inputs: [{ id: 'stores-input', name: 'stores', value: ['FeltDB'] }],
  rules: [{ id: 'one-store', expression: 'exactlyOne(stores)' }], requestedDecision: 'pass-fail-review'
})

describe('Jev question schema', () => {
  it('accepts a bounded structured question and parses its rule', () => {
    expect(validateJevQuestion(valid()).rules).toEqual([{ id: 'one-store', type: 'exactlyOne', input: 'stores' }])
  })

  it.each([
    ['missing subject', (question: JevQuestion) => { delete (question as Partial<JevQuestion>).subject }],
    ['missing inputs', (question: JevQuestion) => { delete (question as Partial<JevQuestion>).inputs }],
    ['invalid input', (question: JevQuestion) => { question.inputs[0]!.value = Number.NaN }],
    ['invalid decision', (question: JevQuestion) => { (question as { requestedDecision: string }).requestedDecision = 'free-form' }],
    ['unknown rule', (question: JevQuestion) => { question.rules[0]!.expression = 'browse(stores)' }],
    ['malformed rule', (question: JevQuestion) => { question.rules[0]!.expression = 'exactlyOne(' }],
    ['invalid schema', (question: JevQuestion) => { (question as JevQuestion & { chat: boolean }).chat = true }]
  ] as const)('rejects %s', (_name, change) => {
    const question = valid(); change(question)
    expect(() => validateJevQuestion(question)).toThrow(JevValidationError)
  })

  it('parses literals and references without evaluating source text', () => {
    expect(parseJevRule({ id: 'equal', expression: 'equals(actual, expected)' })).toMatchObject({ expected: { input: 'expected' } })
    expect(parseJevRule({ id: 'contains', expression: 'contains(names, "FeltDB")' })).toMatchObject({ expected: 'FeltDB' })
  })

  it('constructs an invariant question only from supplied invariant and evidence', () => {
    const question = architectureInvariantQuestion({ id: 'single-authority', subject: { kind: 'architecture' }, question: 'One authority?', rules: valid().rules }, valid().inputs)
    expect(question.inputs).toEqual(valid().inputs)
    expect(question.requestedDecision).toBe('pass-fail-review')
  })
})
