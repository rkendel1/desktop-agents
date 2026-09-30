export const JEV_VERSION = '1.0.0'
export const JEV_UNKNOWN = { status: 'unknown' } as const

export type JevScalar = string | number | boolean | null
export type JevValue = JevScalar | JevValue[] | { [key: string]: JevValue }
export type JevRuleResult = 'true' | 'false' | 'unknown'
export type JevDecisionStatus = 'pass' | 'fail' | 'review' | 'unknown'

export interface JevQuestion {
  id: string
  subject: { kind: string; id?: string }
  question: string
  inputs: Array<{ id: string; name: string; value: JevValue }>
  rules: Array<{ id: string; expression: string }>
  requestedDecision: 'pass-fail-review'
}

export interface JevEvaluationContext {
  sourceAgentId?: string
  sourceSessionId?: string
  projectId?: string
  invariantId?: string
}

export interface JevRuleEvaluation {
  ruleId: string
  result: JevRuleResult
  explanation?: string
}

export interface JevResult {
  evaluationId: string
  questionId: string
  decision: { value: boolean | null; status: JevDecisionStatus }
  evaluations: JevRuleEvaluation[]
  evidence: Array<{ inputId: string; relevance: string[] }>
  uncertainty: string[]
  provenance: {
    jevVersion: string
    runtime: string
    runtimeVersion?: string
    model: string
    modelArtifact?: string
    questionId: string
    sourceAgentId?: string
    sourceSessionId?: string
    projectId?: string
    invariantId?: string
    timestamp: string
  }
  metrics: {
    validationMs: number
    deterministicMs: number
    modelMs: number
    resultValidationMs: number
    persistenceMs: number
    totalMs: number
  }
}

export interface StoredJevEvaluation {
  question: JevQuestion
  result: JevResult
  context: JevEvaluationContext
}

export interface ArchitectureInvariant {
  id: string
  subject: { kind: string; id?: string }
  question: string
  rules: Array<{ id: string; expression: string }>
}

/** Converts an existing invariant plus caller-collected evidence; it performs no discovery. */
export function architectureInvariantQuestion(invariant: ArchitectureInvariant, inputs: JevQuestion['inputs']): JevQuestion {
  return { id: `${invariant.id}.${Date.now()}`, subject: invariant.subject, question: invariant.question,
    inputs: structuredClone(inputs), rules: structuredClone(invariant.rules), requestedDecision: 'pass-fail-review' }
}

export type JevRule =
  | { id: string; type: 'exists' | 'notEmpty' | 'exactlyOne'; input: string }
  | { id: string; type: 'equals' | 'contains'; input: string; expected: JevValue | { input: string } }
  | { id: string; type: 'semantic'; input: string; instructions: string }

export class JevValidationError extends Error {
  readonly code = 'JEV_QUESTION_INVALID'
  constructor(readonly issues: string[]) {
    super(`Invalid Jev question: ${issues.join('; ')}`)
    this.name = 'JevValidationError'
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_QUESTION_BYTES = 256 * 1024

function splitArguments(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
    } else if (character === '"') quote = character
    else if (character === '[' || character === '{') depth++
    else if (character === ']' || character === '}') depth--
    else if (character === ',' && depth === 0) { parts.push(source.slice(start, index).trim()); start = index + 1 }
    if (depth < 0) throw new Error('unbalanced expression')
  }
  if (quote || depth !== 0) throw new Error('unbalanced expression')
  parts.push(source.slice(start).trim())
  return parts
}

function valueArgument(value: string): JevValue | { input: string } {
  if (ID.test(value) && !['true', 'false', 'null'].includes(value)) return { input: value }
  const parsed = JSON.parse(value) as unknown
  if (!isJevValue(parsed)) throw new Error('invalid literal')
  return parsed
}

export function parseJevRule(rule: JevQuestion['rules'][number]): JevRule {
  const match = /^([A-Za-z][A-Za-z0-9]*)\((.*)\)$/.exec(rule.expression.trim())
  if (!match) throw new Error('malformed expression')
  const type = match[1]!
  const args = splitArguments(match[2]!)
  if (['exists', 'notEmpty', 'exactlyOne'].includes(type)) {
    if (args.length !== 1 || !ID.test(args[0]!)) throw new Error(`${type} expects one input identifier`)
    return { id: rule.id, type: type as 'exists' | 'notEmpty' | 'exactlyOne', input: args[0]! }
  }
  if (['equals', 'contains'].includes(type)) {
    if (args.length !== 2 || !ID.test(args[0]!)) throw new Error(`${type} expects an input identifier and value`)
    return { id: rule.id, type: type as 'equals' | 'contains', input: args[0]!, expected: valueArgument(args[1]!) }
  }
  if (type === 'semantic') {
    if (args.length !== 2 || !ID.test(args[0]!)) throw new Error('semantic expects an input identifier and quoted instructions')
    const instructions = JSON.parse(args[1]!) as unknown
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 2_000) throw new Error('semantic instructions must be a non-empty string')
    return { id: rule.id, type, input: args[0]!, instructions: instructions.trim() }
  }
  throw new Error(`unknown rule type ${type || '(empty)'}`)
}

