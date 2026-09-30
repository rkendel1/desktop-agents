import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { CUSTOM_PROVIDER_PREFIX } from '../../shared/customModels'
import { customModelDefinition, customModelProvider, validateCustomProvider, type CustomProviderRecord } from '../customModels'
import { customProviderAdapter, runsLocally } from './adapters'
import { ModelFabric } from './fabric'
import { requirementsOf, routedStream } from './stream'
import { MemoryStore } from './testing'
import { NO_ELIGIBLE_MESSAGE } from './router'

/**
 * The adapter and the streaming bridge against a real HTTP server that speaks the OpenAI-compatible protocol Foundry already uses for
 * custom providers: a catalog with prices and modalities, and chat completions that stream — or answer 429. Nothing about the server is
 * a real provider; its model names are made up here and only known to the test because the test wrote the catalog.
 */
type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })
async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => { let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => handler(request, response, body)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const sse = (response: ServerResponse, text: string): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  response.write(chunk({ role: 'assistant', content: '' })); for (const word of text.split(' ')) response.write(chunk({ content: `${word} ` }))
  response.write(chunk({}, 'stop')); response.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`); response.end('data: [DONE]\n\n')
}
const catalog = { data: [
  { id: 'alpha-free', pricing: { prompt: '0', completion: '0' }, context_length: 65536, supported_parameters: ['tools', 'structured_outputs'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'beta-free', pricing: { prompt: '0', completion: '0' }, context_length: 32768, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'gamma-paid', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'delta-unpriced', context_length: 8192 },
  { id: 'image-maker', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['image'] } }
] }
const record = (apiBase: string, patch: Partial<CustomProviderRecord> = {}): CustomProviderRecord => ({ id: 'catalogued', name: 'Catalogued', kind: 'openai', apiBase, apiKey: 'sk-test-SECRET-KEY-123', models: ['configured-only'], ...patch })
const registry = (records: CustomProviderRecord[]) => { const models = builtinModels(); for (const r of records) models.setProvider(customModelProvider(r)); return models }

describe('discovery from a provider’s own catalog', () => {
  it('reads models, prices, modalities and limits — and classifies access from them, failing closed', async () => {
    const base = await serve((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url === '/v1/models' ? catalog : {})) })
    const found = await customProviderAdapter(record(base), { stream: () => { throw new Error('unused') } }).discover()
    const by = Object.fromEntries(found.map(item => [item.model, item]))
    expect(Object.keys(by).sort()).toEqual(['alpha-free', 'beta-free', 'configured-only', 'delta-unpriced', 'gamma-paid'])   // the image model is not a chat model
    expect(by['alpha-free']).toMatchObject({ access: 'free', accessBasis: 'catalog-pricing', pricing: 'free', capabilities: { toolUse: true, structuredOutput: true, vision: false, contextTokens: 65536 }, limits: { contextTokens: 65536 } })
    expect(by['beta-free']).toMatchObject({ access: 'free', capabilities: { reasoning: true, vision: true, coding: true } })
    expect(by['gamma-paid']).toMatchObject({ access: 'paid', prices: { inputPerMillion: 3, outputPerMillion: 15 } })
    expect(by['delta-unpriced']).toMatchObject({ access: 'unknown', accessBasis: 'none' })
    expect(by['configured-only']).toMatchObject({ access: 'unknown' })   // configured, but nobody has said what it costs
    expect(JSON.stringify(found)).not.toContain('SECRET')
  })
  it('sends the provider’s credential to the provider and nowhere else', async () => {
    let seen: string | undefined
    const base = await serve((request, response) => { seen = request.headers.authorization; response.writeHead(200); response.end(JSON.stringify(catalog)) })
    await customProviderAdapter(record(base), { stream: () => { throw new Error('unused') } }).discover()
    expect(seen).toBe('Bearer sk-test-SECRET-KEY-123')
  })
  it('honours an explicit configured entry where the catalog says nothing, but never overrides a catalog that says paid', async () => {
    const base = await serve((_request, response) => { response.writeHead(200); response.end(JSON.stringify(catalog)) })
    const found = await customProviderAdapter(record(base, { models: ['delta-unpriced', 'gamma-paid', 'configured-only'], pricing: { 'delta-unpriced': 'free', 'gamma-paid': 'free', 'configured-only': 'beta-free' } }), { stream: () => { throw new Error('unused') } }).discover()
    const by = Object.fromEntries(found.map(item => [item.model, item]))
    expect(by['delta-unpriced']).toMatchObject({ access: 'free', accessBasis: 'configured' }); expect(by['gamma-paid']).toMatchObject({ access: 'paid' }); expect(by['configured-only']).toMatchObject({ access: 'beta', accessBasis: 'configured' })
  })
  it('uses the configured models when the provider has no catalog (404), and reports a catalog that cannot be reached as a failure so the previous answer stands', async () => {
    const none = await serve((_request, response) => { response.writeHead(404); response.end('{}') })
    expect((await customProviderAdapter(record(none), { stream: () => { throw new Error('unused') } }).discover()).map(item => item.model)).toEqual(['configured-only'])
    const broken = await serve((_request, response) => { response.writeHead(502); response.end('{}') })
    await expect(customProviderAdapter(record(broken), { stream: () => { throw new Error('unused') } }).discover()).rejects.toThrow(/HTTP 502/)
  })
  it('takes only Ollama’s own service as local — not its cloud models, and not a loopback address, which may be a gateway to a paid provider', async () => {
    const base = await serve((request, response) => { response.writeHead(200); response.end(JSON.stringify(request.url === '/api/tags' ? { models: [{ name: 'llama-x' }, { model: 'qwen-y' }, { name: 'big:cloud' }] } : {})) })
    const ollama = record(base, { kind: 'ollama', apiKey: '', models: [] })
    expect(runsLocally(ollama, 'llama-x')).toBe(true); expect(runsLocally(ollama, 'big:cloud')).toBe(false); expect(runsLocally(record('http://localhost:1234'), 'anything')).toBe(false)
    const found = await customProviderAdapter(ollama, { stream: () => { throw new Error('unused') } }).discover()
    expect(found.map(item => [item.model, item.access, item.accessBasis])).toEqual([['llama-x', 'local', 'local-endpoint'], ['qwen-y', 'local', 'local-endpoint'], ['big:cloud', 'unknown', 'none']])
  })
  it('classifies an OpenAI-compatible server on a loopback address from its catalog, not from where it listens', async () => {
    const base = await serve((_request, response) => { response.writeHead(200); response.end(JSON.stringify({ data: [{ id: 'behind-gateway' }] })) })
    expect(base).toMatch(/127\.0\.0\.1/)
    expect((await customProviderAdapter(record(base, { models: [] }), { stream: () => { throw new Error('unused') } }).discover())[0]).toMatchObject({ access: 'unknown' })
  })
})

describe('the whole path on a real server: discovery → routing → streaming → cycling', () => {
  it('routes to a free model, cycles past a rate-limited one before any output, never touches the paid endpoint, and records the decision', async () => {
    const hits: string[] = []
    const base = await serve((request, response, body) => {
      if (request.url === '/v1/models') { response.writeHead(200); response.end(JSON.stringify(catalog)); return }
      const model = JSON.parse(body).model as string; hits.push(model)
      if (model === 'gamma-paid') { response.writeHead(500); response.end('{"error":"PAID MODEL WAS CALLED"}'); return }
      if (model === 'alpha-free') { response.writeHead(429, { 'retry-after': '1' }); response.end('{"error":{"message":"Rate limit exceeded"}}'); return }
      sse(response, 'Hello from the second model')
    })
    const r = record(base, { models: [] }); const models = registry([r])
    const adapter = customProviderAdapter(r, { stream: (model, context, options) => models.streamSimple(model as never, context, options) })
    const fabric = new ModelFabric(new MemoryStore(), () => [adapter]); await fabric.discover(); await fabric.setPolicy({ automatic: true })
    // Alpha ranks first on ties (by id) and is rate limited; beta is next; gamma is paid and unknown/unpriced are excluded.
    const context: Context = { messages: [{ role: 'user', content: 'Say hello', timestamp: Date.now() }] }
    const decisions: unknown[] = []
    const stream = routedStream({ fabric, request: fabric.request('general', requirementsOf(context)), context,
      open: (candidate, ctx, options) => { const model = customModelDefinition(r, candidate.model, { ...(candidate.limits.contextTokens ? { contextWindow: candidate.limits.contextTokens } : {}) }); return { model, stream: models.streamSimple(model as never, ctx, options) } },
      onDecision: decision => decisions.push(decision) })
    const events: string[] = []; for await (const event of stream) events.push(event.type)
    const message = await stream.result()
    expect(message.stopReason).toBe('stop'); expect(message.content.map(part => part.type === 'text' ? part.text : '').join('')).toContain('Hello from the second model')
    expect(hits).toEqual(['alpha-free', 'beta-free']); expect(hits).not.toContain('gamma-paid'); expect(hits).not.toContain('delta-unpriced')
    expect(events[0]).toBe('start'); expect(events.at(-1)).toBe('done')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ outcome: 'succeeded', selected: 'catalogued/beta-free', costPolicy: 'Free only · $0 maximum', policy: { kind: 'free-only' }, ranked: ['catalogued/alpha-free', 'catalogued/beta-free'] })
    expect((decisions[0] as { attempts: { model: string; retryReason?: string }[] }).attempts.map(item => [item.model, item.retryReason])).toEqual([['catalogued/alpha-free', 'rate-limited'], ['catalogued/beta-free', undefined]])
    expect((decisions[0] as { rejected: { model: string; reason: string }[] }).rejected.map(item => `${item.model}:${item.reason}`)).toEqual(expect.arrayContaining(['catalogued/gamma-paid:not-free', 'catalogued/delta-unpriced:unknown-pricing', 'catalogued/configured-only:unknown-pricing'].slice(0, 2)))
    // The rate-limited model now rests; the next request goes straight to the one that worked.
    expect((await fabric.entries()).find(entry => entry.candidate.model === 'alpha-free')!.health.state).toBe('cooldown')
  })

  it('when every free model is limited the stream ends with the clear message, and the paid model is still not called', async () => {
    const hits: string[] = []
    const base = await serve((request, response, body) => {
      if (request.url === '/v1/models') { response.writeHead(200); response.end(JSON.stringify(catalog)); return }
      hits.push(JSON.parse(body).model); response.writeHead(429); response.end('{"error":{"message":"Too many requests"}}')
    })
    const r = record(base, { models: [] }); const models = registry([r])
    const fabric = new ModelFabric(new MemoryStore(), () => [customProviderAdapter(r, { stream: (m, c, o) => models.streamSimple(m as never, c, o) })]); await fabric.discover()
    const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }
    const stream = routedStream({ fabric, request: fabric.request('general', requirementsOf(context)), context, open: (candidate, ctx, options) => { const model = customModelDefinition(r, candidate.model); return { model, stream: models.streamSimple(model as never, ctx, options) } } })
    for await (const _ of stream) { /* drain */ }
    const message = await stream.result()
    expect(message.stopReason).toBe('error'); expect(message.errorMessage).toBe(NO_ELIGIBLE_MESSAGE)
    expect(hits.sort()).toEqual(['alpha-free', 'beta-free']); expect(fabric.recentDecisions()[0]).toMatchObject({ outcome: 'no-eligible-model' })
  })

  it('invoke() returns text through the same path, and a credential failure is final rather than retried on another model', async () => {
    const hits: string[] = []
    const base = await serve((request, response, body) => {
      if (request.url === '/v1/models') { response.writeHead(200); response.end(JSON.stringify(catalog)); return }
      hits.push(JSON.parse(body).model); response.writeHead(401); response.end('{"error":{"message":"Invalid API key"}}')
    })
    const r = record(base, { models: [] }); const models = registry([r])
    const fabric = new ModelFabric(new MemoryStore(), () => [customProviderAdapter(r, { stream: (m, c, o) => models.streamSimple(m as never, c, o) })]); await fabric.discover()
    await expect(fabric.complete(fabric.request('general'), 'hi')).rejects.toMatchObject({ name: 'ModelRoutingError', message: expect.stringContaining('would fail the same way') })
    expect(hits).toEqual(['alpha-free'])
  })
})

describe('requirements are read from the request', () => {
  it('tools need tool use, images need vision, and the context needs to fit', () => {
    const plain = requirementsOf({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })
    expect(plain).toMatchObject({ minimumContextTokens: expect.any(Number) }); expect(plain.toolUse).toBeUndefined(); expect(plain.vision).toBeUndefined()
    const rich = requirementsOf({ messages: [{ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: 'what is this' }], timestamp: 1 }], tools: [{ name: 't', description: 'd', parameters: {} as never }] })
    expect(rich).toMatchObject({ toolUse: true, vision: true })
    expect(CUSTOM_PROVIDER_PREFIX).toBe('custom:')
  })
})

describe('an explicit configured entry', () => {
  it('keeps only valid pricing statements about the provider’s own listed models, and never a credential', () => {
    const valid = validateCustomProvider({ id: 'mine', name: 'Mine', kind: 'openai', apiBase: 'https://gateway.example/v1', apiKey: 'sk-test-SECRET-KEY-123', models: ['a', 'b'],
      pricing: { a: 'free', b: 'expensive' as never, ghost: 'free' } })
    expect(valid.pricing).toEqual({ a: 'free' })
    const { apiKey: _key, ...stored } = valid
    expect(JSON.stringify(stored)).not.toContain('SECRET')
  })
})
