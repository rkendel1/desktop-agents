/** Provider editor and endpoint conventions adapted from Termany ModelSettings. */
export type CustomModelKind = 'openai' | 'anthropic' | 'ollama'
export interface CustomProviderInput { id: string; name: string; kind: CustomModelKind; apiBase: string; apiKey?: string; models: string[]; modelLabels?: Record<string, string>
  /** Models that accept a thinking/reasoning parameter. Others always run with thinking off. */
  reasoningModels?: string[]
  /** What the person knows about a model’s price when the provider’s catalog does not say (an explicit entry): `free`, `beta-free` or `trial`. Never a key or a secret. */
  pricing?: Record<string, 'free' | 'beta-free' | 'trial'> }
export interface CustomProviderView extends Omit<CustomProviderInput, 'apiKey'> { hasKey: boolean }
export interface CustomModelConfig { providers: CustomProviderView[]; defaultModel: string }
export interface CustomModelTest { provider: CustomProviderInput; model: string }
export const CUSTOM_PROVIDER_PREFIX = 'custom:'
export function customEndpoint(base: string, kind: CustomModelKind): string {
  const value = base.trim().replace(/\/+$/, '') || (kind === 'anthropic' ? 'https://api.anthropic.com' : kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')
  const endpoint = kind === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
  return value.endsWith(endpoint) ? value : value.endsWith('/v1') ? value + endpoint.slice(3) : value + endpoint
}
export const CUSTOM_MODEL_PRESETS: Array<{ id: string; name: string; kind: CustomModelKind; apiBase: string; models: string[]; apiKeyUrl?: string }> = [
  { id: 'anthropic', apiKeyUrl: 'https://platform.claude.com/settings/keys', name: 'Anthropic', kind: 'anthropic', apiBase: 'https://api.anthropic.com', models: ['claude-opus-4-8'] },
  { id: 'openai', apiKeyUrl: 'https://platform.openai.com/api-keys', name: 'OpenAI', kind: 'openai', apiBase: 'https://api.openai.com/v1', models: ['gpt-5.6-sol'] },
  { id: 'openrouter', apiKeyUrl: 'https://openrouter.ai/settings/keys', name: 'OpenRouter', kind: 'openai', apiBase: 'https://openrouter.ai/api', models: ['xiaomi/mimo-v2.5'] },
  { id: 'tokendance', name: 'TokenDance', kind: 'openai', apiBase: 'https://tokendance.space/gateway/v1', models: ['mimo-v2.5'], apiKeyUrl: 'https://tokendance.space/keys' },
  { id: 'deepseek', apiKeyUrl: 'https://platform.deepseek.com/api_keys', name: 'DeepSeek', kind: 'openai', apiBase: 'https://api.deepseek.com', models: ['deepseek-flash'] },
  { id: 'ollama', name: 'Ollama', kind: 'ollama', apiBase: 'http://127.0.0.1:11434', models: [] },
]

export function providerRequiresApiKey(kind: CustomModelKind): boolean { return kind !== 'ollama' }
