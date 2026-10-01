import { createProvider, type Provider, type Model } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import * as openai from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'
import * as anthropic from '@earendil-works/pi-ai/api/anthropic-messages'
import type { DesktopRepository, ProviderRecord } from './desktopRepository'
import type { CredentialVault } from './credentialVault'
import { CUSTOM_PROVIDER_PREFIX, customEndpoint, isChatModelProvider, providerRequiresApiKey, type CustomProviderInput, type CustomModelConfig, type CustomModelTest } from '../shared/customModels'
import { authorizeOpenAI, discoverOpenAIModels, OpenAIAuthError, refreshOpenAI, type OpenAICredential } from './openaiAuth'
export interface CustomProviderRecord extends CustomProviderInput { apiKey: string; resolveApiKey?: () => Promise<string> }
export function usesNativeOpenAITokens(p: Pick<CustomProviderInput, 'kind' | 'apiBase'>): boolean {
  if (p.kind !== 'openai') return false
  try { return new URL(customEndpoint(p.apiBase, p.kind)).hostname === 'api.openai.com' } catch { return false }
}
export function usesOpenAIResponses(p: Pick<CustomProviderInput, 'kind' | 'apiBase' | 'authentication'>): boolean {
  return p.authentication === 'chatgpt-oauth' && usesNativeOpenAITokens(p)
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
  if (input.kind !== 'openai' && input.kind !== 'anthropic' && input.kind !== 'ollama' && input.kind !== 'jev') throw new Error("Select an API type.")
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
  const authentication = input.authentication === 'chatgpt-oauth' ? input.authentication : input.authentication === 'api-key' ? input.authentication : undefined
  if (authentication === 'chatgpt-oauth' && (input.id !== 'openai' || !usesNativeOpenAITokens(input))) throw new Error('ChatGPT sign-in is only supported by the official OpenAI provider.')
  const account = typeof input.account === 'string' ? input.account.trim().slice(0, 200) : ''
  const levels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const thinkingLevels = input.thinkingLevels && typeof input.thinkingLevels === 'object' ? Object.fromEntries(Object.entries(input.thinkingLevels).flatMap(([model, values]) => models.includes(model) && Array.isArray(values) ? [[model, [...new Set(values.filter(value => levels.has(value)))]]] : []).filter(([, values]) => values.length)) as CustomProviderInput['thinkingLevels'] : undefined
  const pricing = input.pricing && typeof input.pricing === 'object' ? Object.fromEntries(Object.entries(input.pricing).filter(([model, value]) => models.includes(model) && (value === 'free' || value === 'beta-free' || value === 'trial'))) as NonNullable<CustomProviderInput['pricing']> : {}
  return { id: input.id, name: input.name.trim(), kind: input.kind, apiBase: input.apiBase.trim(), apiKey: input.apiKey?.trim(), ...(workspaceId ? { workspaceId } : {}), models, ...(authentication ? { authentication } : {}), ...(account ? { account } : {}), ...(Object.keys(modelLabels).length ? { modelLabels } : {}), ...(reasoningModels.length ? { reasoningModels } : {}), ...(thinkingLevels && Object.keys(thinkingLevels).length ? { thinkingLevels } : {}), ...(Object.keys(pricing).length ? { pricing } : {}) }
}
/**
 * Provider configuration. FeltDB holds the non-secret record (endpoint, models,
 * a `credentialRef`); the API key lives only in the OS-backed credential vault.
 */