export function isJevValue(value: unknown, depth = 0): value is JevValue {
  if (depth > 16) return false
  if (value === null || ['string', 'boolean'].includes(typeof value)) return typeof value !== 'string' || value.length <= 32_000
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(item => isJevValue(item, depth + 1))
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  const entries = Object.entries(value)
  return entries.length <= 1_000 && entries.every(([key, item]) => key.length <= 200 && isJevValue(item, depth + 1))
}

export function validateJevQuestion(value: unknown): { question: JevQuestion; rules: JevRule[] } {
  const issues: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JevValidationError(['question must be an object'])
  const question = value as Partial<JevQuestion>
  if (Object.keys(question).some(key => !['id', 'subject', 'question', 'inputs', 'rules', 'requestedDecision'].includes(key))) issues.push('question contains unsupported fields')
  if (typeof question.id !== 'string' || !ID.test(question.id)) issues.push('id is required and must be a stable identifier')
  if (!question.subject || typeof question.subject !== 'object' || Array.isArray(question.subject)
    || typeof question.subject.kind !== 'string' || !question.subject.kind.trim() || question.subject.kind.length > 100
    || question.subject.id !== undefined && (typeof question.subject.id !== 'string' || !ID.test(question.subject.id))
    || Object.keys(question.subject).some(key => !['kind', 'id'].includes(key))) issues.push('subject is invalid')
  if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 10_000) issues.push('question is required')
  if (!Array.isArray(question.inputs) || question.inputs.length > 128) issues.push('inputs must be an array of at most 128 items')
  if (!Array.isArray(question.rules) || !question.rules.length || question.rules.length > 128) issues.push('rules must contain 1 to 128 items')
  if (question.requestedDecision !== 'pass-fail-review') issues.push('requestedDecision is unsupported')
  const inputIds = new Set<string>()
  const inputNames = new Set<string>()
  if (Array.isArray(question.inputs)) question.inputs.forEach((input, index) => {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !ID.test(input.id)
      || typeof input.name !== 'string' || !ID.test(input.name) || !isJevValue(input.value)
      || Object.keys(input).some(key => !['id', 'name', 'value'].includes(key))) issues.push(`input ${index} is invalid`)
    else {
      if (inputIds.has(input.id)) issues.push(`duplicate input id ${input.id}`)
      if (inputNames.has(input.name)) issues.push(`duplicate input name ${input.name}`)
      inputIds.add(input.id); inputNames.add(input.name)
    }
  })
  const ruleIds = new Set<string>()
  const parsed: JevRule[] = []
  if (Array.isArray(question.rules)) question.rules.forEach((rule, index) => {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !ID.test(rule.id)
      || typeof rule.expression !== 'string' || rule.expression.length > 4_000
      || Object.keys(rule).some(key => !['id', 'expression'].includes(key))) { issues.push(`rule ${index} is invalid`); return }
    if (ruleIds.has(rule.id)) issues.push(`duplicate rule id ${rule.id}`)
    ruleIds.add(rule.id)
    try { parsed.push(parseJevRule(rule)) } catch (error) { issues.push(`rule ${rule.id}: ${error instanceof Error ? error.message : 'invalid expression'}`) }
  })
  try { if (JSON.stringify(value).length > MAX_QUESTION_BYTES) issues.push('question exceeds 256 KiB') } catch { issues.push('question is not serializable') }
  if (issues.length) throw new JevValidationError(issues)
  return { question: structuredClone(question) as JevQuestion, rules: parsed }
}

export function isUnknownEvidence(value: JevValue): boolean {
  return value === null || value === 'unknown' || (!Array.isArray(value) && value !== null && typeof value === 'object' && value.status === 'unknown')
}

export function isConflictingEvidence(value: JevValue): boolean {
  return !Array.isArray(value) && value !== null && typeof value === 'object' && value.status === 'conflicting'
}
