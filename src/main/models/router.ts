import { budgetLabel, type ModelAttempt, type ModelCandidate, type ModelDecision, type ModelId, type ModelPolicy, type ModelRejection, type ModelRequest, type ModelRequirements, type PermanentFailure, type RetryReason } from '../../shared/modelFabric'
import { budgetRejection } from './access'
import type { HealthLedger, Outcome, RankingSignals } from './health'

// ───────────────────────────── planning: which candidates, in what order ─────────────────────────────

export interface RoutePlan { ranked: ModelCandidate[]; rejected: ModelRejection[]; considered: ModelId[] }

function capabilityRejection(candidate: ModelCandidate, requirements: ModelRequirements): ModelRejection | undefined {
  const c = candidate.capabilities
  const miss = (reason: string, detail?: string): ModelRejection => ({ model: candidate.id, stage: 'capability', reason, ...(detail ? { detail } : {}) })
  if (!c.chat) return miss('no-chat')
  if (requirements.coding && !c.coding) return miss('no-coding')
  if (requirements.reasoning && !c.reasoning) return miss('no-reasoning')
  if (requirements.vision && !c.vision) return miss('no-vision')
  if (requirements.toolUse && !c.toolUse) return miss('no-tool-use')
  if (requirements.structuredOutput && !c.structuredOutput) return miss('no-structured-output')
  if (requirements.minimumContextTokens !== undefined) {
    const context = c.contextTokens ?? candidate.limits.contextTokens
    // A model that does not state its context window is not assumed to have enough.
    if (context === undefined) return miss('unknown-context', `needs ${requirements.minimumContextTokens} tokens`)
    if (context < requirements.minimumContextTokens) return miss('context-too-small', `${context} < ${requirements.minimumContextTokens}`)
  }
  return undefined
}

const smooth = (successes: number, attempts: number): number => (successes + 1) / (attempts + 2)
const round = (value: number): number => Math.round(value * 1000) / 1000

/** Higher is better. Built only from observed outcomes; a model with no history sits at the neutral 0.5. */
function quality(signals: RankingSignals, requirements: ModelRequirements): number {
  const parts = [smooth(signals.successes, signals.requests)]
  if (requirements.toolUse) parts.push(smooth(signals.toolCallSuccesses, signals.toolCalls))
  if (requirements.structuredOutput) parts.push(smooth(signals.structuredOutputSuccesses, signals.structuredOutputs))
  return parts.reduce((sum, value) => sum + value, 0) / parts.length
}

/**
 * Choose and order the candidates for one request. Pure: the same candidates, request, policy and ledger signals always give the
 * same plan (ties end at the model id). Stages, in order:
 *
 *   1 policy → 2 capability → 3 availability → 4 health → then rank by
 *   task affinity → observed quality → recent failures → latency → id
 */
export function planRoute(input: { request: ModelRequest; policy: ModelPolicy; candidates: readonly ModelCandidate[]; ledger: HealthLedger; now: number }): RoutePlan {
  const { request, policy, ledger, now } = input
  const rejected: ModelRejection[] = []
  const considered = [...input.candidates].sort((a, b) => a.id.localeCompare(b.id))
  const survivors: ModelCandidate[] = []
  for (const candidate of considered) {
    const rejection = budgetRejection(candidate, policy, now) ?? capabilityRejection(candidate, request.requirements) ?? availabilityRejection(candidate, ledger)
    if (rejection) rejected.push(rejection); else survivors.push(candidate)
  }
  const keyed = survivors.map(candidate => {
    const signals = ledger.signals(candidate.id, request.taskClass)
    return { candidate, affinity: round(smooth(signals.taskSuccesses, signals.taskAttempts)), quality: round(quality(signals, request.requirements)), failures: signals.recentFailures, latency: signals.p50LatencyMs === undefined ? Infinity : Math.round(signals.p50LatencyMs / 50) }
  })
  keyed.sort((a, b) => b.affinity - a.affinity || b.quality - a.quality || a.failures - b.failures || a.latency - b.latency || a.candidate.id.localeCompare(b.candidate.id))
  return { ranked: keyed.map(item => item.candidate), rejected, considered: considered.map(candidate => candidate.id) }
}

