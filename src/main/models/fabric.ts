import { randomUUID } from 'node:crypto'
import { budgetLabel, DEFAULT_MODEL_POLICY, FREE_TERMS_NOTE, type ModelCandidate, type ModelDecision, type ModelFabricStatus, type ModelId, type ModelPolicy, type ModelRegistrySnapshot, type ModelRequest, type ModelRequirements, type ModelStatusEntry } from '../../shared/modelFabric'
import { budgetRejection } from './access'
import { HealthLedger, type Outcome } from './health'
import type { ModelInvocation, ModelProvider, ModelResponse } from './provider'
import { planRoute, routeWithFallback, ModelRoutingError, type ClassifiedError } from './router'

/**
 * What the fabric persists — in Foundry’s existing settings, alongside every other preference. Policy and the last discovery only:
 * no credentials, no health, no counters. (Health is operational and lives in the fabric instance; see health.ts.)
 */
export interface PersistedFabric { version: 1; policy: ModelPolicy; registry: ModelRegistrySnapshot; disabled: ModelId[] }
export interface FabricStore { load(): Promise<unknown>; save(value: PersistedFabric): Promise<void> }

export const DEFAULT_TTL_MS = 6 * 60 * 60_000
const MAX_DECISIONS = 50
const ACCESS: readonly string[] = ['local', 'free', 'beta', 'trial', 'user-authorized', 'paid', 'unknown']

/** Read persisted settings defensively. Anything unrecognised becomes the safe default; a budget other than free-only is refused. */
export function loadPersisted(raw: unknown): PersistedFabric {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<PersistedFabric>
  const p = (value.policy ?? {}) as Partial<ModelPolicy>
  const policy: ModelPolicy = { budget: { kind: 'free-only' }, automatic: p.automatic === true, failover: p.failover !== false, useBeta: p.useBeta !== false }
  const candidates = Array.isArray(value.registry?.candidates) ? value.registry!.candidates.filter((c): c is ModelCandidate => Boolean(c) && typeof c.id === 'string' && typeof c.provider === 'string' && ACCESS.includes(c.access) && typeof c.expiresAt === 'number') : []
  return { version: 1, policy, registry: { candidates, discoveredAt: typeof value.registry?.discoveredAt === 'number' ? value.registry.discoveredAt : 0, errors: Array.isArray(value.registry?.errors) ? value.registry!.errors : [] },
    disabled: Array.isArray(value.disabled) ? value.disabled.filter((id): id is string => typeof id === 'string') : [] }
}

export interface FabricOptions {
  now?: () => number
  ttlMs?: number
  /** Called with every finished decision, for Activity and diagnostics. */
  onDecision?: (decision: ModelDecision) => void
}

/**
 * The model fabric: discovery → registry → router → provider, under a cost policy.
 *
 * It holds no authority of its own. Policy and the discovered registry are read from and written to the store it is given; the
 * providers are handed in; the health ledger is an ordinary object it owns. Two fabrics over the same store agree.
 */
export class ModelFabric {
  readonly ledger: HealthLedger
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly decisions: ModelDecision[] = []
  constructor(private readonly store: FabricStore, private readonly providers: () => Promise<ModelProvider[]> | ModelProvider[], private readonly options: FabricOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.ledger = new HealthLedger(this.now)
  }

  private async persisted(): Promise<PersistedFabric> { return loadPersisted(await this.store.load()) }

  async policy(): Promise<ModelPolicy> { return (await this.persisted()).policy }
  async setPolicy(patch: Partial<Pick<ModelPolicy, 'automatic' | 'failover' | 'useBeta'>>): Promise<ModelPolicy> {
    const current = await this.persisted()
    // The budget is not settable here: this version offers free-only and nothing else.
    const policy: ModelPolicy = { ...current.policy, ...(typeof patch.automatic === 'boolean' ? { automatic: patch.automatic } : {}), ...(typeof patch.failover === 'boolean' ? { failover: patch.failover } : {}),
      ...(typeof patch.useBeta === 'boolean' ? { useBeta: patch.useBeta } : {}), budget: { kind: 'free-only' } }
    await this.store.save({ ...current, policy })
    return policy
  }