export class CustomModelStore {
  constructor(private repository: DesktopRepository, private vault: CredentialVault) {}
  private reference(id: string): string { return `provider:${id}` }
  private secret(id: string): string | undefined { return this.vault.get(this.reference(id)) }
  private oauthCredential(): OpenAICredential | undefined {
    try {
      const value = this.secret('openai')
      if (!value) return
      const parsed = JSON.parse(value) as OpenAICredential
      return parsed?.accessToken && parsed.refreshToken && parsed.clientId && parsed.subject ? parsed : undefined
    } catch { return }
  }
  private async openAIAccessToken(): Promise<string> {
    let credential = this.oauthCredential()
    if (!credential) throw new Error('OpenAI is not connected. Reconnect OpenAI in Settings.')
    if (credential.expiresAt <= Date.now() + 60_000) {
      credential = await refreshOpenAI(credential)
      this.vault.set(this.reference('openai'), JSON.stringify(credential))
    }
    return credential.accessToken
  }
  async list(): Promise<CustomModelConfig> {
    return {
      defaultModel: (await this.repository.setting<string>('defaultModel')) ?? '',
      providers: (await this.repository.providers()).map(record => ({ id: record.id, name: record.name, kind: record.kind, ...record.config, hasKey: !providerRequiresApiKey(record.kind) || this.vault.has(record.credentialRef ?? this.reference(record.id)) }))
    }
  }
  async records(): Promise<CustomProviderRecord[]> {
    return (await this.repository.providers()).flatMap(record => {
      const secret = this.secret(record.id) ?? ''
      const oauth = record.id === 'openai' && record.config.authentication === 'chatgpt-oauth'
      const apiKey = oauth ? this.oauthCredential()?.accessToken ?? '' : secret
      return apiKey || !providerRequiresApiKey(record.kind) ? [{ id: record.id, name: record.name, kind: record.kind, ...record.config, apiKey, ...(oauth ? { resolveApiKey: () => this.openAIAccessToken() } : {}) }] : []
    })
  }
  async connectOpenAI(openExternal: (url: string) => Promise<unknown>, signal: AbortSignal): Promise<CustomModelConfig> {
    const previous = this.oauthCredential()
    const hostReference = this.reference('openai-host')
    const registrationReference = this.reference('openai-registration')
    const hostId = previous?.hostId ?? this.vault.get(hostReference) ?? `urn:uuid:${randomUUID()}`
    if (!this.vault.has(hostReference)) this.vault.set(hostReference, hostId)
    let credential: OpenAICredential
    try {
      credential = await authorizeOpenAI(openExternal, signal, {
        previous,
        registeredClientId: previous ? undefined : this.vault.get(registrationReference),
        hostId,
        onRegistration: clientId => this.vault.set(registrationReference, clientId)
      })
    } catch (error) {
      // An invalid registration cannot be reused; the next attempt must start
      // dynamic registration again. Keep valid registrations after transient
      // or one-time-code failures as required by the OpenAI OAuth contract.
      if (error instanceof OpenAIAuthError && error.code === 'invalid_client') this.vault.delete(registrationReference)
      throw error
    }
    const catalog = await discoverOpenAIModels(credential.accessToken)
    const old = await this.repository.providers()
    const config: Omit<CustomProviderInput, 'id' | 'name' | 'kind'> = { apiBase: 'https://api.openai.com/v1', authentication: 'chatgpt-oauth', account: credential.email ?? credential.subject, models: catalog.models, modelLabels: catalog.labels, reasoningModels: Object.keys(catalog.thinkingLevels), thinkingLevels: catalog.thinkingLevels }
    this.vault.set(this.reference('openai'), JSON.stringify(credential))
    this.vault.delete(registrationReference)
    const record: ProviderRecord = { id: 'openai', name: 'OpenAI', kind: 'openai', config, credentialRef: this.reference('openai'), updatedAt: Date.now() }
    const providers = [...old.filter(item => item.id !== 'openai'), record]
    const current = (await this.repository.setting<string>('defaultModel')) ?? ''
    const defaultModel = current || `openai/${catalog.models[0]}`
    await this.repository.replaceProviders(providers, defaultModel)
    return this.list()
  }
  async disconnectOpenAI(): Promise<CustomModelConfig> {
    const providers = (await this.repository.providers()).filter(item => item.id !== 'openai')
    const choices = providers.filter(item => item.kind !== 'jev').flatMap(item => item.config.models.map(model => `${item.id}/${model}`))
    const current = (await this.repository.setting<string>('defaultModel')) ?? ''
    await this.repository.replaceProviders(providers, choices.includes(current) ? current : choices[0] ?? '')
    this.vault.delete(this.reference('openai'))
    this.vault.delete(this.reference('openai-registration'))
    return this.list()
  }
  async assertThinkingLevel(providerId: string, model: string, level: string | undefined): Promise<void> {
    if (!level || level === 'default' || level === 'off') return
    const providers = await this.repository.providers()
    let id = providerId, selected = model
    if (providerId === '@default') {
      const [defaultId, ...parts] = ((await this.repository.setting<string>('defaultModel')) ?? '').split('/')
      id = defaultId; selected = parts.join('/')
    }
    const provider = providers.find(item => item.id === id)
    const reported = provider?.config.thinkingLevels?.[selected]
    if (provider?.config.authentication === 'chatgpt-oauth' && (!reported || !reported.includes(level as never))) throw new Error(`The selected OpenAI model does not support the ${level} thinking level.`)
  }
  async save(inputs: CustomProviderInput[], defaultModel: string): Promise<CustomModelConfig> {
    if (!Array.isArray(inputs) || inputs.length > 30 || typeof defaultModel !== 'string') throw new Error("Invalid model configuration.")
    const old = new Map((await this.repository.providers()).map(record => [record.id, record]))
    const staged: { record: ProviderRecord; apiKey?: string }[] = inputs.map(validateCustomProvider).map(({ apiKey, ...p }) => {
      const previous = old.get(p.id)
      const sameDestination = previous && customEndpoint(previous.config.apiBase, previous.kind) === customEndpoint(p.apiBase, p.kind)
      const acceptsKey = p.kind !== 'ollama'
      const canReuseKey = acceptsKey && sameDestination && Boolean(previous?.credentialRef && this.vault.has(previous.credentialRef))
      // Never forward a stored key to a changed endpoint without explicit re-entry.
      if (p.authentication === 'chatgpt-oauth' && previous?.config.authentication === 'chatgpt-oauth' && !apiKey) {
        const { id, name, kind, ...config } = p
        return { record: { id, name, kind, config, credentialRef: this.reference(id), updatedAt: Date.now() } }
      }
      if (providerRequiresApiKey(p.kind) && !apiKey && previous && !sameDestination) throw new Error("The API URL changed. Enter the API key again.")
      if (providerRequiresApiKey(p.kind) && !apiKey && !canReuseKey) throw new Error("Enter an API key.")
      const { id, name, kind, ...config } = p
      return { apiKey, record: { id, name, kind, config, ...(acceptsKey && (apiKey || canReuseKey) ? { credentialRef: this.reference(id) } : {}), updatedAt: Date.now() } }
    })
    if (new Set(staged.map(item => item.record.id)).size !== staged.length) throw new Error("Duplicate provider IDs.")
    const choices = staged.filter(item => item.record.kind !== 'jev').flatMap(item => item.record.config.models.map(m => `${item.record.id}/${m}`))
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
    const key = p.apiKey || (p.authentication === 'chatgpt-oauth' && canReuse ? await this.openAIAccessToken() : canReuse ? this.secret(p.id) ?? '' : '')
    if (providerRequiresApiKey(p.kind) && !key) return { ok: false, error: 'Enter an API key. If the API URL changed, enter the key again.' }
    try {
      const nativeOpenAI = usesOpenAIResponses(p)
      const res = await fetch(nativeOpenAI ? 'https://api.openai.com/v1/responses' : customEndpoint(p.apiBase, p.kind), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: customProviderHeaders({ ...p, apiKey: key }, true),
        body: JSON.stringify(nativeOpenAI ? { model: input.model, max_output_tokens: 16, input: 'Hi', store: false }
          : p.kind === 'jev' ? { model: input.model, state: 'A test message.', questions: { test: { type: 'noul', instructions: 'Is the state a text message?' } } }
            : { model: input.model, ...completionTokenLimit(p, 16), messages: [{ role: 'user', content: 'Hi' }] })
      })
      if (!res.ok) {
        let detail: string | undefined
        try { detail = providerErrorDetail(await res.json(), key) } catch { /* Some providers return an empty or non-JSON error body. */ }
        return { ok: false, error: `Connection failed (HTTP ${res.status})${detail ? `: ${detail}` : '. Check the API URL, key, and model ID.'}` }
      }
      const data = await res.json() as { content?: unknown[]; choices?: unknown[]; model?: string; answers?: { test?: { noul?: unknown } } }
      if (!(p.kind === 'anthropic' ? Array.isArray(data.content) : p.kind === 'jev' ? typeof data.answers?.test?.noul === 'number' : nativeOpenAI ? typeof (data as { id?: unknown }).id === 'string' : Array.isArray(data.choices) && data.choices.length)) return { ok: false, error: 'The response format does not match the selected API type.' }
      return { ok: true, model: input.model }
    } catch { return { ok: false, error: 'Connection failed or timed out. Check the network and API URL.' } }
  }
}
/** The pi-ai model for one of a custom provider’s models, configured or discovered. */
export function customModelDefinition(p: CustomProviderRecord, model: string, limits: { contextWindow?: number; maxTokens?: number; image?: boolean } = {}): Model<any> {
  const id = CUSTOM_PROVIDER_PREFIX + p.id
  const endpoint = customEndpoint(p.apiBase, p.kind)
  const baseUrl = endpoint.slice(0, -(p.kind === 'anthropic' ? '/v1/messages'.length : '/chat/completions'.length))
  const reportedLevels = p.thinkingLevels?.[model]
  const thinkingLevelMap = reportedLevels ? Object.fromEntries(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, reportedLevels.includes(level as never) ? level : null])) : undefined
  return { id: model, name: p.modelLabels?.[model] ?? model, provider: id, baseUrl,
    api: p.kind === 'anthropic' ? 'anthropic-messages' : usesOpenAIResponses(p) ? 'openai-responses' : 'openai-completions', reasoning: Boolean(p.reasoningModels?.includes(model)), input: limits.image === false ? ['text'] : ['text', 'image'],
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: limits.contextWindow ?? 128000, maxTokens: limits.maxTokens ?? (p.reasoningModels?.includes(model) ? 32000 : 8192),
    compat: { maxTokensField: usesNativeOpenAITokens(p) ? 'max_completion_tokens' : 'max_tokens' }
  } as Model<any>
}
export function customModelProvider(p: CustomProviderRecord): Provider {
  if (!isChatModelProvider(p)) throw new Error('Jev providers are decision-only and cannot be registered as chat models.')
  const id = CUSTOM_PROVIDER_PREFIX + p.id
  const endpoint = customEndpoint(p.apiBase, p.kind)
  const baseUrl = endpoint.slice(0, -(p.kind === 'anthropic' ? '/v1/messages'.length : '/chat/completions'.length))
  const models = p.models.map(model => customModelDefinition(p, model))
  return createProvider({ id, name: p.name, baseUrl, models,
    auth: { apiKey: { name: p.name, resolve: async () => ({ auth: { apiKey: p.kind === 'ollama' ? 'ollama' : p.resolveApiKey ? await p.resolveApiKey() : p.apiKey, ...(p.kind === 'anthropic' && p.workspaceId ? { headers: { 'anthropic-workspace-id': p.workspaceId } } : {}) }, source: 'custom model settings' }) } },
    api: p.kind === 'anthropic' ? anthropic : usesOpenAIResponses(p) ? openaiResponses : openai
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
