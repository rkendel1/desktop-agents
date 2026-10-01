/** Provider editor and endpoint conventions adapted from Termany ModelSettings. */
export type CustomModelKind = 'openai' | 'anthropic' | 'ollama' | 'jev'
export interface CustomProviderInput { id: string; name: string; kind: CustomModelKind; apiBase: string; apiKey?: string; workspaceId?: string; models: string[]; modelLabels?: Record<string, string>
  /** The billing/authentication path. ChatGPT OAuth uses plan access; API keys use API billing. */
  authentication?: 'api-key' | 'chatgpt-oauth'
  /** A display-only identifier from a validated identity token. Never a credential. */
  account?: string
  /** Models that accept a thinking/reasoning parameter. Others always run with thinking off. */
  reasoningModels?: string[]
  /** Provider-reported reasoning choices. Absence means Foundry must not offer a thinking override. */
  thinkingLevels?: Record<string, Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>>
  /** What the person knows about a model’s price when the provider’s catalog does not say (an explicit entry): `free`, `beta-free` or `trial`. Never a key or a secret. */
  pricing?: Record<string, 'free' | 'beta-free' | 'trial'> }
export interface CustomProviderView extends Omit<CustomProviderInput, 'apiKey'> { hasKey: boolean }
export interface CustomModelConfig { providers: CustomProviderView[]; defaultModel: string }
export interface CustomModelTest { provider: CustomProviderInput; model: string }
export const CUSTOM_PROVIDER_PREFIX = 'custom:'
export function isChatModelProvider(provider: Pick<CustomProviderInput, 'kind'>): boolean { return provider.kind !== 'jev' }
export function customEndpoint(base: string, kind: CustomModelKind): string {
  const value = base.trim().replace(/\/+$/, '') || (kind === 'anthropic' ? 'https://api.anthropic.com' : kind === 'ollama' ? 'http://127.0.0.1:11434' : kind === 'jev' ? 'http://127.0.0.1:8765' : 'https://api.openai.com/v1')
  const endpoint = kind === 'anthropic' ? '/v1/messages' : kind === 'jev' ? '/v1/systemone' : '/v1/chat/completions'
  return value.endsWith(endpoint) ? value : value.endsWith('/v1') ? value + endpoint.slice(3) : value + endpoint
}
export const CUSTOM_MODEL_PRESETS: Array<{ id: string; name: string; kind: CustomModelKind; apiBase: string; models: string[]; apiKeyUrl?: string }> = [
  { id: 'anthropic', apiKeyUrl: 'https://platform.claude.com/settings/keys', name: 'Anthropic', kind: 'anthropic', apiBase: 'https://api.anthropic.com', models: ['claude-opus-4-8'] },
  { id: 'openai', apiKeyUrl: 'https://platform.openai.com/api-keys', name: 'OpenAI', kind: 'openai', apiBase: 'https://api.openai.com/v1', models: [] },
  { id: 'openrouter', apiKeyUrl: 'https://openrouter.ai/settings/keys', name: 'OpenRouter', kind: 'openai', apiBase: 'https://openrouter.ai/api', models: ['xiaomi/mimo-v2.5'] },
  { id: 'tokendance', name: 'TokenDance', kind: 'openai', apiBase: 'https://tokendance.space/gateway/v1', models: ['mimo-v2.5'], apiKeyUrl: 'https://tokendance.space/keys' },
  { id: 'deepseek', apiKeyUrl: 'https://platform.deepseek.com/api_keys', name: 'DeepSeek', kind: 'openai', apiBase: 'https://api.deepseek.com', models: ['deepseek-flash'] },
  { id: 'ollama-cloud', apiKeyUrl: 'https://ollama.com/settings/keys', name: 'Ollama Cloud', kind: 'openai', apiBase: 'https://ollama.com/v1', models: ['gemma4:31b'] },
  { id: 'ollama', name: 'Ollama', kind: 'ollama', apiBase: 'http://127.0.0.1:11434', models: [] },
  { id: 'jev-local', name: 'Jev (local)', kind: 'jev', apiBase: 'http://127.0.0.1:8765', models: ['jev-latest'] },
]

export function providerRequiresApiKey(kind: CustomModelKind): boolean { return kind !== 'ollama' && kind !== 'jev' }
