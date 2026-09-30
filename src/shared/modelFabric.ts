/**
 * The model fabric's vocabulary. Provider-neutral: nothing here names a provider or a model.
 *
 *   Foundry → Model Router → (Registry · Health · Quotas) → Candidate pool → Provider → Model
 *
 * A `ModelCandidate` is what discovery learned about one model; `ModelAccess` says *why* it may be used (or not). Cost is a policy
 * question answered before any provider is reached: under `free-only`, only `local`, `free`, `beta` and `trial` candidates whose
 * classification is still fresh are eligible, and everything else — paid, user-authorized, unknown, stale — fails closed.
 */

export type ProviderId = string
/** `provider/model`. */
export type ModelId = string

/** Why a model may be used. Never collapsed into a boolean “free”. `unknown` is a real value and is never eligible under free-only. */
export type ModelAccess = 'local' | 'free' | 'beta' | 'trial' | 'user-authorized' | 'paid' | 'unknown'

/** What discovery learned about pricing. Routing uses `ModelAccess`, which is derived from this plus where the model runs. */
export type PricingClass = 'free' | 'beta-free' | 'trial' | 'paid' | 'unknown'

/** Where the access classification came from: evidence Foundry read, or a person’s explicit configuration. */
export type AccessBasis = 'local-endpoint' | 'catalog-pricing' | 'configured' | 'none'

export interface ModelCapabilities {
  chat: boolean
  reasoning: boolean
  coding: boolean
  vision: boolean
  toolUse: boolean
  structuredOutput: boolean
  streaming: boolean
  contextTokens?: number
}

export interface ModelRequirements {
  reasoning?: boolean
  coding?: boolean
  vision?: boolean
  toolUse?: boolean
  structuredOutput?: boolean
  minimumContextTokens?: number
}

export interface ModelLimits { contextTokens?: number; maxOutputTokens?: number }

/** What the provider says about the model right now — separate from Foundry’s own observations (`ModelHealthSnapshot`). */
export type AvailabilityState =
  | { state: 'available' }
  | { state: 'quota-exhausted' | 'provider-unavailable' | 'disabled' | 'not-connected'; reason?: string }

export interface ModelCandidate {
  id: ModelId
  provider: ProviderId
  providerName: string
  model: string
  label?: string
  access: ModelAccess
  accessBasis: AccessBasis
  pricing: PricingClass
  /** Vendor-published prices per million tokens, when the catalog gave them. Never used to *grant* access on its own. */
  prices?: { inputPerMillion?: number; outputPerMillion?: number }
  capabilities: ModelCapabilities
  limits: ModelLimits
  availability: AvailabilityState
  /** When discovery learned this, and when it stops being trusted. A stale free classification is not assumed to be free. */
  observedAt: number
  expiresAt: number
  /** The person turned this model off. */
  enabled: boolean
}

export interface ModelRegistrySnapshot { candidates: ModelCandidate[]; discoveredAt: number; errors: { provider: ProviderId; message: string }[] }

// ─────────────── policy ───────────────

/** `free-only` is the only budget the UI offers. `unrestricted` exists for the router’s contract and is refused when loaded from settings. */
export type ModelBudget = { kind: 'free-only' } | { kind: 'unrestricted' }

export interface ModelPolicy {
  budget: ModelBudget
  /** Foundry picks the model for each request, and cycles when one reaches a limit. Off: the agent’s own model is used, as before. */
  automatic: boolean
  /** Continue with the next eligible model after a retryable failure. */
  failover: boolean
  /** Allow models classified `beta`. */
  useBeta: boolean
}
export const DEFAULT_MODEL_POLICY: ModelPolicy = { budget: { kind: 'free-only' }, automatic: false, failover: true, useBeta: true }

// ─────────────── runtime signals (observed by Foundry, not vendor claims) ───────────────

export type HealthState = 'healthy' | 'degraded' | 'cooldown' | 'unavailable'
export type RetryReason = 'rate-limited' | 'capacity-unavailable' | 'timeout' | 'temporary-provider-error'
/** Failures that are not retried: the same request would fail the same way, or retrying would be wrong. */
export type PermanentFailure = 'authentication' | 'invalid-request' | 'policy-violation' | 'unsupported-capability' | 'malformed-tool-call' | 'other'

