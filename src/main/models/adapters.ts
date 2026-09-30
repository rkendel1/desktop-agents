import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import { customEndpoint } from '../../shared/customModels'
import type { ModelCandidate, ModelCapabilities, PricingClass } from '../../shared/modelFabric'
import { customModelDefinition, customProviderHeaders, type CustomProviderRecord } from '../customModels'
import { classifyAccess, pricingFromCatalog } from './access'
import { DEFAULT_TTL_MS } from './fabric'
import type { ModelInvocation, ModelProvider, ModelResponse } from './provider'
import type { ClassifiedError } from './router'

/**
 * Adapters over the provider integration Foundry already has: the custom providers of Settings → Models (OpenAI-compatible,
 * Anthropic-compatible and Ollama endpoints). A provider’s catalog is used when it has one (`/models`, including the prices and
 * modalities OpenRouter-style catalogs publish; Ollama’s `/api/tags`); otherwise the models the person configured are the pool,
 * with the pricing they stated, or none — and no stated pricing is `unknown`, which free-only never uses.
 *
 * Discovery is what the provider says today. No provider or model name appears in this file.
 */
export interface AdapterDeps {
  fetch?: typeof fetch
  now?: () => number
  ttlMs?: number
  /** Foundry’s existing model path (pi-ai through the runtime’s registry). */
  stream: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream
}

const MAX_DISCOVERED = 500
/**
 * Whether a model runs on this computer, so that no provider can charge for it. Only Ollama’s own service is taken at its word, and not
 * for its `-cloud` models, which run remotely. A loopback address alone is not evidence: an OpenAI-compatible server on localhost is
 * often a gateway to paid providers, so it is classified from its catalog or the person’s explicit entry like any other.
 */
export const runsLocally = (record: Pick<CustomProviderRecord, 'kind'>, model: string): boolean => record.kind === 'ollama' && !/(?::|-)cloud$/i.test(model)

const modelsUrl = (record: CustomProviderRecord): string => {
  const endpoint = customEndpoint(record.apiBase, record.kind)
  return record.kind === 'ollama' ? `${record.apiBase.trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434'}/api/tags` : endpoint.replace(/\/chat\/completions$/, '/models').replace(/\/v1\/messages$/, '/v1/models')
}
const headers = (record: CustomProviderRecord): Record<string, string> => customProviderHeaders(record)

interface CatalogEntry {
  id?: unknown; name?: unknown; pricing?: unknown; context_length?: unknown; supported_parameters?: unknown
  architecture?: { input_modalities?: unknown; output_modalities?: unknown }
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown }
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** What the catalog entry says the model can do. Coding is inferred (no catalog states it): tool use, reasoning, or a coder’s name. */
function catalogCapabilities(entry: CatalogEntry, record: CustomProviderRecord, id: string): ModelCapabilities {
  const parameters = strings(entry.supported_parameters)
  const toolUse = parameters.includes('tools')
  const reasoning = parameters.includes('reasoning') || parameters.includes('include_reasoning') || Boolean(record.reasoningModels?.includes(id))
  return { chat: true, streaming: true, toolUse, reasoning, vision: strings(entry.architecture?.input_modalities).includes('image'),
    structuredOutput: parameters.includes('structured_outputs') || parameters.includes('response_format'),
    coding: toolUse || reasoning || /cod(?:e|er|ing)|devstral|codestral/i.test(id),
    ...(positive(entry.context_length) ?? positive(entry.top_provider?.context_length) ? { contextTokens: (positive(entry.context_length) ?? positive(entry.top_provider?.context_length))! } : {}) }
}

/** A model the person configured, without a catalog: treated as Foundry already treats it as an agent’s model. */
const configuredCapabilities = (record: CustomProviderRecord, id: string): ModelCapabilities => ({ chat: true, streaming: true, toolUse: true, coding: true, vision: false, structuredOutput: false, reasoning: Boolean(record.reasoningModels?.includes(id)), contextTokens: 128_000 })

