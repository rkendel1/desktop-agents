import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { DecisionCancellation, LocalML, LocalMLDecisionResult } from '@rust-ml-runtime/node'
import {
  JEV_VERSION, isConflictingEvidence, isUnknownEvidence, validateJevQuestion,
  type JevEvaluationContext, type JevQuestion, type JevResult, type JevRule,
  type JevRuleEvaluation, type JevRuleResult, type JevValue, type StoredJevEvaluation
} from '../shared/jev'

export interface JevModelResult {
  evaluations: JevRuleEvaluation[]
  uncertainty?: string[]
  provenance: { runtime: string; runtimeVersion?: string; model: string; modelArtifact?: string }
  inferenceMs?: number
}

/** The only boundary at which Jev may ask a model to interpret supplied evidence. */
export interface StructuredDecisionModel {
  readonly runtime?: string
  readonly model?: string
  evaluate(question: JevQuestion, signal: AbortSignal): Promise<unknown>
}

export interface JevEvaluationRepository {
  saveJevEvaluation(evaluation: StoredJevEvaluation): Promise<void>
}

export interface JevServiceOptions {
  model?: StructuredDecisionModel
  repository?: JevEvaluationRepository
  modelTimeoutMs?: number
}

function canonical(value: JevValue): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}

function input(question: JevQuestion, reference: string): JevQuestion['inputs'][number] | undefined {
  return question.inputs.find(item => item.id === reference || item.name === reference)
}

function resolvedExpected(question: JevQuestion, expected: JevValue | { input: string }): { known: boolean; value?: JevValue } {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).length === 1 && typeof expected.input === 'string') {
    const found = input(question, expected.input)
    return found && !isUnknownEvidence(found.value) && !isConflictingEvidence(found.value) ? { known: true, value: found.value } : { known: false }
  }
  return { known: true, value: expected as JevValue }
}

function deterministic(question: JevQuestion, rule: Exclude<JevRule, { type: 'semantic' }>): JevRuleEvaluation {
  const found = input(question, rule.input)
  if (!found || isUnknownEvidence(found.value) || isConflictingEvidence(found.value)) return { ruleId: rule.id, result: 'unknown', explanation: 'Required evidence is absent, unknown, or conflicting.' }
  const value = found.value
  let result: boolean
  if (rule.type === 'exists') result = true
  else if (rule.type === 'notEmpty') result = typeof value === 'string' || Array.isArray(value)
    ? value.length > 0 : value !== null && typeof value === 'object' ? Object.keys(value).length > 0 : false
  else if (rule.type === 'exactlyOne') result = Array.isArray(value) && value.length === 1
  else if (rule.type === 'equals' || rule.type === 'contains') {
    const expected = resolvedExpected(question, rule.expected)
    if (!expected.known) return { ruleId: rule.id, result: 'unknown', explanation: 'Comparison evidence is absent, unknown, or conflicting.' }
    if (rule.type === 'equals') result = canonical(value) === canonical(expected.value!)
    else if (typeof value === 'string' && typeof expected.value === 'string') result = value.includes(expected.value)
    else if (Array.isArray(value)) result = value.some(item => canonical(item) === canonical(expected.value!))
    else result = value !== null && typeof value === 'object' && typeof expected.value === 'string' && Object.hasOwn(value, expected.value)
  } else result = false
  return { ruleId: rule.id, result: result ? 'true' : 'false' }
}

function validateModelResult(value: unknown, ruleIds: string[]): JevModelResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_OUTPUT_INVALID')
  const result = value as Partial<JevModelResult>
  if (Object.keys(result).some(key => !['evaluations', 'uncertainty', 'provenance', 'inferenceMs'].includes(key))) throw new Error('MODEL_OUTPUT_INVALID')
  if (!Array.isArray(result.evaluations) || !result.provenance || typeof result.provenance !== 'object'
    || typeof result.provenance.runtime !== 'string' || typeof result.provenance.model !== 'string'
    || Object.keys(result.provenance).some(key => !['runtime', 'runtimeVersion', 'model', 'modelArtifact'].includes(key))
    || result.inferenceMs !== undefined && (!Number.isFinite(result.inferenceMs) || result.inferenceMs < 0)) throw new Error('MODEL_OUTPUT_INVALID')
  const expected = new Set(ruleIds)
  const seen = new Set<string>()
  for (const evaluation of result.evaluations) {
    if (!evaluation || typeof evaluation.ruleId !== 'string' || !expected.has(evaluation.ruleId) || seen.has(evaluation.ruleId)
      || !['true', 'false', 'unknown'].includes(evaluation.result)
      || evaluation.explanation !== undefined && (typeof evaluation.explanation !== 'string' || evaluation.explanation.length > 2_000)) throw new Error('MODEL_OUTPUT_INVALID')
    seen.add(evaluation.ruleId)
  }
  if (seen.size !== expected.size || result.uncertainty !== undefined && (!Array.isArray(result.uncertainty)
    || result.uncertainty.some(item => typeof item !== 'string' || item.length > 500))) throw new Error('MODEL_OUTPUT_INVALID')
  return result as JevModelResult
}

