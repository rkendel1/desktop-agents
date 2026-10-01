import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from './credentialVault'
import { createTestDesktop, disposeTestDesktops } from './testSupport'
import { afterEach, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import { CustomModelStore, customModelProvider, detectOllama } from './customModels'
import { customEndpoint } from '../shared/customModels'
const folders: string[] = []
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-models-')); folders.push(directory)
  const desktop = await createTestDesktop()
  const vault = new CredentialVault(directory, { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() })
  const store = new CustomModelStore(desktop.repository, vault)
  return { store, directory, desktop, vault }
}
const provider = { id: 'example', name: 'Example', kind: 'openai' as const, apiBase: 'https://example.com/v1', apiKey: 'secret-test-key', models: ['org/model'] }
afterEach(async () => { await disposeTestDesktops(); vi.unstubAllGlobals(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
it('keeps keys out of public state and FeltDB while retaining omitted keys', async () => {
  const { store, directory, desktop, vault } = await setup()
  const config = await store.save([provider], 'example/org/model')
  expect(JSON.stringify(config)).not.toContain(provider.apiKey)
  expect(config.providers[0].hasKey).toBe(true)
  // Provider configuration is durable FeltDB state; the secret is not.
  expect((await desktop.repository.providers())[0]).toMatchObject({ id: 'example', credentialRef: 'provider:example' })
  expect(JSON.stringify((await desktop.repository.providers()))).not.toContain(provider.apiKey)
  const feltDirectory = join(desktop.root, 'felt')
  for (const entry of readdirSync(feltDirectory, { withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(feltDirectory, entry.name), 'utf8')).not.toContain(provider.apiKey)
  expect(readFileSync(join(directory, 'vault.json'), 'utf8')).not.toContain(provider.apiKey)
  expect(vault.get('provider:example')).toBe(provider.apiKey)
  await store.save([{ ...provider, apiKey: undefined, name: 'Renamed' }], config.defaultModel)
  expect((await store.records())[0].apiKey).toBe(provider.apiKey)
  await expect(() => store.save([{ ...provider, apiBase: 'https://other.example', apiKey: undefined }], '')).rejects.toThrow('Enter the API key again')
  expect((await store.save([], config.defaultModel))).toEqual({ providers: [], defaultModel: '' })
  expect(vault.has('provider:example')).toBe(false)
})
it('survives a restart with configuration in FeltDB and the key in the vault', async () => {
  const { store, desktop, vault } = await setup()
  await store.save([provider], 'example/org/model')
  const reopened = new CustomModelStore(await desktop.restart(), vault)
  expect((await reopened.list())).toMatchObject({ defaultModel: 'example/org/model', providers: [{ id: 'example', hasKey: true }] })
  expect((await reopened.records())[0].apiKey).toBe(provider.apiKey)
})
it('keeps ChatGPT OAuth credentials vault-only and removes them on disconnect', async () => {
  const { store, desktop, vault } = await setup()
  const credential = { issuer: 'https://auth.openai.com', subject: 'account-1', clientId: 'oaiapp_foundry', hostId: 'urn:uuid:host', idToken: 'identity-secret', accessToken: 'access-secret', refreshToken: 'refresh-secret', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 60_000 }
  vault.set('provider:openai', JSON.stringify(credential))
  await desktop.repository.replaceProviders([{ id: 'openai', name: 'OpenAI', kind: 'openai', credentialRef: 'provider:openai', updatedAt: Date.now(), config: { apiBase: 'https://api.openai.com/v1', authentication: 'chatgpt-oauth', account: 'person@example.com', models: ['available-model'], reasoningModels: ['available-model'], thinkingLevels: { 'available-model': ['low', 'high'] } } }], 'openai/available-model')
  expect(JSON.stringify(await store.list())).not.toContain('secret')
  const record = (await store.records())[0]
  expect(record.apiKey).toBe('access-secret')
  expect(customModelProvider(record).getModels()[0]).toMatchObject({ api: 'openai-responses', thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null } })
  await expect(store.assertThinkingLevel('openai', 'available-model', 'high')).resolves.toBeUndefined()
  await expect(store.assertThinkingLevel('openai', 'available-model', 'medium')).rejects.toThrow('does not support')
  await expect(store.disconnectOpenAI()).resolves.toEqual({ providers: [], defaultModel: '' })
  expect(vault.has('provider:openai')).toBe(false)
})
it('detects installed Ollama models and ignores unavailable or empty services', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { model: 'qwen3:8b' }, { name: 'llama3.2:latest' }] })))
  await expect(detectOllama(request)).resolves.toEqual({ id: 'ollama', name: 'Ollama', kind: 'ollama', apiBase: 'http://127.0.0.1:11434', models: ['llama3.2:latest', 'qwen3:8b'] })
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.objectContaining({ redirect: 'error' }))
  await expect(detectOllama(async () => new Response(JSON.stringify({ models: [] })))).resolves.toBeNull()
  await expect(detectOllama(async () => { throw new Error('offline') })).resolves.toBeNull()
})
it('persists and loads Ollama without a credential', async () => {
  const { store, vault, desktop } = await setup()
  const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama' as const, apiBase: 'http://127.0.0.1:11434', models: ['llama3.2'] }
  expect(await store.save([ollama], 'ollama/llama3.2')).toMatchObject({ providers: [{ id: 'ollama', hasKey: true }], defaultModel: 'ollama/llama3.2' })
  expect(vault.has('provider:ollama')).toBe(false)
  expect((await desktop.repository.providers())[0].credentialRef).toBeUndefined()
  expect((await store.records())[0]).toMatchObject({ ...ollama, apiKey: '' })
  await store.save([{ ...provider, id: 'ollama' }], 'ollama/org/model')
  expect(vault.has('provider:ollama')).toBe(true)
  await store.save([ollama], 'ollama/llama3.2')
  expect(vault.has('provider:ollama')).toBe(false)
  await expect(store.save([{ ...provider, id: 'ollama', apiKey: undefined }], '')).rejects.toThrow(/API key/)
})
it('normalizes complete and versioned endpoints without duplicate v1', () => {
  expect(customEndpoint('https://example.com/v1/', 'openai')).toBe('https://example.com/v1/chat/completions')
  expect(customEndpoint('https://example.com/v1/chat/completions', 'openai')).toBe('https://example.com/v1/chat/completions')
  expect(customEndpoint('https://example.com/anthropic', 'anthropic')).toBe('https://example.com/anthropic/v1/messages')
  expect(customEndpoint('', 'ollama')).toBe('http://127.0.0.1:11434/v1/chat/completions')
  expect(customEndpoint('', 'jev')).toBe('http://127.0.0.1:8765/v1/systemone')
  expect(customEndpoint('http://127.0.0.1:8765/v1', 'jev')).toBe('http://127.0.0.1:8765/v1/systemone')
  expect(customEndpoint('http://127.0.0.1:8765/v1/systemone', 'jev')).toBe('http://127.0.0.1:8765/v1/systemone')
})
it('persists and probes a keyless local Jev provider without making it a chat default', async () => {
  const { store, vault } = await setup()
  const jev = { id: 'jev-local', name: 'Jev (local)', kind: 'jev' as const, apiBase: 'http://127.0.0.1:8765', models: ['local-decision-model'] }
  expect(await store.save([jev], '')).toMatchObject({ providers: [{ ...jev, hasKey: true }], defaultModel: '' })
  expect(vault.has('provider:jev-local')).toBe(false)
  expect((await store.records())[0]).toMatchObject({ ...jev, apiKey: '' })
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    sent = new Request(input, init)
    return Response.json({ model: 'local-decision-model', answers: { test: { type: 'noul', noul: .99 } } })
  })
  await expect(store.test({ provider: jev, model: 'local-decision-model' })).resolves.toEqual({ ok: true, model: 'local-decision-model' })
  expect(sent!.url).toBe('http://127.0.0.1:8765/v1/systemone')
  expect(sent!.headers.has('authorization')).toBe(false)
  await expect(sent!.json()).resolves.toEqual({ model: 'local-decision-model', state: 'A test message.', questions: { test: { type: 'noul', instructions: 'Is the state a text message?' } } })
  expect(() => customModelProvider({ ...jev, apiKey: '' })).toThrow('decision-only')
  await store.save([{ ...jev, apiKey: 'optional-local-secret' }], '')
  expect(vault.get('provider:jev-local')).toBe('optional-local-secret')
  expect((await store.records())[0].apiKey).toBe('optional-local-secret')
})
it('tests with a saved key, blocks changed destinations, and does not echo upstream secrets', async () => {
  const { store } = await setup(); await store.save([provider], '')
  const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }))
  vi.stubGlobal('fetch', request)
  expect(await store.test({ provider: { ...provider, apiKey: '' }, model: 'org/model' })).toMatchObject({ ok: true })
  expect(request.mock.calls[0]).toBeTruthy()
  request.mockClear()
  expect(await store.test({ provider: { ...provider, apiBase: 'https://other.example', apiKey: '' }, model: 'org/model' })).toMatchObject({ ok: false })
  expect(request).not.toHaveBeenCalled()
  request.mockImplementation(async () => new Response(provider.apiKey, { status: 401 }))
  expect(JSON.stringify(await store.test({ provider, model: 'org/model' }))).not.toContain(provider.apiKey)
})
it('sends an Anthropic Messages test request and returns its structured HTTP error', async () => {
  const { store } = await setup()
  const anthropic = { ...provider, kind: 'anthropic' as const, apiBase: 'https://api.anthropic.com', workspaceId: 'wrkspc_test', models: ['invalid model'] }
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    sent = new Request(input, init)
    return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model: invalid model' } }, { status: 400 })
  })
  await expect(store.test({ provider: anthropic, model: 'invalid model' })).resolves.toEqual({ ok: false, error: 'Connection failed (HTTP 400): model: invalid model' })
  expect(sent!.url).toBe('https://api.anthropic.com/v1/messages')
  expect(sent!.headers.get('x-api-key')).toBe(provider.apiKey)
  expect(sent!.headers.get('anthropic-version')).toBe('2023-06-01')
  expect(sent!.headers.get('anthropic-workspace-id')).toBe('wrkspc_test')
  await expect(sent!.json()).resolves.toEqual({ model: 'invalid model', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
})
it('uses max_completion_tokens for a native OpenAI connection test', async () => {
  const { store } = await setup()
  const openai = { ...provider, apiBase: 'https://api.openai.com/v1', models: ['gpt-test'] }
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    sent = new Request(input, init)
    return Response.json({ choices: [{ message: { content: 'Hi' } }] })
  })
  await expect(store.test({ provider: openai, model: 'gpt-test' })).resolves.toMatchObject({ ok: true })
  await expect(sent!.json()).resolves.toEqual({ model: 'gpt-test', max_completion_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
  expect(customModelProvider({ ...openai, apiKey: provider.apiKey }).getModels()[0].compat).toMatchObject({ maxTokensField: 'max_completion_tokens' })
})
it('uses Ollama Cloud through its authenticated OpenAI-compatible endpoint', async () => {
  const { store } = await setup()
  const cloud = { id: 'ollama-cloud', name: 'Ollama Cloud', kind: 'openai' as const, apiBase: 'https://ollama.com/v1', apiKey: 'ollama-secret', models: ['gemma4:31b'] }
  let sent: Request | undefined
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    sent = new Request(input, init)
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello!' } }], model: 'gemma4:31b' })
  })
  await expect(store.test({ provider: cloud, model: 'gemma4:31b' })).resolves.toMatchObject({ ok: true })
  expect(sent!.url).toBe('https://ollama.com/v1/chat/completions')
  expect(sent!.headers.get('authorization')).toBe('Bearer ollama-secret')
  await expect(sent!.json()).resolves.toEqual({ model: 'gemma4:31b', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
})
it.each(['openai', 'anthropic', 'ollama'] as const)('registers %s models with the configured key and endpoint', async kind => {
  const models = createModels()
  models.setProvider(customModelProvider({ ...provider, kind }))
  const model = models.getModel('custom:example', 'org/model')!
  expect(model.api).toBe(kind === 'anthropic' ? 'anthropic-messages' : 'openai-completions')
  expect(model.baseUrl).toBe(kind === 'anthropic' ? 'https://example.com' : 'https://example.com/v1')
  expect(await models.checkAuth('custom:example')).toBeTruthy()
})

