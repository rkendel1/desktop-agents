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
  models.setProvider(customModelProvider({ ...provider, kind }))
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
  const payload = await request!.json() as { messages: Array<{ role: string; content: unknown[] }> }
  const userContent = payload.messages.find(message => message.role === 'user')!.content
  expect(userContent).toContainEqual(kind === 'openai'
    ? expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: 'data:image/png;base64,aW1hZ2U=' }) })
    : expect.objectContaining({ type: 'image', source: expect.objectContaining({ type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }) }))
  expect(request!.url).toBe(customEndpoint(provider.apiBase, kind))
  expect(request!.headers.get(kind === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(kind === 'anthropic' ? provider.apiKey : `Bearer ${provider.apiKey}`)
})
