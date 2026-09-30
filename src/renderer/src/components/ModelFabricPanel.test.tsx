// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelFabricStatus, ModelStatusEntry } from '../../../shared/modelFabric'
import { ModelFabricPanel } from './ModelFabricPanel'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(values[key])) }))

const health = { state: 'healthy' as const, requests: 183, successes: 178, failures: 5, rateLimited: 2, timeouts: 1, p50LatencyMs: 820, p95LatencyMs: 2100, consecutiveFailures: 0, toolCalls: 0, toolCallSuccesses: 0, structuredOutputs: 0, structuredOutputSuccesses: 0 }
const entry = (id: string, patch: { access?: 'free' | 'paid' | 'unknown' | 'beta'; eligible?: boolean; rejection?: ModelStatusEntry['rejection']; enabled?: boolean; health?: Partial<typeof health> } = {}): ModelStatusEntry => {
  const [provider, model] = id.split('/')
  return { candidate: { id, provider: provider!, providerName: provider!.toUpperCase(), model: model!, access: patch.access ?? 'free', accessBasis: 'catalog-pricing', pricing: 'free',
    capabilities: { chat: true, reasoning: true, coding: true, vision: false, toolUse: true, structuredOutput: true, streaming: true, contextTokens: 128_000 }, limits: {}, availability: { state: 'available' }, observedAt: 1_800_000_000_000, expiresAt: 1_800_000_000_000 + 3600_000, enabled: patch.enabled ?? true },
    health: { ...health, ...patch.health }, eligible: patch.eligible ?? true, ...(patch.rejection ? { rejection: patch.rejection } : {}) }
}
const status = (patch: Partial<ModelFabricStatus> = {}): ModelFabricStatus => {
  const entries = [entry('a/model-x'), entry('b/model-y'), entry('c/paid-z', { access: 'paid', eligible: false, rejection: { model: 'c/paid-z', stage: 'policy', reason: 'not-free' } })]
  return { policy: { budget: { kind: 'free-only' }, automatic: true, failover: true, useBeta: true }, discoveredAt: 1, discovered: 3, eligible: 2, rateLimited: 0, unavailable: 0,
    providers: [{ id: 'a', name: 'A', connected: true, models: 1, eligible: 1 }, { id: 'b', name: 'B', connected: true, models: 1, eligible: 1 }, { id: 'c', name: 'C', connected: true, models: 1, eligible: 0 }],
    current: entries[0]!, fallbacks: [entries[1]!], entries, recentDecisions: [], costNote: 'Free under each provider’s current free/beta access terms. Free is not unlimited: a model can reach its limit, and Foundry then continues with another.', ...patch }
}
let api: Record<string, ReturnType<typeof vi.fn>>
let node: HTMLDivElement
let root: Root
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api = { modelFabricStatus: vi.fn(async () => status()), modelFabricDiscover: vi.fn(async () => status()), modelFabricPolicy: vi.fn(async () => status()), modelFabricEnable: vi.fn(async () => status()) }
  ;(window as unknown as { douchat: unknown }).douchat = api
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })
const render = () => act(async () => root.render(<ModelFabricPanel />))
const click = (label: string | RegExp) => act(async () => { const button = [...node.querySelectorAll('button')].find(item => typeof label === 'string' ? item.textContent === label : label.test(item.textContent ?? '')); if (!button) throw new Error(`No button ${label}`); button.click() })

it('promises one simple thing: the current model, the count, the cost policy — without asking the person to choose', async () => {
  await render()
  const text = node.textContent!
  expect(text).toContain('Free AI'); expect(text).toContain('automatically finds available free and beta models'); expect(text).toContain('$0.00'); expect(text).toContain('Free only')
  expect(text).toContain('2 models · 2 providers'); expect(text).toContain('model-x'); expect(text).toContain('Why this model?')
  expect(text).toContain('Free is not unlimited')   // never claims unlimited free inference
  expect(node.querySelectorAll('select')).toHaveLength(0)
})

it('shows the switches: automatic on, free-only locked on, fail-over and beta', async () => {
  await render()
  const boxes = [...node.querySelectorAll<HTMLInputElement>('.fabric-switch input')]
  expect(boxes.map(box => [box.parentElement!.textContent!.trim(), box.checked, box.disabled])).toEqual([
    ['Automatic model selection', true, false], ['Free only', true, true], ['Automatically fail over', true, false], ['Automatically use beta models', true, false]])
  await act(async () => { boxes[0]!.click() })
  expect(api.modelFabricPolicy).toHaveBeenCalledWith({ automatic: false })
})