it.each(['openai', 'anthropic'] as const)('streams a real SDK turn through the custom %s adapter', async kind => {
  const models = createModels()
  const configured = { ...provider, kind, ...(kind === 'openai' ? { apiBase: 'https://api.openai.com/v1' } : { workspaceId: 'wrkspc_test' }) }
  models.setProvider(customModelProvider(configured))
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const body = kind === 'openai'
    ? `data: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    : event('message_start', { type: 'message_start', message: { id: 'reply', type: 'message', role: 'assistant', model: 'org/model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
      + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })
      + event('content_block_stop', { type: 'content_block_stop', index: 0 })
      + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      + event('message_stop', { type: 'message_stop' })
  let request: Request | undefined
  const transport: typeof fetch = async (input, init) => {
    request = new Request(input, init)
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const reply = await models.completeSimple(models.getModel('custom:example', 'org/model')!, { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this image?' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }], timestamp: Date.now() }] }, { fetch: transport })
  expect(reply.stopReason).not.toBe('error')
  expect(reply.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello' }))
  const payload = await request!.json() as { messages: Array<{ role: string; content: unknown[] }>; max_tokens?: number; max_completion_tokens?: number }
  const userContent = payload.messages.find(message => message.role === 'user')!.content
  expect(userContent).toContainEqual(kind === 'openai'
    ? expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: 'data:image/png;base64,aW1hZ2U=' }) })
    : expect.objectContaining({ type: 'image', source: expect.objectContaining({ type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }) }))
  expect(request!.url).toBe(customEndpoint(configured.apiBase, kind))
  expect(request!.headers.get(kind === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(kind === 'anthropic' ? provider.apiKey : `Bearer ${provider.apiKey}`)
  if (kind === 'anthropic') expect(request!.headers.get('anthropic-workspace-id')).toBe('wrkspc_test')
  else { expect(payload.max_completion_tokens).toBeTruthy(); expect(payload.max_tokens).toBeUndefined() }
})