export interface ModelHealthSnapshot {
  state: HealthState
  requests: number
  successes: number
  failures: number
  rateLimited: number
  timeouts: number
  averageLatencyMs?: number
  p50LatencyMs?: number
  p95LatencyMs?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastFailure?: string
  cooldownUntil?: number
  consecutiveFailures: number
  toolCalls: number
  toolCallSuccesses: number
  structuredOutputs: number
  structuredOutputSuccesses: number
}

// ─────────────── decisions ───────────────

export type RejectionStage = 'policy' | 'capability' | 'availability' | 'health'
export interface ModelRejection { model: ModelId; stage: RejectionStage; reason: string; detail?: string }
export interface ModelAttempt {
  model: ModelId
  startedAt: number
  latencyMs: number
  outcome: 'success' | 'failed'
  retryReason?: RetryReason
  permanent?: PermanentFailure
  error?: string
  /** The next candidate was tried because of this failure. */
  retried: boolean
}

export interface ModelDecision {
  requestId: string
  taskClass: string
  requirements: ModelRequirements
  policy: ModelBudget
  selected?: ModelId
  candidatesConsidered: ModelId[]
  rejected: ModelRejection[]
  /** Eligible, in the order they would be tried. */
  ranked: ModelId[]
  attempts: ModelAttempt[]
  selectedAt: number
  outcome: 'succeeded' | 'failed' | 'no-eligible-model'
  /** Human summary: “Free only · $0 maximum”. */
  costPolicy: string
  failure?: string
}

export interface ModelRequest {
  requestId: string
  taskClass: string
  requirements: ModelRequirements
}

// ─────────────── views for the CLI and the UI ───────────────

export interface ModelStatusEntry {
  candidate: ModelCandidate
  health: ModelHealthSnapshot
  /** Eligible for this policy right now (policy + availability + health), ignoring the request’s requirements. */
  eligible: boolean
  /** Why not, when not. */
  rejection?: ModelRejection
}

export interface ModelFabricStatus {
  policy: ModelPolicy
  discoveredAt?: number
  discovered: number
  eligible: number
  rateLimited: number
  unavailable: number
  providers: { id: ProviderId; name: string; connected: boolean; models: number; eligible: number; error?: string }[]
  current?: ModelStatusEntry
  fallbacks: ModelStatusEntry[]
  entries: ModelStatusEntry[]
  recentDecisions: ModelDecision[]
  /** Always stated the way the provider’s terms allow: free under current free/beta access terms, not unlimited. */
  costNote: string
}

export const FREE_ONLY_ACCESS: readonly ModelAccess[] = ['local', 'free', 'beta', 'trial']
export const FREE_TERMS_NOTE = 'Free under each provider’s current free/beta access terms. Free is not unlimited: a model can reach its limit, and Foundry then continues with another.'
export const budgetLabel = (budget: ModelBudget): string => budget.kind === 'free-only' ? 'Free only' : 'Unrestricted'

const REASON_TEXT: Record<string, string> = { 'rate-limited': 'reached its current limit', 'capacity-unavailable': 'is at capacity right now', timeout: 'did not answer in time', 'temporary-provider-error': 'had a temporary error' }
const nameOf = (id: ModelId, names: Map<ModelId, string>): string => names.get(id) ?? id

/**
 * What Activity says about a finished routing decision. A switch is information, never an interruption; only a request that could not
 * continue at all is worded as a problem. `names` maps ids to “Model · Provider” for display.
 */
export function decisionNotice(decision: ModelDecision, names: Map<ModelId, string> = new Map()): { kind: 'switched' | 'unavailable'; title: string; detail: string } | undefined {
  const cost = `Cost policy: ${budgetLabel(decision.policy)}`
  if (decision.outcome === 'no-eligible-model' || (decision.outcome === 'failed' && !decision.selected && decision.attempts.some(attempt => attempt.retried))) {
    return { kind: 'unavailable', title: 'Models unavailable', detail: `All currently available free models are unavailable or rate limited. No paid model was used. ${cost}` }
  }
  const failures = decision.attempts.filter(attempt => attempt.outcome === 'failed' && attempt.retried)
  if (decision.outcome !== 'succeeded' || !decision.selected || !failures.length) return undefined
  const first = failures[0]!
  return { kind: 'switched', title: 'Model switched', detail: `${nameOf(first.model, names)} ${REASON_TEXT[first.retryReason ?? ''] ?? 'was not available'}. Foundry continued with ${nameOf(decision.selected, names)}. No action required. ${cost}` }
}
