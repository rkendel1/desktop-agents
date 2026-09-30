import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import type { ComputerProvider } from '../computer'
import { DouchatRuntime } from '../runtime'
import { openAtFile } from '../testSupport'
import type { CustomProviderRecord } from '../customModels'
import { customProviderAdapters } from './adapters'
import { ModelFabric } from './fabric'
import { MemoryStore } from './testing'

/**
 * An agent’s real model call through the runtime, with the fabric attached: the Agent’s own `streamFn` (the seam the runtime gives every
 * turn) against a real local server. Off, it is the agent’s own model exactly as before; on, it is routed under the cost policy, cycles
 * past a rate limit before any output, records a “Model switched” note in Activity, and never touches the paid model.
 */
const idleComputer = { snapshots: () => [], start: async () => undefined, stop: async () => undefined, show: async () => undefined, createTools: () => [], dispose: () => undefined } as unknown as ComputerProvider
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

const catalog = { data: [
  { id: 'alpha-free', pricing: { prompt: '0', completion: '0' }, context_length: 65536, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'beta-free', pricing: { prompt: '0', completion: '0' }, context_length: 65536, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'gamma-paid', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
] }

async function world(limit: (model: string) => boolean, automaticModelSelection = false) {
  const hits: string[] = []
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url === '/v1/models') { response.writeHead(200); response.end(JSON.stringify(catalog)); return }
      const model = JSON.parse(body).model as string; hits.push(model)
      if (limit(model)) { response.writeHead(429); response.end('{"error":{"message":"Rate limit exceeded"}}'); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.write(chunk({ role: 'assistant', content: '' })); response.write(chunk({ content: `answered by ${model}` })); response.write(chunk({}, 'stop')); response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  const directory = mkdtempSync(join(tmpdir(), 'foundry-fabric-runtime-')); directories.push(directory)
  const store = await openAtFile(join(directory, 'state.json'), { seedDemo: true })
  const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
  const record: CustomProviderRecord = { id: 'mine', name: 'Mine', kind: 'openai', apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'sk-test-SECRET-KEY-123', models: ['gamma-paid'] }
  await runtime.configureCustomModels([record], 'mine/gamma-paid')
  const fabric = new ModelFabric(new MemoryStore(), () => customProviderAdapters([record], { stream: runtime.streamModel as never }))
  runtime.attachModelFabric(fabric)
  const agent = await store.createAgent({ name: 'Coder', role: 'Assistant', instructions: '', color: '#fff', automaticModelSelection, ...runtime.customAgentModel('mine', 'gamma-paid') })
  const conversation = (await store.conversations()).find(item => item.type === 'direct' && item.agentIds.includes(agent.id))!
  const key = `direct:${conversation.id}:${await store.activeTopicId(conversation.id)}`
  const internals = runtime as unknown as { session: (config: typeof agent, key: string, context: 'direct') => Promise<{ streamFunction: (model: unknown, context: Context) => AsyncIterable<{ type: string }> & { result(): Promise<{ stopReason: string; content: { type: string; text?: string }[]; errorMessage?: string }> }; state: { model: unknown } }>; activeRun: Map<string, string> }
  const session = await internals.session(agent, key, 'direct')
  const ask = async () => { const stream = session.streamFunction(session.state.model, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] }); for await (const _ of stream) { /* drain */ }; return stream.result() }
  return { hits, runtime, fabric, store, internals, key, ask }
}

describe('the runtime with the model fabric attached', () => {
  it('automatic selection off (the default): the agent’s own model is used, exactly as before — even a paid one', async () => {
    const w = await world(() => false)
    const message = await w.ask()
    expect(w.hits).toEqual(['gamma-paid']); expect(message.content.map(part => part.text).join('')).toBe('answered by gamma-paid')
  })

  it('automatic selection on: routed to a free model, cycling past a rate limit, with a Model switched note in Activity — and the paid model is never called', async () => {
    const w = await world(model => model === 'alpha-free')
    await w.fabric.discover(); await w.fabric.setPolicy({ automatic: true })
    const events = vi.spyOn(w.store, 'addRunEvent').mockResolvedValue({} as never)
    w.internals.activeRun.set(w.key, 'run-1')
    const message = await w.ask()
    expect(message.stopReason).toBe('stop'); expect(message.content.map(part => part.text).join('')).toBe('answered by beta-free')
    expect(w.hits).toEqual(['alpha-free', 'beta-free']); expect(w.hits).not.toContain('gamma-paid')
    await vi.waitFor(() => expect(events).toHaveBeenCalled())
    expect(events).toHaveBeenCalledWith({ runId: 'run-1', type: 'status', label: 'Model switched', detail: expect.stringContaining('alpha-free · Mine reached its current limit. Foundry continued with beta-free · Mine. No action required. Cost policy: Free only') })
  })

  it('allows one agent to choose the best model while global automatic selection is off', async () => {
    const w = await world(() => false, true)
    await w.fabric.discover()
    await w.ask()
    expect(w.hits.at(-1)).not.toBe('gamma-paid')
    expect((await w.fabric.policy()).automatic).toBe(false)
  })

  it('when every free model is limited the agent’s call fails with the clear message, says so in Activity, and still does not spend', async () => {
    const w = await world(model => model !== 'gamma-paid')
    await w.fabric.discover(); await w.fabric.setPolicy({ automatic: true })
    const events = vi.spyOn(w.store, 'addRunEvent').mockResolvedValue({} as never)
    w.internals.activeRun.set(w.key, 'run-2')
    const message = await w.ask()
    expect(message.stopReason).toBe('error'); expect(message.errorMessage).toContain('No paid model was used.')
    expect(w.hits.sort()).toEqual(['alpha-free', 'beta-free']); expect(w.hits).not.toContain('gamma-paid')
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ label: 'Models unavailable', detail: expect.stringContaining('No paid model was used.') })))
  })

  it('reads the policy on each call: turning automatic selection off returns the agent to its own model at once', async () => {
    const w = await world(() => false)
    await w.fabric.discover(); await w.fabric.setPolicy({ automatic: true })
    await w.ask(); expect(w.hits.at(-1)).not.toBe('gamma-paid')
    await w.fabric.setPolicy({ automatic: false }); await w.ask(); expect(w.hits.at(-1)).toBe('gamma-paid')
  })
})