function statusOf(evaluations: JevRuleEvaluation[], conflict: boolean): JevResult['decision'] {
  if (conflict) return { value: null, status: 'review' }
  if (evaluations.some(item => item.result === 'false')) return { value: false, status: 'fail' }
  if (evaluations.some(item => item.result === 'unknown')) return { value: null, status: 'unknown' }
  return { value: true, status: 'pass' }
}

function abortCode(signal: AbortSignal, caller: AbortSignal): string {
  return caller.aborted ? 'MODEL_CANCELLED' : signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_FAILURE'
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}

export class JevService {
  constructor(private readonly options: JevServiceOptions = {}) {}

  async evaluate(value: unknown, context: JevEvaluationContext = {}, signal: AbortSignal = new AbortController().signal): Promise<JevResult> {
    const started = performance.now()
    const validationStarted = performance.now()
    const { question, rules } = validateJevQuestion(value)
    const validationMs = performance.now() - validationStarted
    const deterministicStarted = performance.now()
    const deterministicRules = rules.filter((rule): rule is Exclude<JevRule, { type: 'semantic' }> => rule.type !== 'semantic')
    const evaluations = deterministicRules.map(rule => deterministic(question, rule))
    const semanticRules = rules.filter((rule): rule is Extract<JevRule, { type: 'semantic' }> => rule.type === 'semantic')
    const runnable = semanticRules.filter(rule => {
      const evidence = input(question, rule.input)
      if (evidence && !isUnknownEvidence(evidence.value) && !isConflictingEvidence(evidence.value)) return true
      evaluations.push({ ruleId: rule.id, result: 'unknown', explanation: 'Required evidence is absent, unknown, or conflicting.' })
      return false
    })
    const deterministicMs = performance.now() - deterministicStarted
    let modelMs = 0
    let resultValidationMs = 0
    let modelProvenance: JevModelResult['provenance'] = { runtime: 'deterministic', model: 'none' }
    const uncertainty: string[] = []
    if (runnable.length) {
      if (!this.options.model) {
        for (const rule of runnable) evaluations.push({ ruleId: rule.id, result: 'unknown', explanation: 'No local structured decision model is available.' })
        uncertainty.push('MODEL_UNAVAILABLE')
      } else {
        modelProvenance = { runtime: this.options.model.runtime ?? 'structured-decision-model', model: this.options.model.model ?? 'configured' }
        const timeout = AbortSignal.timeout(this.options.modelTimeoutMs ?? 30_000)
        const deadline = AbortSignal.any([signal, timeout])
        const modelStarted = performance.now()
        try {
          const selected = new Set(runnable.map(rule => rule.id))
          const output = await withAbort(this.options.model.evaluate({ ...question, rules: question.rules.filter(rule => selected.has(rule.id)) }, deadline), deadline)
          const modelValidationStarted = performance.now()
          const valid = validateModelResult(output, runnable.map(rule => rule.id))
          resultValidationMs += performance.now() - modelValidationStarted
          modelMs = valid.inferenceMs ?? performance.now() - modelStarted
          modelProvenance = valid.provenance
          evaluations.push(...valid.evaluations)
          uncertainty.push(...(valid.uncertainty ?? []))
        } catch (error) {
          modelMs = performance.now() - modelStarted
          const code = error instanceof Error && error.message === 'MODEL_OUTPUT_INVALID' ? error.message
            : deadline.aborted ? abortCode(deadline, signal) : /not found|unavailable|load|model/i.test(error instanceof Error ? error.message : '') ? 'MODEL_UNAVAILABLE' : 'MODEL_FAILURE'
          for (const rule of runnable) evaluations.push({ ruleId: rule.id, result: 'unknown', explanation: code })
          uncertainty.push(code)
        }
      }
    }
    const ordered = question.rules.map(rule => evaluations.find(item => item.ruleId === rule.id)!)
    const referenced = new Map<string, Set<string>>()
    for (const rule of rules) {
      const found = input(question, rule.input)
      if (found) (referenced.get(found.id) ?? referenced.set(found.id, new Set()).get(found.id)!).add(rule.id)
      if ('expected' in rule && rule.expected && typeof rule.expected === 'object' && !Array.isArray(rule.expected) && typeof rule.expected.input === 'string') {
        const comparison = input(question, rule.expected.input)
        if (comparison) (referenced.get(comparison.id) ?? referenced.set(comparison.id, new Set()).get(comparison.id)!).add(rule.id)
      }
    }
    const conflict = question.inputs.some(item => isConflictingEvidence(item.value))
    if (conflict) uncertainty.push('CONFLICTING_EVIDENCE')
    const validationResultStarted = performance.now()
    const timestamp = new Date().toISOString()
    const result: JevResult = {
      evaluationId: randomUUID(), questionId: question.id, decision: statusOf(ordered, conflict), evaluations: ordered,
      evidence: question.inputs.map(item => ({ inputId: item.id, relevance: [...(referenced.get(item.id) ?? [])] })),
      uncertainty: [...new Set(uncertainty)],
      provenance: { jevVersion: JEV_VERSION, ...modelProvenance, questionId: question.id, ...context, timestamp },
      metrics: { validationMs, deterministicMs, modelMs, resultValidationMs: resultValidationMs + performance.now() - validationResultStarted, persistenceMs: 0, totalMs: 0 }
    }
    const persistenceStarted = performance.now()
    if (this.options.repository) await this.options.repository.saveJevEvaluation({ question, result, context })
    result.metrics.persistenceMs = performance.now() - persistenceStarted
    result.metrics.totalMs = performance.now() - started
    return result
  }
}

