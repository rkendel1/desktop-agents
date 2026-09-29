import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from './credentialVault'
import { createTestDesktop, disposeTestDesktops } from './testSupport'
import { afterEach, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import { CustomModelStore, customModelProvider } from './customModels'
import { customEndpoint } from '../shared/customModels'
const folders: string[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-models-')); folders.push(directory)
  const desktop = createTestDesktop()
  const vault = new CredentialVault(directory, { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() })
  const store = new CustomModelStore(desktop.repository, vault)
  return { store, directory, desktop, vault }
}
const provider = { id: 'example', name: 'Example', kind: 'openai' as const, apiBase: 'https://example.com/v1', apiKey: 'secret-test-key', models: ['org/model'] }
afterEach(() => { disposeTestDesktops(); vi.unstubAllGlobals(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
it('keeps keys out of public state and FeltDB while retaining omitted keys', () => {
  const { store, directory, desktop, vault } = setup()
  const config = store.save([provider], 'example/org/model')
  expect(JSON.stringify(config)).not.toContain(provider.apiKey)
  expect(config.providers[0].hasKey).toBe(true)
  // Provider configuration is durable FeltDB state; the secret is not.
  expect(desktop.repository.providers()[0]).toMatchObject({ id: 'example', credentialRef: 'provider:example' })
  expect(JSON.stringify(desktop.repository.providers())).not.toContain(provider.apiKey)
  const feltDirectory = join(desktop.root, 'felt')
  for (const entry of readdirSync(feltDirectory, { withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(feltDirectory, entry.name), 'utf8')).not.toContain(provider.apiKey)
  expect(readFileSync(join(directory, 'vault.json'), 'utf8')).not.toContain(provider.apiKey)
  expect(vault.get('provider:example')).toBe(provider.apiKey)
  store.save([{ ...provider, apiKey: undefined, name: 'Renamed' }], config.defaultModel)
  expect(store.records()[0].apiKey).toBe(provider.apiKey)
  expect(() => store.save([{ ...provider, apiBase: 'https://other.example', apiKey: undefined }], '')).toThrow('Enter the API key again')
  expect(store.save([], config.defaultModel)).toEqual({ providers: [], defaultModel: '' })
  expect(vault.has('provider:example')).toBe(false)
})
it('survives a restart with configuration in FeltDB and the key in the vault', () => {
  const { store, desktop, vault } = setup()
  store.save([provider], 'example/org/model')
  const reopened = new CustomModelStore(desktop.restart(), vault)
  expect(reopened.list()).toMatchObject({ defaultModel: 'example/org/model', providers: [{ id: 'example', hasKey: true }] })
  expect(reopened.records()[0].apiKey).toBe(provider.apiKey)
})
it('normalizes complete and versioned endpoints without duplicate v1', () => {
  expect(customEndpoint('https://example.com/v1/', 'openai')).toBe('https://example.com/v1/chat/completions')
  expect(customEndpoint('https://example.com/v1/chat/completions', 'openai')).toBe('https://example.com/v1/chat/completions')
  expect(customEndpoint('https://example.com/anthropic', 'anthropic')).toBe('https://example.com/anthropic/v1/messages')
})
it('tests with a saved key, blocks changed destinations, and does not echo upstream secrets', async () => {
  const { store } = setup(); store.save([provider], '')
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
it.each(['openai', 'anthropic'] as const)('registers %s models with the configured key and endpoint', async kind => {
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
