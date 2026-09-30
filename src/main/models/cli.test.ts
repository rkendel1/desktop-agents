import { describe, expect, it } from 'vitest'
import { decisionNotice } from '../../shared/modelFabric'
import { modelCliInvocation, runModelCli } from './cli'
import { ModelFabric } from './fabric'
import { candidate, FakeProvider, httpError, MemoryStore, T0 } from './testing'

const capture = () => { let text = ''; return { out: { write: (chunk: string) => { text += chunk } }, get text() { return text } } }
const fabric = async (providers: FakeProvider[]) => { const f = new ModelFabric(new MemoryStore(), () => providers, { now: () => T0 }); await f.discover(); return f }
const pool = () => [
  new FakeProvider('alpha', () => [candidate('alpha', 'coder-1', { caps: { vision: false } }), candidate('alpha', 'paid-1', { access: 'paid' })], () => 'pong'),
  new FakeProvider('beta', () => [candidate('beta', 'seer-1', { caps: { vision: true, coding: false } }), candidate('beta', 'mystery', { access: 'unknown', pricing: 'unknown' })], () => 'pong')
]

describe('the command line', () => {
  it('finds the command in the process arguments, packaged or not', () => {
    expect(modelCliInvocation(['electron', '.', 'model', 'list', '--free'], false)).toEqual(['list', '--free'])
    expect(modelCliInvocation(['Foundry', 'model'], true)).toEqual([])
    expect(modelCliInvocation(['Foundry', '--flag'], true)).toBeUndefined()
    expect(modelCliInvocation(['electron', '.'], false)).toBeUndefined()
  })
  it('`model` and `model current` show the policy, the pool, the current pick, the fallbacks and the cost', async () => {
    const f = await fabric(pool()); await f.setPolicy({ automatic: true })
    const io = capture(); expect(await runModelCli([], f, io.out)).toBe(0)
    expect(io.text).toContain('Foundry Model'); expect(io.text).toContain('Policy       Free only'); expect(io.text).toContain('Models       2 eligible')
    expect(io.text).toContain('Current      ALPHA / coder-1'); expect(io.text).toContain('Fallbacks    1 available'); expect(io.text).toContain('$0.00')
  })
  it('says automatic routing is off when it is, instead of implying the pool is in use', async () => {
    const io = capture(); await runModelCli(['current'], await fabric(pool()), io.out)
    expect(io.text).toContain('automatic routing is off')
  })
  it('`model list --free` lists only free, beta, trial and local models, from discovery', async () => {
    const io = capture(); expect(await runModelCli(['list', '--free'], await fabric(pool()), io.out)).toBe(0)
    expect(io.text).toContain('FREE MODELS'); expect(io.text).toContain('coder-1'); expect(io.text).toContain('seer-1'); expect(io.text).not.toContain('paid-1'); expect(io.text).not.toContain('mystery')
    expect(io.text).toMatch(/coder-1\s+code\/reasoning\/tools\/json\s+● ready/)
  })
  it('`model list` shows everything with its access class and why a model is not used', async () => {
    const io = capture(); await runModelCli(['list'], await fabric(pool()), io.out)
    expect(io.text).toContain('paid-1'); expect(io.text).toMatch(/paid-1\s+\S+\s+paid\s+○ not free/); expect(io.text).toMatch(/mystery\s+\S+\s+unknown\s+○ unknown pricing/)
  })
  it('shows a resting model as cooling down', async () => {
    const f = await fabric(pool()); f.ledger.retryable('alpha/coder-1', 'rate-limited', { latencyMs: 1, taskClass: 'g' }, '429')
    const io = capture(); await runModelCli(['list', '--free'], f, io.out); expect(io.text).toMatch(/coder-1\s+.*◐ cooldown/)
  })
  it('`model discover` asks the providers again and reports what it found and any provider that failed', async () => {
    const broken = { id: 'gamma', name: 'Gamma', discover: async () => { throw new Error('network down') }, invoke: async () => ({ text: '' }) }
    const f = new ModelFabric(new MemoryStore(), () => [...pool(), broken as never], { now: () => T0 })
    const io = capture(); expect(await runModelCli(['discover'], f, io.out)).toBe(0)
    expect(io.text).toContain('Discovered 4 models from 2 providers; 2 eligible under Free only.'); expect(io.text).toContain('gamma: network down')
  })
  it('`model status` gives the counts, current and fallbacks, and the honest note that free is not unlimited', async () => {
    const f = await fabric(pool()); const io = capture(); await runModelCli(['status'], f, io.out)
    expect(io.text).toContain('MODEL FABRIC'); expect(io.text).toContain('4 discovered'); expect(io.text).toContain('2 eligible'); expect(io.text).toContain('Current:'); expect(io.text).toContain('Fallback:'); expect(io.text).toContain('not unlimited')
  })
  it('`model test` sends a real request through the router and shows the decision, cycling included', async () => {
    const providers = [new FakeProvider('alpha', () => [candidate('alpha', 'm')], () => httpError(429)), new FakeProvider('beta', () => [candidate('beta', 'm')], () => 'pong')]
    const io = capture(); expect(await runModelCli(['test'], await fabric(providers), io.out)).toBe(0)
    expect(io.text).toContain('Selected   beta/m'); expect(io.text).toContain('alpha/m failed (rate-limited) → beta/m success'); expect(io.text).toContain('Free only · $0 maximum'); expect(io.text).toContain('Reply      pong')
  })
  it('`model test` fails cleanly, exit 1, when every free model is exhausted — and the paid model is not called', async () => {
    const paid = new FakeProvider('paidp', () => [candidate('paidp', 'm', { access: 'paid' })], () => { throw new Error('PAID PROVIDER WAS INVOKED') })
    const io = capture(); expect(await runModelCli(['test'], await fabric([new FakeProvider('a', () => [candidate('a', 'm')], () => httpError(429)), paid]), io.out)).toBe(1)
    expect(io.text).toContain('No paid model was used.'); expect(paid.calls).toEqual([])
  })
  it('emits JSON on request, and rejects an unknown command', async () => {
    const io = capture(); await runModelCli(['status', '--json'], await fabric(pool()), io.out); expect(JSON.parse(io.text).eligible).toBe(2)
    const bad = capture(); expect(await runModelCli(['frobnicate'], await fabric(pool()), bad.out)).toBe(2); expect(bad.text).toContain('Unknown command')
  })
})

