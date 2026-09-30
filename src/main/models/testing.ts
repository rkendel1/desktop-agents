import type { ModelAccess, ModelCandidate, ModelCapabilities, PricingClass } from '../../shared/modelFabric'
import type { FabricStore, PersistedFabric } from './fabric'
import type { ModelInvocation, ModelProvider, ModelResponse } from './provider'
import type { ClassifiedError } from './router'

/** Fakes for the fabric’s tests. Nothing here names a real provider or model. */
export const T0 = 1_800_000_000_000
export const CAPS: ModelCapabilities = { chat: true, reasoning: true, coding: true, vision: false, toolUse: true, structuredOutput: true, streaming: true, contextTokens: 128_000 }

export function candidate(provider: string, model: string, patch: Partial<ModelCandidate> & { caps?: Partial<ModelCapabilities> } = {}): ModelCandidate {
  const { caps, ...rest } = patch
  const access: ModelAccess = rest.access ?? 'free'
  const pricing: PricingClass = access === 'paid' ? 'paid' : access === 'unknown' ? 'unknown' : access === 'beta' ? 'beta-free' : access === 'trial' ? 'trial' : 'free'
  return { id: `${provider}/${model}`, provider, providerName: provider.toUpperCase(), model, access, accessBasis: 'catalog-pricing', pricing, capabilities: { ...CAPS, ...caps }, limits: { contextTokens: 128_000 },
    availability: { state: 'available' }, observedAt: T0, expiresAt: T0 + 6 * 3600_000, enabled: true, ...rest }
}

export class MemoryStore implements FabricStore {
  saved?: PersistedFabric
  raw?: unknown
  async load(): Promise<unknown> { return this.saved ?? this.raw }
  async save(value: PersistedFabric): Promise<void> { this.saved = JSON.parse(JSON.stringify(value)) }
}

type Behaviour = (model: ModelCandidate, call: number) => string | Error
export class FakeProvider implements ModelProvider {
  calls: string[] = []
  constructor(readonly id: string, private readonly offers: () => ModelCandidate[], private behaviour: Behaviour = () => 'ok', private readonly classifier?: (error: unknown) => ClassifiedError | undefined) {}
  get name(): string { return this.id.toUpperCase() }
  async discover(): Promise<ModelCandidate[]> { return this.offers() }
  async invoke(model: ModelCandidate, _request: ModelInvocation): Promise<ModelResponse> {
    this.calls.push(model.id)
    const outcome = this.behaviour(model, this.calls.length)
    if (outcome instanceof Error) throw outcome
    return { text: outcome }
  }
  classifyError(error: unknown): ClassifiedError | undefined { return this.classifier?.(error) }
  behave(behaviour: Behaviour): void { this.behaviour = behaviour }
}

export const httpError = (status: number, message = `HTTP ${status}`): Error => Object.assign(new Error(message), { status })