function availabilityRejection(candidate: ModelCandidate, ledger: HealthLedger): ModelRejection | undefined {
  if (candidate.availability.state !== 'available') return { model: candidate.id, stage: 'availability', reason: candidate.availability.state, ...(candidate.availability.reason ? { detail: candidate.availability.reason } : {}) }
  const exclusion = ledger.exclusion(candidate.id)
  if (exclusion) return { model: candidate.id, stage: 'health', reason: exclusion.state, detail: `${exclusion.reason} (until ${new Date(exclusion.until).toISOString()})` }
  return undefined
}

// ───────────────────────────── failures: which are worth another model ─────────────────────────────

export interface ClassifiedError { retry?: RetryReason; permanent?: PermanentFailure; retryAfterMs?: number }

/**
 * A failure is retried on another model only when it is transient: the provider is limiting, out of capacity, slow, or briefly broken.
 * Authentication, a bad request, a policy violation, an unsupported capability or a malformed tool call would fail the same way again —
 * unless the provider’s adapter says otherwise, they are final.
 */
export function classifyError(error: unknown): ClassifiedError {
  const source = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; retryAfterMs?: unknown; transient?: unknown } | undefined
  const message = String(source?.message ?? error ?? '')
  const status = Number(source?.status ?? source?.statusCode ?? /(?:\b(?:HTTP|status(?: code)?|error|code)\b[ :=]*|^)([45]\d\d)\b/i.exec(message)?.[1] ?? NaN)
  const code = String(source?.code ?? '')
  const retryAfterMs = typeof source?.retryAfterMs === 'number' ? source.retryAfterMs : undefined
  const done = (partial: ClassifiedError): ClassifiedError => ({ ...partial, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
  if (status === 402 || /payment required|insufficient (?:credit|funds|balance)|billing/i.test(message)) return { permanent: 'policy-violation' }
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|incorrect api key|authentication|permission denied|forbidden/i.test(message)) return { permanent: 'authentication' }
  if (/tool.?call|function.?call/i.test(message) && /invalid|malformed|parse/i.test(message)) return { permanent: 'malformed-tool-call' }
  if (/context.?length|maximum context|too many tokens|prompt is too long|does not support|not support/i.test(message)) return { permanent: 'unsupported-capability' }
  if (status === 429 || /rate.?limit|too many requests|quota|resource.?exhausted/i.test(message)) return done({ retry: 'rate-limited' })
  if (status === 408 || status === 504 || /ETIMEDOUT|ESOCKETTIMEDOUT|timed?[ -]?out|timeout/i.test(`${code} ${message}`)) return done({ retry: 'timeout' })
  if (status === 503 || status === 529 || /overloaded|at capacity|capacity|service unavailable|temporarily unavailable|\bbusy\b/i.test(message)) return done({ retry: 'capacity-unavailable' })
  if (status === 500 || status === 502 || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|network error|bad gateway|internal server error/i.test(`${code} ${message}`)) return done({ retry: 'temporary-provider-error' })
  if (status === 400 || status === 404 || status === 422 || /invalid|malformed|bad request|unprocessable|not found/i.test(message)) return { permanent: 'invalid-request' }
  return source?.transient === true ? done({ retry: 'temporary-provider-error' }) : { permanent: 'other' }
}

// ───────────────────────────── the cost gate at the point of invocation ─────────────────────────────

/** Thrown when a candidate that the policy forbids reaches the invocation point. It is a bug in the caller, and nothing is sent. */
export class CostPolicyViolation extends Error {
  constructor(readonly candidate: ModelId, readonly reason: string) { super(`Refusing to call ${candidate}: ${reason} under this cost policy.`); this.name = 'CostPolicyViolation' }
}

/**
 * The invariant: under `free-only`, a paid, unknown or stale candidate must not reach `provider.invoke()`. The plan already excludes
 * such candidates; this check does not trust the plan. It runs the same policy on the candidate in hand, immediately before the call.
 */
export function guardInvocation(candidate: ModelCandidate, policy: ModelPolicy, now: number): void {
  const rejection = budgetRejection(candidate, policy, now)
  if (rejection) throw new CostPolicyViolation(candidate.id, `${rejection.reason}${rejection.detail ? ` (${rejection.detail})` : ''}`)
}

// ───────────────────────────── cycling ─────────────────────────────

export class ModelRoutingError extends Error {
  constructor(message: string, readonly decision: ModelDecision, readonly cause?: unknown) { super(message); this.name = 'ModelRoutingError' }
}

