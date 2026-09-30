import { createProvider, type Provider, type Model } from '@earendil-works/pi-ai'
import * as openai from '@earendil-works/pi-ai/api/openai-completions'
import * as anthropic from '@earendil-works/pi-ai/api/anthropic-messages'
import type { DesktopRepository, ProviderRecord } from './desktopRepository'
import type { CredentialVault } from './credentialVault'
import { CUSTOM_PROVIDER_PREFIX, customEndpoint, providerRequiresApiKey, type CustomProviderInput, type CustomModelConfig, type CustomModelTest } from '../shared/customModels'
export interface CustomProviderRecord extends CustomProviderInput { apiKey: string }
export function usesNativeOpenAITokens(p: Pick<CustomProviderInput, 'kind' | 'apiBase'>): boolean {
  if (p.kind !== 'openai') return false
  try { return new URL(customEndpoint(p.apiBase, p.kind)).hostname === 'api.openai.com' } catch { return false }
}
export function completionTokenLimit(p: Pick<CustomProviderInput, 'kind' | 'apiBase'>, tokens: number): { max_tokens: number } | { max_completion_tokens: number } {
  return usesNativeOpenAITokens(p) ? { max_completion_tokens: tokens } : { max_tokens: tokens }
}
export function customProviderHeaders(p: Pick<CustomProviderRecord, 'kind' | 'apiKey' | 'workspaceId'>, contentType = false): Record<string, string> {
  const headers: Record<string, string> = contentType ? { 'Content-Type': 'application/json' } : {}
  if (p.kind === 'anthropic') {
    headers['x-api-key'] = p.apiKey
    headers['anthropic-version'] = '2023-06-01'
    if (p.workspaceId) headers['anthropic-workspace-id'] = p.workspaceId
  } else if (p.kind !== 'ollama' && p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`
  return headers
}
function providerErrorDetail(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return
  const body = value as { error?: unknown; message?: unknown }
  const nested = body.error && typeof body.error === 'object' ? (body.error as { message?: unknown }).message : undefined
  const message = typeof nested === 'string' ? nested : typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : undefined
  if (!message) return
  const safe = (key ? message.replaceAll(key, '[redacted]') : message).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
  return safe || undefined
}
export function validateCustomProvider(input: CustomProviderInput): CustomProviderInput {
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)) throw new Error("Invalid provider ID.")
  if (input.kind !== 'openai' && input.kind !== 'anthropic' && input.kind !== 'ollama') throw new Error("Select an API type.")
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error("Enter a provider name.")
  if (typeof input.apiBase !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new Error("Invalid configuration format.")
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (workspaceId && (input.kind !== 'anthropic' || workspaceId.length > 200 || /[\r\n\0]/.test(workspaceId))) throw new Error("Enter a valid Anthropic workspace ID.")
  const endpoint = new URL(customEndpoint(input.apiBase, input.kind))
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("The API URL must use HTTP or HTTPS and contain no password, query parameters or fragment.")
  const models = Array.isArray(input.models) ? [...new Set(input.models.filter((m): m is string => typeof m === 'string').map(m => m.trim()).filter(Boolean))] : []
  if (!models.length || models.length > 100 || models.some(m => m.length > 200)) throw new Error("Enter valid model names, one per line.")
  const modelLabels = Object.fromEntries(models.map(model => [model, typeof input.modelLabels?.[model] === 'string' ? input.modelLabels[model].trim().slice(0, 200) : '']).filter(([, label]) => label))
  const reasoningModels = Array.isArray(input.reasoningModels) ? models.filter(model => input.reasoningModels!.includes(model)) : []
  const pricing = input.pricing && typeof input.pricing === 'object' ? Object.fromEntries(Object.entries(input.pricing).filter(([model, value]) => models.includes(model) && (value === 'free' || value === 'beta-free' || value === 'trial'))) as NonNullable<CustomProviderInput['pricing']> : {}
  return { id: input.id, name: input.name.trim(), kind: input.kind, apiBase: input.apiBase.trim(), apiKey: input.apiKey?.trim(), ...(workspaceId ? { workspaceId } : {}), models, ...(Object.keys(modelLabels).length ? { modelLabels } : {}), ...(reasoningModels.length ? { reasoningModels } : {}), ...(Object.keys(pricing).length ? { pricing } : {}) }
}
/**
 * Provider configuration. FeltDB holds the non-secret record (endpoint, models,
 * a `credentialRef`); the API key lives only in the OS-backed credential vault.
 */
export class CustomModelStore {
  constructor(private repository: DesktopRepository, private vault: CredentialVault) {}
  private reference(id: string): string { return `provider:${id}` }
  private secret(id: string): string | undefined { return this.vault.get(this.reference(id)) }
  async list(): Promise<CustomModelConfig> {
    return {
      defaultModel: (await this.repository.setting<string>('defaultModel')) ?? '',
      providers: (await this.repository.providers()).map(record => ({ id: record.id, name: record.name, kind: record.kind, ...record.config, hasKey: !providerRequiresApiKey(record.kind) || this.vault.has(record.credentialRef ?? this.reference(record.id)) }))
    }
  }
  async records(): Promise<CustomProviderRecord[]> {
    return (await this.repository.providers()).flatMap(record => {
      const apiKey = this.secret(record.id) ?? ''
      return apiKey || !providerRequiresApiKey(record.kind) ? [{ id: record.id, name: record.name, kind: record.kind, ...record.config, apiKey }] : []
    })
  }
  async save(inputs: CustomProviderInput[], defaultModel: string): Promise<CustomModelConfig> {
    if (!Array.isArray(inputs) || inputs.length > 30 || typeof defaultModel !== 'string') throw new Error("Invalid model configuration.")
    const old = new Map((await this.repository.providers()).map(record => [record.id, record]))
    const staged: { record: ProviderRecord; apiKey?: string }[] = inputs.map(validateCustomProvider).map(({ apiKey, ...p }) => {
      const previous = old.get(p.id)
      const sameDestination = previous && customEndpoint(previous.config.apiBase, previous.kind) === customEndpoint(p.apiBase, p.kind)
      const canReuseKey = providerRequiresApiKey(p.kind) && sameDestination && Boolean(previous.credentialRef && this.vault.has(previous.credentialRef))
      // Never forward a stored key to a changed endpoint without explicit re-entry.
      if (providerRequiresApiKey(p.kind) && !apiKey && previous && !sameDestination) throw new Error("The API URL changed. Enter the API key again.")
      if (providerRequiresApiKey(p.kind) && !apiKey && !canReuseKey) throw new Error("Enter an API key.")
      const { id, name, kind, ...config } = p
      return { apiKey, record: { id, name, kind, config, ...(providerRequiresApiKey(kind) ? { credentialRef: this.reference(id) } : {}), updatedAt: Date.now() } }
    })
    if (new Set(staged.map(item => item.record.id)).size !== staged.length) throw new Error("Duplicate provider IDs.")
    const choices = staged.flatMap(item => item.record.config.models.map(m => `${item.record.id}/${m}`))
    // Secrets first: a record must never reference a credential that was not stored.
    for (const item of staged) if (item.apiKey) this.vault.set(item.record.credentialRef!, item.apiKey)
    // The providers and the default model commit together.
    await this.repository.replaceProviders(staged.map(item => item.record), choices.includes(defaultModel) ? defaultModel : choices[0] ?? '')
    for (const id of old.keys()) if (!staged.some(item => item.record.id === id && item.record.credentialRef)) this.vault.delete(this.reference(id))
    return this.list()
  }
  async test(input: CustomModelTest): Promise<{ ok: boolean; error?: string; model?: string }> {
    const p = validateCustomProvider(input.provider)
    if (!p.models.includes(input.model)) throw new Error("Select a model from the configuration.")
    const saved = (await this.repository.providers()).find(item => item.id === p.id)
    const canReuse = saved && customEndpoint(saved.config.apiBase, saved.kind) === customEndpoint(p.apiBase, p.kind)
    const key = p.apiKey || (canReuse ? this.secret(p.id) ?? '' : '')
    if (providerRequiresApiKey(p.kind) && !key) return { ok: false, error: 'Enter an API key. If the API URL changed, enter the key again.' }
    try {
      const res = await fetch(customEndpoint(p.apiBase, p.kind), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: customProviderHeaders({ ...p, apiKey: key }, true),
        body: JSON.stringify({ model: input.model, ...completionTokenLimit(p, 16), messages: [{ role: 'user', content: 'Hi' }] })
      })
      if (!res.ok) {
        let detail: string | undefined
        try { detail = providerErrorDetail(await res.json(), key) } catch { /* Some providers return an empty or non-JSON error body. */ }
        return { ok: false, error: `Connection failed (HTTP ${res.status})${detail ? `: ${detail}` : '. Check the API URL, key, and model ID.'}` }
      }
      const data = await res.json() as { content?: unknown[]; choices?: unknown[]; model?: string }
      if (!(p.kind === 'anthropic' ? Array.isArray(data.content) : Array.isArray(data.choices) && data.choices.length)) return { ok: false, error: 'The response format does not match the selected API type.' }
      return { ok: true, model: input.model }
    } catch { return { ok: false, error: 'Connection failed or timed out. Check the network and API URL.' } }
  }
}
/** The pi-ai model for one of a custom provider’s models, configured or discovered. */
export function customModelDefinition(p: CustomProviderRecord, model: string, limits: { contextWindow?: number; maxTokens?: number; image?: boolean } = {}): Model<any> {
  const id = CUSTOM_PROVIDER_PREFIX + p.id
  const endpoint = customEndpoint(p.apiBase, p.kind)
  const baseUrl = endpoint.slice(0, -(p.kind === 'anthropic' ? '/v1/messages'.length : '/chat/completions'.length))
  return { id: model, name: model, provider: id, baseUrl,
    api: p.kind === 'anthropic' ? 'anthropic-messages' : 'openai-completions', reasoning: Boolean(p.reasoningModels?.includes(model)), input: limits.image === false ? ['text'] : ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: limits.contextWindow ?? 128000, maxTokens: limits.maxTokens ?? (p.reasoningModels?.includes(model) ? 32000 : 8192),
    compat: { maxTokensField: usesNativeOpenAITokens(p) ? 'max_completion_tokens' : 'max_tokens' }
  } as Model<any>
}
export function customModelProvider(p: CustomProviderRecord): Provider {
  const id = CUSTOM_PROVIDER_PREFIX + p.id
  const endpoint = customEndpoint(p.apiBase, p.kind)
  const baseUrl = endpoint.slice(0, -(p.kind === 'anthropic' ? '/v1/messages'.length : '/chat/completions'.length))
  const models = p.models.map(model => customModelDefinition(p, model))
  return createProvider({ id, name: p.name, baseUrl, models,
    auth: { apiKey: { name: p.name, resolve: async () => ({ auth: { apiKey: p.kind === 'ollama' ? 'ollama' : p.apiKey, ...(p.kind === 'anthropic' && p.workspaceId ? { headers: { 'anthropic-workspace-id': p.workspaceId } } : {}) }, source: 'custom model settings' }) } },
    api: p.kind === 'anthropic' ? anthropic : openai
  }) as Provider
}

/** Detect the standard local Ollama service and return its installed chat models. */
export async function detectOllama(request: typeof fetch = fetch): Promise<CustomProviderInput | null> {
  try {
    const response = await request('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(2500) })
    if (!response.ok) return null
    const data = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> }
    const models = [...new Set((data.models ?? []).map(item => typeof item.name === 'string' ? item.name : typeof item.model === 'string' ? item.model : '').map(name => name.trim()).filter(name => name.length > 0 && name.length <= 200))].slice(0, 100)
    if (!models.length) return null
    return { id: 'ollama', name: 'Ollama', kind: 'ollama', apiBase: 'http://127.0.0.1:11434', models }
  } catch { return null }
}