  /** Turn one model off (or on) without forgetting it. */
  async setEnabled(id: ModelId, enabled: boolean): Promise<void> {
    const current = await this.persisted()
    const disabled = new Set(current.disabled)
    if (enabled) disabled.delete(id); else disabled.add(id)
    await this.store.save({ ...current, disabled: [...disabled].sort() })
  }

  /** The last discovery, with the person’s on/off choices applied. */
  async registry(): Promise<ModelRegistrySnapshot> {
    const { registry, disabled } = await this.persisted()
    const off = new Set(disabled)
    return { ...registry, candidates: registry.candidates.map(candidate => off.has(candidate.id) ? { ...candidate, enabled: false } : candidate) }
  }

  /**
   * Ask every provider what it offers now and replace the registry with the answer. A provider that cannot be asked keeps its previous
   * entries (they age out on their own, and stale entries are not eligible), and the failure is recorded rather than thrown.
   */
  async discover(signal?: AbortSignal): Promise<ModelRegistrySnapshot> {
    const now = this.now()
    const previous = await this.persisted()
    const providers = await this.providers()
    const candidates: ModelCandidate[] = []
    const errors: { provider: string; message: string }[] = []
    for (const provider of providers) {
      try {
        for (const found of await provider.discover(signal)) candidates.push({ ...found, observedAt: found.observedAt || now, expiresAt: found.expiresAt || now + this.ttlMs })
      } catch (error) {
        errors.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) })
        candidates.push(...previous.registry.candidates.filter(candidate => candidate.provider === provider.id))
      }
    }
    // A provider that was removed is not remembered.
    const known = new Set(providers.map(provider => provider.id))
    const registry: ModelRegistrySnapshot = { candidates: candidates.filter(candidate => known.has(candidate.provider)).sort((a, b) => a.id.localeCompare(b.id)), discoveredAt: now, errors }
    await this.store.save({ ...previous, registry })
    return this.registry()
  }

  private async pool(): Promise<{ policy: ModelPolicy; candidates: ModelCandidate[]; registry: ModelRegistrySnapshot }> {
    const policy = await this.policy()
    const registry = await this.registry()
    return { policy, candidates: registry.candidates, registry }
  }

  /** What would be chosen for these requirements now, without calling anything. */
  async plan(taskClass: string, requirements: ModelRequirements = {}): Promise<ReturnType<typeof planRoute>> {
    const { policy, candidates } = await this.pool()
    return planRoute({ request: { requestId: 'plan', taskClass, requirements }, policy, candidates, ledger: this.ledger, now: this.now() })
  }

  private remember(decision: ModelDecision): void {
    this.decisions.unshift(decision)
    if (this.decisions.length > MAX_DECISIONS) this.decisions.length = MAX_DECISIONS
    this.options.onDecision?.(decision)
  }
  recentDecisions(): ModelDecision[] { return [...this.decisions] }

  request(taskClass: string, requirements: ModelRequirements = {}): ModelRequest { return { requestId: randomUUID(), taskClass, requirements } }

  /**
   * Route one request: plan the eligible candidates, call `invoke` for each in order until one answers, cycling on retryable failures.
   * Every outcome — success, final failure, nothing eligible — leaves a `ModelDecision`. `invoke` is only ever handed a candidate the
   * cost policy admits; if that were ever not so, the guard throws before anything is sent.
   */
  async route<T>(request: ModelRequest, invoke: (candidate: ModelCandidate) => Promise<{ value: T; outcome?: Partial<Outcome> }>, options: { signal?: AbortSignal; classify?: (candidate: ModelCandidate, error: unknown) => ClassifiedError | undefined } = {}): Promise<{ value: T; decision: ModelDecision }> {
    const { policy, candidates } = await this.pool()
    try {
      const routed = await routeWithFallback<T>({ request, policy, candidates, ledger: this.ledger, now: this.now, invoke, ...(options.signal ? { signal: options.signal } : {}), ...(options.classify ? { classify: options.classify } : {}) })
      this.remember(routed.decision)
      return routed
    } catch (error) {
      if (error instanceof ModelRoutingError) this.remember(error.decision)
      throw error
    }
  }

  /** `route` through provider adapters, for callers that want text back (the CLI test, background work). */
  async complete(request: ModelRequest, payload: unknown, signal?: AbortSignal): Promise<{ response: ModelResponse; decision: ModelDecision }> {
    const providers = new Map((await this.providers()).map(provider => [provider.id, provider]))
    const { value, decision } = await this.route<ModelResponse>(request, async candidate => {
      const provider = providers.get(candidate.provider)
      if (!provider) throw Object.assign(new Error(`provider ${candidate.provider} is not connected`), { status: 503 })
      const invocation: ModelInvocation = { ...request, payload }
      return { value: await provider.invoke(candidate, invocation, signal) }
    }, { ...(signal ? { signal } : {}), classify: (candidate, error) => providers.get(candidate.provider)?.classifyError?.(error) })
    return { response: value, decision }
  }

  // ───────────────────────────── views ─────────────────────────────

  async entries(): Promise<ModelStatusEntry[]> {
    const { policy, candidates } = await this.pool()
    const now = this.now()
    return candidates.map(candidate => {
      const rejection = budgetRejection(candidate, policy, now)
        ?? (candidate.availability.state !== 'available' ? { model: candidate.id, stage: 'availability' as const, reason: candidate.availability.state, ...(candidate.availability.reason ? { detail: candidate.availability.reason } : {}) } : undefined)
        ?? (this.ledger.exclusion(candidate.id) ? { model: candidate.id, stage: 'health' as const, reason: this.ledger.exclusion(candidate.id)!.state, detail: this.ledger.exclusion(candidate.id)!.reason } : undefined)
      return { candidate, health: this.ledger.snapshot(candidate.id), eligible: !rejection, ...(rejection ? { rejection } : {}) }
    })
  }

  /** The pool, the policy, the current pick and its fallbacks — everything the CLI and the Models screen show. */
  async status(requirements: ModelRequirements = {}): Promise<ModelFabricStatus> {
    const { policy, registry } = await this.pool()
    const entries = await this.entries()
    const plan = await this.plan('general', requirements)
    const byId = new Map(entries.map(entry => [entry.candidate.id, entry]))
    const ranked = plan.ranked.map(candidate => byId.get(candidate.id)!).filter(Boolean)
    const providers = new Map<string, { id: string; name: string; connected: boolean; models: number; eligible: number; error?: string }>()
    for (const entry of entries) {
      const item = providers.get(entry.candidate.provider) ?? { id: entry.candidate.provider, name: entry.candidate.providerName, connected: entry.candidate.availability.state !== 'not-connected', models: 0, eligible: 0 }
      item.models++; if (entry.eligible) item.eligible++
      providers.set(item.id, item)
    }
    for (const error of registry.errors) { const item = providers.get(error.provider); if (item) item.error = error.message; else providers.set(error.provider, { id: error.provider, name: error.provider, connected: false, models: 0, eligible: 0, error: error.message }) }
    return {
      policy, ...(registry.discoveredAt ? { discoveredAt: registry.discoveredAt } : {}), discovered: entries.length, eligible: entries.filter(entry => entry.eligible).length,
      rateLimited: entries.filter(entry => entry.health.state === 'cooldown' && this.ledger.exclusion(entry.candidate.id)?.reason.match(/rate|429|quota|limit/i)).length,
      unavailable: entries.filter(entry => entry.candidate.availability.state !== 'available' || entry.health.state === 'unavailable').length,
      providers: [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)), ...(ranked[0] ? { current: ranked[0] } : {}), fallbacks: ranked.slice(1, 6),
      entries: entries.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id)), recentDecisions: this.recentDecisions().slice(0, 10), costNote: FREE_TERMS_NOTE
    }
  }
}

export { budgetLabel }