export function customProviderAdapter(record: CustomProviderRecord, deps: AdapterDeps): ModelProvider {
  const now = deps.now ?? Date.now
  const doFetch = deps.fetch ?? fetch
  const build = (model: string, entry: CatalogEntry | undefined, stated: PricingClass | undefined): ModelCandidate => {
    const catalogued = entry ? pricingFromCatalog(entry.pricing) : { pricing: 'unknown' as PricingClass }
    const classification = classifyAccess({ local: runsLocally(record, model), pricing: catalogued.pricing, ...(stated ? { configured: stated } : {}) })
    const capabilities = entry ? catalogCapabilities(entry, record, model) : configuredCapabilities(record, model)
    const observedAt = now()
    return { id: `${record.id}/${model}`, provider: record.id, providerName: record.name, model, ...(record.modelLabels?.[model] ? { label: record.modelLabels[model] } : {}),
      access: classification.access, accessBasis: classification.basis, pricing: classification.pricing, ...(catalogued.prices ? { prices: catalogued.prices } : {}),
      capabilities, limits: { ...(capabilities.contextTokens ? { contextTokens: capabilities.contextTokens } : {}), ...(positive(entry?.top_provider?.max_completion_tokens) ? { maxOutputTokens: positive(entry?.top_provider?.max_completion_tokens)! } : {}) },
      availability: { state: 'available' }, observedAt, expiresAt: observedAt + (deps.ttlMs ?? DEFAULT_TTL_MS), enabled: true }
  }

  return {
    id: record.id, name: record.name,

    async discover(signal?: AbortSignal): Promise<ModelCandidate[]> {
      const found = new Map<string, ModelCandidate>()
      let catalog: Record<string, unknown>[] | undefined
      if (record.kind !== 'anthropic') {
        const response = await doFetch(modelsUrl(record), { headers: headers(record), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
        // No catalog at all (404/405) is a fact about the provider; anything else means it could not be asked, and the previous answer stands until it expires.
        if (response.status !== 404 && response.status !== 405) {
          if (!response.ok) throw Object.assign(new Error(`${record.name}: the model catalog answered HTTP ${response.status}`), { status: response.status })
          const body = await response.json() as { data?: unknown; models?: unknown }
          const list = record.kind === 'ollama' ? body.models : body.data
          catalog = Array.isArray(list) ? list as Record<string, unknown>[] : []
        }
      }
      for (const raw of (catalog ?? []).slice(0, MAX_DISCOVERED)) {
        const id = typeof raw.id === 'string' ? raw.id : typeof raw.model === 'string' ? raw.model : typeof raw.name === 'string' ? raw.name : ''
        if (!id) continue
        const outputs = strings((raw as CatalogEntry).architecture?.output_modalities)
        if (outputs.length && !outputs.includes('text')) continue   // not a chat model
        found.set(id, record.kind === 'ollama' ? { ...build(id, undefined, undefined) } : build(id, raw as CatalogEntry, record.pricing?.[id]))
      }
      // The person’s explicit entries are always in the pool — they are how a provider without a catalog is used.
      for (const model of record.models) {
        const existing = found.get(model)
        if (!existing) found.set(model, build(model, undefined, record.pricing?.[model]))
        else if (existing.access === 'unknown' && record.pricing?.[model]) found.set(model, build(model, undefined, record.pricing[model]))
      }
      return [...found.values()]
    },

    async invoke(candidate: ModelCandidate, invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
      const payload = invocation.payload
      const context: Context = typeof payload === 'string' ? { messages: [{ role: 'user', content: payload, timestamp: now() }] } : payload as Context
      const model = customModelDefinition(record, candidate.model, { ...(candidate.limits.contextTokens ? { contextWindow: candidate.limits.contextTokens } : {}), ...(candidate.limits.maxOutputTokens ? { maxTokens: candidate.limits.maxOutputTokens } : {}), image: candidate.capabilities.vision })
      const message = await deps.stream(model, context, signal ? { signal } : undefined).result()
      if (message.stopReason === 'error' || message.stopReason === 'aborted') throw Object.assign(new Error(message.errorMessage ?? 'The model returned an error.'), { message: message.errorMessage })
      return { text: message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text).join(''), raw: message }
    },

    classifyError(error: unknown): ClassifiedError | undefined {
      // A local model that is still loading answers with a 5xx-ish “loading”; that is transient.
      return record.kind === 'ollama' && /loading|not ready|starting/i.test(String((error as Error)?.message)) ? { retry: 'capacity-unavailable' } : undefined
    }
  }
}

export const customProviderAdapters = (records: CustomProviderRecord[], deps: AdapterDeps): ModelProvider[] => records.map(record => customProviderAdapter(record, deps))