it('says plainly that automatic selection is off, and that agents keep their own model', async () => {
  api.modelFabricStatus.mockResolvedValue(status({ policy: { budget: { kind: 'free-only' }, automatic: false, failover: true, useBeta: true } }))
  await render()
  expect(node.textContent).toContain('each agent keeps using its own model')
})

it('lists the pool with each model’s access and status; a paid model is shown as not used', async () => {
  await render(); await click('View available models')
  const rows = [...node.querySelectorAll('.fabric-models tbody tr')].map(row => row.textContent)
  expect(rows).toHaveLength(3); expect(rows[0]).toContain('Free'); expect(rows[0]).toContain('Ready'); expect(rows[2]).toContain('Paid'); expect(rows[2]).toContain('Not free')
})

it('a model’s detail shows capabilities, context, access and where the classification came from, and labels the metrics as Foundry observed', async () => {
  await render(); await click('View available models'); await click('model-x')
  const detail = node.querySelector('.fabric-detail')!.textContent!
  expect(detail).toContain('Coding'); expect(detail).toContain('Structured output'); expect(detail).toContain('128K'); expect(detail).toContain('from the provider’s published prices')
  expect(detail).toContain('Foundry observed'); expect(detail).toContain('820ms'); expect(detail).toContain('97.3%'); expect(detail).toContain('183'); expect(detail).toContain('not vendor claims')
  await act(async () => { node.querySelector<HTMLInputElement>('.fabric-detail input')!.click() })
  expect(api.modelFabricEnable).toHaveBeenCalledWith('a/model-x', false)
})

it('shows a resting model as cooling down', async () => {
  api.modelFabricStatus.mockResolvedValue(status({ entries: [entry('a/m', { eligible: false, rejection: { model: 'a/m', stage: 'health', reason: 'cooldown' } })], discovered: 1, eligible: 0, current: undefined, fallbacks: [] }))
  await render(); await click('View available models')
  expect(node.querySelector('.fabric-models tbody')!.textContent).toContain('Cooling down')
  expect(node.querySelector('[role=alert]')!.textContent).toContain('No free model is available right now. Nothing paid will be used.')
})

it('a model switch is information in a notice, not an interruption; a request that could not continue says no paid model was used', async () => {
  const decision = { requestId: 'r', taskClass: 'general', requirements: {}, policy: { kind: 'free-only' as const }, candidatesConsidered: [], rejected: [], ranked: [], selectedAt: 1, costPolicy: 'Free only · $0 maximum', outcome: 'succeeded' as const, selected: 'b/model-y',
    attempts: [{ model: 'a/model-x', startedAt: 1, latencyMs: 1, outcome: 'failed' as const, retryReason: 'rate-limited' as const, retried: true }, { model: 'b/model-y', startedAt: 1, latencyMs: 1, outcome: 'success' as const, retried: false }] }
  api.modelFabricStatus.mockResolvedValue(status({ recentDecisions: [decision] }))
  await render()
  expect(node.querySelector('[role=status]')!.textContent).toContain('Model switched'); expect(node.querySelector('[role=status]')!.textContent).toContain('No action required')
  expect(node.querySelector('[role=alert]')).toBeNull()
})

it('a request that could not continue is the only thing worded as a problem, and it says no paid model was used', async () => {
  const failed = { requestId: 'r', taskClass: 'general', requirements: {}, policy: { kind: 'free-only' as const }, candidatesConsidered: ['a/model-x'], rejected: [], ranked: ['a/model-x'], selectedAt: 1, costPolicy: 'Free only · $0 maximum', outcome: 'no-eligible-model' as const, attempts: [] }
  api.modelFabricStatus.mockResolvedValue(status({ recentDecisions: [failed] }))
  await render()
  const alert = node.querySelector('[role=alert]')!.textContent!
  expect(alert).toContain('couldn’t complete'); expect(alert).toContain('No paid model was used.'); expect(alert).toContain('Try again shortly.')
})

it('finds models on request and shows providers as connected or not, without holding a credential', async () => {
  api.modelFabricStatus.mockResolvedValue(status({ providers: [{ id: 'a', name: 'A', connected: true, models: 1, eligible: 1 }, { id: 'z', name: 'Z', connected: false, models: 0, eligible: 0, error: 'HTTP 401' }] }))
  await render()
  expect(node.querySelector('.fabric-providers')!.textContent).toContain('A — Connected'); expect(node.querySelector('.fabric-providers')!.textContent).toContain('Z — Not connected')
  await click('Find models'); expect(api.modelFabricDiscover).toHaveBeenCalled()
  expect(node.textContent).not.toMatch(/sk-|api key:/i)
})
