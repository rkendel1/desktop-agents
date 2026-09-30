import { createProvider, type Provider, type Model } from '@earendil-works/pi-ai'
import * as openai from '@earendil-works/pi-ai/api/openai-completions'
import * as anthropic from '@earendil-works/pi-ai/api/anthropic-messages'
import type { DesktopRepository, ProviderRecord } from './desktopRepository'
import type { CredentialVault } from './credentialVault'
import { CUSTOM_PROVIDER_PREFIX, customEndpoint, providerRequiresApiKey, type CustomProviderInput, type CustomModelConfig, type CustomModelTest } from '../shared/customModels'
export interface CustomProviderRecord extends CustomProviderInput { apiKey: string }
export function validateCustomProvider(input: CustomProviderInput): CustomProviderInput {
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)) throw new Error("Invalid provider ID.")
  if (input.kind !== 'openai' && input.kind !== 'anthropic' && input.kind !== 'ollama') throw new Error("Select an API type.")
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error("Enter a provider name.")
  if (typeof input.apiBase !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new Error("Invalid configuration format.")
  const endpoint = new URL(customEndpoint(input.apiBase, input.kind))
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("The API URL must use HTTP or HTTPS and contain no password, query parameters or fragment.")
  const models = Array.isArray(input.models) ? [...new Set(input.models.filter((m): m is string => typeof m === 'string').map(m => m.trim()).filter(Boolean))] : []
  if (!models.length || models.length > 100 || models.some(m => m.length > 200)) throw new Error("Enter valid model names, one per line.")
  const modelLabels = Object.fromEntries(models.map(model => [model, typeof input.modelLabels?.[model] === 'string' ? input.modelLabels[model].trim().slice(0, 200) : '']).filter(([, label]) => label))
  const reasoningModels = Array.isArray(input.reasoningModels) ? models.filter(model => input.reasoningModels!.includes(model)) : []
  const pricing = input.pricing && typeof input.pricing === 'object' ? Object.fromEntries(Object.entries(input.pricing).filter(([model, value]) => models.includes(model) && (value === 'free' || value === 'beta-free' || value === 'trial'))) as NonNullable<CustomProviderInput['pricing']> : {}
  return { id: input.id, name: input.name.trim(), kind: input.kind, apiBase: input.apiBase.trim(), apiKey: input.apiKey?.trim(), models, ...(Object.keys(modelLabels).length ? { modelLabels } : {}), ...(reasoningModels.length ? { reasoningModels } : {}), ...(Object.keys(pricing).length ? { pricing } : {}) }
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
    if (providerRequiresApiKey(p.kind) && !key) return { ok: false, error: '请输入 API 密钥；地址修改后需要重新输入。' }
    try {
      const res = await fetch(customEndpoint(p.apiBase, p.kind), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: p.kind === 'anthropic' ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : p.kind === 'ollama' ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: input.model, max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
      })
      if (!res.ok) return { ok: false, error: `连接失败（HTTP ${res.status}），请检查地址、密钥和模型权限。` }
      const data = await res.json() as { content?: unknown[]; choices?: unknown[]; model?: string }
      if (!(p.kind === 'anthropic' ? Array.isArray(data.content) : Array.isArray(data.choices) && data.choices.length)) return { ok: false, error: '响应格式与所选 API 类型不匹配。' }
      return { ok: true, model: input.model }
    } catch { return { ok: false, error: '连接失败或超时，请检查网络和 API 地址。' } }
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
    compat: { maxTokensField: 'max_tokens' }
  } as Model<any>
}
export function customModelProvider(p: CustomProviderRecord): Provider {
  const id = CUSTOM_PROVIDER_PREFIX + p.id
  const endpoint = customEndpoint(p.apiBase, p.kind)
  const baseUrl = endpoint.slice(0, -(p.kind === 'anthropic' ? '/v1/messages'.length : '/chat/completions'.length))
  const models = p.models.map(model => customModelDefinition(p, model))
  return createProvider({ id, name: p.name, baseUrl, models,
    auth: { apiKey: { name: p.name, resolve: async () => ({ auth: { apiKey: p.kind === 'ollama' ? 'ollama' : p.apiKey }, source: 'custom model settings' }) } },
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