export const NO_ELIGIBLE_MESSAGE = 'Foundry couldn’t complete this request. All currently available free models are unavailable or rate limited. No paid model was used. Try again shortly.'

export interface RouteInput<T> {
  request: ModelRequest
  policy: ModelPolicy
  candidates: readonly ModelCandidate[]
  ledger: HealthLedger
  now: () => number
  /** Call the model. Resolves when the model has answered (or, for a stream, has started to). */
  invoke: (candidate: ModelCandidate) => Promise<{ value: T; outcome?: Partial<Outcome> }>
  /** A provider adapter’s own reading of an error, when it knows better than the general rules. */
  classify?: (candidate: ModelCandidate, error: unknown) => ClassifiedError | undefined
  signal?: AbortSignal
}

const summary = (policy: ModelPolicy): string => `${budgetLabel(policy.budget)} · ${policy.budget.kind === 'free-only' ? '$0 maximum' : 'no cost limit'}`

/**
 * Try the ranked candidates in order. A retryable failure puts the model in cooldown and moves on; a final failure stops (the same
 * request would fail again); when every eligible model is spent the request fails cleanly — it never widens the policy to find one.
 */
export async function routeWithFallback<T>(input: RouteInput<T>): Promise<{ value: T; decision: ModelDecision }> {
  const { request, policy, ledger } = input
  const plan = planRoute({ request, policy, candidates: input.candidates, ledger, now: input.now() })
  const attempts: ModelAttempt[] = []
  const decision = (outcome: ModelDecision['outcome'], selected?: ModelId, failure?: string): ModelDecision => ({ requestId: request.requestId, taskClass: request.taskClass, requirements: request.requirements, policy: policy.budget,
    ...(selected ? { selected } : {}), candidatesConsidered: plan.considered, rejected: plan.rejected, ranked: plan.ranked.map(candidate => candidate.id), attempts, selectedAt: input.now(), outcome, costPolicy: summary(policy), ...(failure ? { failure } : {}) })
  if (!plan.ranked.length) throw new ModelRoutingError(NO_ELIGIBLE_MESSAGE, decision('no-eligible-model', undefined, 'no eligible model'))

  let last: unknown
  for (const [index, candidate] of plan.ranked.entries()) {
    input.signal?.throwIfAborted()
    guardInvocation(candidate, policy, input.now())   // independent of the plan
    const startedAt = input.now()
    try {
      const { value, outcome } = await input.invoke(candidate)
      const latencyMs = input.now() - startedAt
      ledger.success(candidate.id, { latencyMs, taskClass: request.taskClass, ...outcome })
      attempts.push({ model: candidate.id, startedAt, latencyMs, outcome: 'success', retried: false })
      return { value, decision: decision('succeeded', candidate.id) }
    } catch (error) {
      if (input.signal?.aborted) throw error
      if (error instanceof CostPolicyViolation) throw error
      last = error
      const latencyMs = input.now() - startedAt
      const classified = input.classify?.(candidate, error) ?? classifyError(error)
      const text = error instanceof Error ? error.message : String(error)
      if (classified.retry) ledger.retryable(candidate.id, classified.retry, { latencyMs, taskClass: request.taskClass }, text, classified.retryAfterMs)
      else ledger.permanent(candidate.id, classified.permanent ?? 'other', { latencyMs, taskClass: request.taskClass }, text)
      const more = index < plan.ranked.length - 1
      const retried = Boolean(classified.retry) && policy.failover && more
      attempts.push({ model: candidate.id, startedAt, latencyMs, outcome: 'failed', ...(classified.retry ? { retryReason: classified.retry } : {}), ...(classified.permanent ? { permanent: classified.permanent } : {}), error: text.slice(0, 300), retried })
      if (!classified.retry) throw new ModelRoutingError(`The request failed on ${candidate.id} and would fail the same way on another model: ${text}`, decision('failed', undefined, text), error)
      if (!policy.failover) throw new ModelRoutingError(`${candidate.id} failed (${classified.retry}) and automatic fail-over is off: ${text}`, decision('failed', undefined, text), error)
    }
  }
  throw new ModelRoutingError(NO_ELIGIBLE_MESSAGE, decision('no-eligible-model', undefined, last instanceof Error ? last.message : String(last)), last)
}
