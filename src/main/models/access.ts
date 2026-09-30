import { FREE_ONLY_ACCESS, type AccessBasis, type ModelAccess, type ModelBudget, type ModelCandidate, type ModelPolicy, type ModelRejection, type PricingClass } from '../../shared/modelFabric'

/**
 * Access is derived, not declared by a provider’s price list alone:
 *
 *   where it runs  +  what the catalog says it costs  +  what the person explicitly configured  →  ModelAccess
 *
 * Nothing here is optimistic. No evidence is `unknown`, and `unknown` is never eligible under free-only.
 */
export interface AccessEvidence {
  /** The endpoint is this computer (Ollama, LM Studio …): no provider can charge for it. */
  local: boolean
  /** What the provider’s catalog says. `unknown` when it said nothing usable. */
  pricing: PricingClass
  /** The person’s explicit statement for this model, when they made one. */
  configured?: PricingClass
}

export function classifyAccess(evidence: AccessEvidence): { access: ModelAccess; basis: AccessBasis; pricing: PricingClass } {
  if (evidence.local) return { access: 'local', basis: 'local-endpoint', pricing: 'free' }
  // Catalog evidence wins over a person’s configuration only in the safe direction: a catalog that says “paid” is not overridden to free.
  if (evidence.pricing === 'paid') return { access: 'paid', basis: 'catalog-pricing', pricing: 'paid' }
  const pricing = evidence.pricing !== 'unknown' ? evidence.pricing : evidence.configured ?? 'unknown'
  const basis: AccessBasis = evidence.pricing !== 'unknown' ? 'catalog-pricing' : evidence.configured ? 'configured' : 'none'
  switch (pricing) {
    case 'free': return { access: 'free', basis, pricing }
    case 'beta-free': return { access: 'beta', basis, pricing }
    case 'trial': return { access: 'trial', basis, pricing }
    case 'paid': return { access: 'paid', basis, pricing }
    default: return { access: 'unknown', basis: 'none', pricing: 'unknown' }
  }
}

/**
 * An OpenAI-compatible `/models` entry’s prices, as the catalog states them. Every price it states must be zero for the model to be
 * `free`; a missing or unparseable price is `unknown`, never free.
 */
export function pricingFromCatalog(pricing: unknown): { pricing: PricingClass; prices?: { inputPerMillion?: number; outputPerMillion?: number } } {
  if (!pricing || typeof pricing !== 'object') return { pricing: 'unknown' }
  const entries = Object.entries(pricing as Record<string, unknown>).filter(([key]) => ['prompt', 'completion', 'request', 'image', 'input', 'output'].includes(key))
  if (!entries.length) return { pricing: 'unknown' }
  const numbers = entries.map(([key, value]) => [key, typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN] as const)
  if (numbers.some(([, value]) => !Number.isFinite(value) || value < 0)) return { pricing: 'unknown' }
  const input = numbers.find(([key]) => key === 'prompt' || key === 'input')?.[1]
  const output = numbers.find(([key]) => key === 'completion' || key === 'output')?.[1]
  const prices = { ...(input !== undefined ? { inputPerMillion: input * 1e6 } : {}), ...(output !== undefined ? { outputPerMillion: output * 1e6 } : {}) }
  return { pricing: numbers.every(([, value]) => value === 0) ? 'free' : 'paid', prices }
}

/**
 * The cost gate. One function, used twice: by the router when it plans, and again by the invocation guard immediately before any
 * provider is called. A candidate that fails it must never reach `invoke`.
 */
export function budgetRejection(candidate: ModelCandidate, policy: Pick<ModelPolicy, 'budget' | 'useBeta'>, now: number): ModelRejection | undefined {
  const reject = (reason: string, detail?: string): ModelRejection => ({ model: candidate.id, stage: 'policy', reason, ...(detail ? { detail } : {}) })
  if (!candidate.enabled) return reject('disabled', 'turned off')
  const budget: ModelBudget = policy.budget
  if (budget.kind === 'free-only') {
    if (!FREE_ONLY_ACCESS.includes(candidate.access)) return reject(candidate.access === 'unknown' ? 'unknown-pricing' : 'not-free', `access is ${candidate.access}`)
    // A classification is a claim about a provider’s terms on a given day. Past its expiry it is not assumed to still hold.
    if (candidate.access !== 'local' && candidate.expiresAt <= now) return reject('stale-pricing', 'the free classification has expired; rediscover to confirm')
    if (candidate.access === 'beta' && !policy.useBeta) return reject('beta-disabled', 'beta models are turned off')
    return undefined
  }
  if (budget.kind === 'unrestricted') return undefined
  return reject('unsupported-budget') // fail closed on anything this version does not understand
}