/** Python-free, in-process adapter for the public rust-ml-runtime Node package. */
export class RustStructuredDecisionModel implements StructuredDecisionModel {
  readonly runtime = 'rust-ml-runtime'
  private local?: Promise<LocalML>
  constructor(readonly model = 'laya', private readonly confidenceThreshold = 0.65) {}

  private load(): Promise<LocalML> {
    return this.local ??= import('@rust-ml-runtime/node').then(module => module.LocalML.create())
  }

  async evaluate(question: JevQuestion, signal: AbortSignal): Promise<JevModelResult> {
    signal.throwIfAborted()
    const runtime = await this.load()
    signal.throwIfAborted()
    const module = await import('@rust-ml-runtime/node')
    const cancellation: DecisionCancellation = new module.DecisionCancellation()
    const cancel = () => cancellation.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancellation.cancel()
    try {
      const instructions = new Map(question.rules.map(rule => {
        const parsed = validateJevQuestion({ ...question, rules: [rule] }).rules[0]!
        if (parsed.type !== 'semantic') throw new Error('MODEL_OUTPUT_INVALID')
        return [rule.id, parsed.instructions] as const
      }))
      const output: LocalMLDecisionResult = await runtime.decideAsync({
        model: this.model,
        input: { subject: question.subject, question: question.question, inputs: question.inputs },
        decisions: question.rules.map(rule => ({
          name: rule.id,
          instructions: `Using only the supplied structured input, answer this rule. Do not infer missing facts: ${instructions.get(rule.id)}`,
          kind: { type: 'noul', false_description: null, true_description: null }
        })),
        cancellation
      })
      const evaluations = output.decisions.map(decision => {
        if (decision.value.type !== 'noul' || typeof decision.value.value !== 'boolean' || !Number.isFinite(decision.confidence)) throw new Error('MODEL_OUTPUT_INVALID')
        const result: JevRuleResult = decision.confidence < this.confidenceThreshold ? 'unknown' : decision.value.value ? 'true' : 'false'
        return { ruleId: decision.name, result }
      })
      return {
        evaluations,
        uncertainty: evaluations.filter(item => item.result === 'unknown').map(item => `LOW_CONFIDENCE:${item.ruleId}`),
        provenance: { runtime: output.backend, runtimeVersion: output.provenance.runtime_version,
          model: output.model.revision ? `${output.model.identifier}@${output.model.revision}` : output.model.identifier,
          modelArtifact: output.provenance.artifact_sha256 },
        inferenceMs: output.execution.latency.secs * 1_000 + output.execution.latency.nanos / 1_000_000
      }
    } finally { signal.removeEventListener('abort', cancel) }
  }
}