describe('Activity wording', () => {
  const names = new Map([['a/m', 'Model X · Provider A'], ['b/m', 'Model Y · Provider B']])
  const base = { requestId: 'r', taskClass: 'general', requirements: {}, policy: { kind: 'free-only' as const }, candidatesConsidered: ['a/m', 'b/m'], rejected: [], ranked: ['a/m', 'b/m'], selectedAt: T0, costPolicy: 'Free only · $0 maximum' }
  it('a switch is information: what happened, what Foundry did, that nothing is needed, and the cost policy', () => {
    const notice = decisionNotice({ ...base, outcome: 'succeeded', selected: 'b/m', attempts: [{ model: 'a/m', startedAt: 0, latencyMs: 5, outcome: 'failed', retryReason: 'rate-limited', retried: true }, { model: 'b/m', startedAt: 0, latencyMs: 5, outcome: 'success', retried: false }] }, names)!
    expect(notice).toEqual({ kind: 'switched', title: 'Model switched', detail: 'Model X · Provider A reached its current limit. Foundry continued with Model Y · Provider B. No action required. Cost policy: Free only' })
  })
  it('a request that went to its first choice says nothing', () => {
    expect(decisionNotice({ ...base, outcome: 'succeeded', selected: 'a/m', attempts: [{ model: 'a/m', startedAt: 0, latencyMs: 5, outcome: 'success', retried: false }] }, names)).toBeUndefined()
  })
  it('only a request that cannot continue is worded as a problem, and it says no paid model was used', () => {
    const notice = decisionNotice({ ...base, outcome: 'no-eligible-model', attempts: [] }, names)!
    expect(notice.kind).toBe('unavailable'); expect(notice.detail).toContain('No paid model was used.')
  })
})
