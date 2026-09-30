import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_POLICY, type ModelPolicy, type ModelRequest } from '../../shared/modelFabric'
import { budgetRejection, classifyAccess, pricingFromCatalog } from './access'
import { loadPersisted, ModelFabric } from './fabric'
import { HealthLedger } from './health'
import { classifyError, CostPolicyViolation, guardInvocation, ModelRoutingError, NO_ELIGIBLE_MESSAGE, planRoute, routeWithFallback } from './router'
import { candidate, FakeProvider, httpError, MemoryStore, T0 } from './testing'

const policy = (patch: Partial<ModelPolicy> = {}): ModelPolicy => ({ ...DEFAULT_MODEL_POLICY, automatic: true, ...patch })
const request = (requirements: ModelRequest['requirements'] = {}, taskClass = 'general'): ModelRequest => ({ requestId: 'r1', taskClass, requirements })
let clock = T0
const now = () => clock
const fresh = () => { clock = T0; return new HealthLedger(now) }
const failure = async (work: Promise<unknown>): Promise<ModelRoutingError> => { try { await work } catch (error) { return error as ModelRoutingError }; throw new Error('expected the request to fail') }
const ids = (plan: ReturnType<typeof planRoute>) => plan.ranked.map(item => item.id)
const plan = (candidates: ReturnType<typeof candidate>[], requirements: ModelRequest['requirements'] = {}, p = policy(), ledger = fresh(), taskClass = 'general') => planRoute({ request: request(requirements, taskClass), policy: p, candidates, ledger, now: clock })

describe('policy: free-only', () => {
  it('rejects a paid model', () => { expect(plan([candidate('a', 'paid', { access: 'paid' })]).rejected).toEqual([{ model: 'a/paid', stage: 'policy', reason: 'not-free', detail: 'access is paid' }]) })
  it('rejects unknown pricing — fail closed', () => {
    const p = plan([candidate('a', 'mystery', { access: 'unknown', pricing: 'unknown' })])
    expect(p.ranked).toEqual([]); expect(p.rejected[0]).toMatchObject({ reason: 'unknown-pricing', stage: 'policy' })
  })
  it('rejects a user-authorized model: authorised spending is not free', () => { expect(plan([candidate('a', 'x', { access: 'user-authorized' })]).ranked).toEqual([]) })
  it('accepts free, beta, trial and local models', () => {
    expect(ids(plan(['free', 'beta', 'trial', 'local'].map(access => candidate('a', access, { access: access as never }))))).toEqual(['a/beta', 'a/free', 'a/local', 'a/trial'])
  })
  it('does not assume a free model is still free once its classification has expired, but a local model never expires', () => {
    const stale = candidate('a', 'old', { expiresAt: T0 - 1 })
    const local = candidate('a', 'mine', { access: 'local', expiresAt: T0 - 1 })
    const p = plan([stale, local])
    expect(ids(p)).toEqual(['a/mine']); expect(p.rejected).toEqual([{ model: 'a/old', stage: 'policy', reason: 'stale-pricing', detail: expect.stringContaining('rediscover') }])
  })
  it('honours the person’s switches: a disabled model and (when beta is off) a beta model', () => {
    const p = plan([candidate('a', 'off', { enabled: false }), candidate('a', 'beta', { access: 'beta' }), candidate('a', 'ok')], {}, policy({ useBeta: false }))
    expect(ids(p)).toEqual(['a/ok']); expect(p.rejected.map(item => item.reason).sort()).toEqual(['beta-disabled', 'disabled'])
  })
  it('the router contract admits anything under an unrestricted budget, but the persisted budget can only be free-only', () => {
    expect(budgetRejection(candidate('a', 'paid', { access: 'paid' }), { budget: { kind: 'unrestricted' }, useBeta: true }, T0)).toBeUndefined()
    const loaded = loadPersisted({ policy: { budget: { kind: 'unrestricted' }, automatic: true } })
    expect(loaded.policy.budget).toEqual({ kind: 'free-only' })
    expect(budgetRejection(candidate('a', 'free'), { budget: { kind: 'up-to-a-dollar' } as never, useBeta: true }, T0)?.reason).toBe('unsupported-budget')
  })
})

describe('access is derived from evidence, and never optimistic', () => {
  it('classifies by where the model runs, what the catalog says, and what the person configured', () => {
    expect(classifyAccess({ local: true, pricing: 'unknown' })).toMatchObject({ access: 'local', basis: 'local-endpoint' })
    expect(classifyAccess({ local: false, pricing: 'free' })).toMatchObject({ access: 'free', basis: 'catalog-pricing' })
    expect(classifyAccess({ local: false, pricing: 'beta-free' })).toMatchObject({ access: 'beta' })
    expect(classifyAccess({ local: false, pricing: 'trial' })).toMatchObject({ access: 'trial' })
    expect(classifyAccess({ local: false, pricing: 'unknown' })).toMatchObject({ access: 'unknown', basis: 'none' })
    expect(classifyAccess({ local: false, pricing: 'unknown', configured: 'free' })).toMatchObject({ access: 'free', basis: 'configured' })
  })
  it('never lets a configuration override a catalog that says paid', () => { expect(classifyAccess({ local: false, pricing: 'paid', configured: 'free' })).toMatchObject({ access: 'paid' }) })
  it('reads catalog prices: all zero is free; any charge is paid; missing or unparseable is unknown', () => {
    expect(pricingFromCatalog({ prompt: '0', completion: '0' }).pricing).toBe('free')
    expect(pricingFromCatalog({ prompt: '0', completion: '0.000002' })).toMatchObject({ pricing: 'paid', prices: { outputPerMillion: 2 } })
    expect(pricingFromCatalog({ prompt: '0' }).pricing).toBe('free')
    expect(pricingFromCatalog({ prompt: 'free', completion: '0' }).pricing).toBe('unknown')
    expect(pricingFromCatalog({ prompt: -1, completion: 0 }).pricing).toBe('unknown')
    expect(pricingFromCatalog(undefined).pricing).toBe('unknown'); expect(pricingFromCatalog({}).pricing).toBe('unknown')
  })
})

describe('capability matching', () => {
  const pool = [candidate('a', 'plain', { caps: { coding: false, reasoning: false, toolUse: false, structuredOutput: false } }), candidate('a', 'coder', { caps: { vision: false } }), candidate('b', 'seer', { caps: { vision: true, coding: false } }), candidate('b', 'small', { caps: { contextTokens: 8000 }, limits: { contextTokens: 8000 } })]
  it('a coding request excludes non-coding models', () => { expect(ids(plan(pool, { coding: true }))).toEqual(['a/coder', 'b/small']) })
  it('a vision request excludes text-only models', () => { expect(ids(plan(pool, { vision: true }))).toEqual(['b/seer']) })
  it('a tool request excludes non-tool models', () => { expect(plan(pool, { toolUse: true }).rejected.find(item => item.model === 'a/plain')?.reason).toBe('no-tool-use') })
  it('a reasoning and a structured-output request are matched too', () => {
    expect(plan(pool, { reasoning: true }).rejected.find(item => item.model === 'a/plain')?.reason).toBe('no-reasoning')
    expect(plan(pool, { structuredOutput: true }).rejected.find(item => item.model === 'a/plain')?.reason).toBe('no-structured-output')
  })
  it('a context requirement excludes models with too little — and models that do not say', () => {
    expect(plan(pool, { minimumContextTokens: 32_000 }).rejected.find(item => item.model === 'b/small')).toMatchObject({ reason: 'context-too-small' })
    const unstated = candidate('c', 'nocontext', { caps: { contextTokens: undefined }, limits: {} })
    expect(plan([unstated], { minimumContextTokens: 1000 }).rejected[0]?.reason).toBe('unknown-context')
  })
  it('capability is judged after policy: a paid coder is rejected for cost, not capability', () => { expect(plan([candidate('a', 'paid', { access: 'paid' })], { coding: true }).rejected[0]?.stage).toBe('policy') })
})

describe('availability, quota and cooldown', () => {
  it('excludes quota-exhausted, unavailable, not-connected and disabled availability, saying why', () => {
    const p = plan([candidate('a', 'q', { availability: { state: 'quota-exhausted', reason: 'daily limit' } }), candidate('a', 'u', { availability: { state: 'provider-unavailable' } }), candidate('a', 'n', { availability: { state: 'not-connected' } }), candidate('a', 'ok')])
    expect(ids(p)).toEqual(['a/ok']); expect(p.rejected.map(item => `${item.model}:${item.reason}`).sort()).toEqual(['a/n:not-connected', 'a/q:quota-exhausted', 'a/u:provider-unavailable'])
  })
  it('a rate-limited model rests in cooldown, is excluded, and returns when the cooldown expires', () => {
    const ledger = fresh(); const a = candidate('a', 'm')
    ledger.retryable(a.id, 'rate-limited', { latencyMs: 5, taskClass: 'general' }, '429')
    expect(ledger.state(a.id)).toBe('cooldown')
    expect(plan([a], {}, policy(), ledger).rejected[0]).toMatchObject({ stage: 'health', reason: 'cooldown' })
    clock = T0 + 29_999; expect(ids(plan([a], {}, policy(), ledger))).toEqual([])
    clock = T0 + 30_001; expect(ledger.state(a.id)).toBe('degraded'); expect(ids(plan([a], {}, policy(), ledger))).toEqual(['a/m'])
  })
  it('repeated failures back off exponentially, up to a cap, and a provider’s retry-after is respected', () => {
    const ledger = fresh(); const id = 'a/m'
    const cooldowns = [1, 2, 3, 4].map(() => { clock = T0; return ledger.retryable(id, 'rate-limited', { latencyMs: 1, taskClass: 'g' }, '429') - T0 })
    expect(cooldowns).toEqual([30_000, 60_000, 120_000, 240_000])
    clock = T0; expect(ledger.retryable('a/n', 'rate-limited', { latencyMs: 1, taskClass: 'g' }, '429', 120_000) - T0).toBe(120_000)
    for (let i = 0; i < 20; i++) ledger.retryable('a/z', 'timeout', { latencyMs: 1, taskClass: 'g' }, 'timeout')
    expect(ledger.exclusion('a/z')!.until - clock).toBeLessThanOrEqual(15 * 60_000)
    expect(ledger.state('a/z')).toBe('unavailable')
  })
  it('a success returns the model to the pool and clears the backoff', () => {
    const ledger = fresh(); const id = 'a/m'
    ledger.retryable(id, 'timeout', { latencyMs: 1, taskClass: 'g' }, 'timeout'); clock = T0 + 20_000
    ledger.success(id, { latencyMs: 100, taskClass: 'g' })
    expect(ledger.state(id)).toBe('healthy'); expect(ledger.retryable(id, 'timeout', { latencyMs: 1, taskClass: 'g' }, 't') - clock).toBe(15_000)
  })
  it('a credential failure pauses the model instead of retrying it blindly', () => {
    const ledger = fresh(); ledger.permanent('a/m', 'authentication', { latencyMs: 1, taskClass: 'g' }, '401')
    expect(ledger.state('a/m')).toBe('unavailable'); expect(ledger.exclusion('a/m')!.reason).toBe('authentication failed')
    ledger.reset('a/m'); expect(ledger.state('a/m')).toBe('healthy')
  })
  it('keeps observed signals: counts, 429s, timeouts, latency percentiles — labelled as observed, not benchmarks', () => {
    const ledger = fresh()
    for (const latency of [100, 200, 300, 400, 1000]) ledger.success('a/m', { latencyMs: latency, taskClass: 'g' })
    ledger.retryable('a/m', 'rate-limited', { latencyMs: 1, taskClass: 'g' }, '429'); ledger.retryable('a/m', 'timeout', { latencyMs: 1, taskClass: 'g' }, 'slow')
    expect(ledger.snapshot('a/m')).toMatchObject({ requests: 7, successes: 5, failures: 2, rateLimited: 1, timeouts: 1, averageLatencyMs: 400, p50LatencyMs: 300, p95LatencyMs: 1000, lastSuccessAt: T0, lastFailure: 'slow' })
  })
})

describe('ranking uses observed outcomes, deterministically', () => {
  const a = candidate('a', 'm'), b = candidate('b', 'm'), c = candidate('c', 'm')
  it('same registry, request and signals → same ranking, whatever order the candidates arrive in', () => {
    const ledger = fresh(); ledger.success(b.id, { latencyMs: 10, taskClass: 'general' })
    const first = ids(plan([a, b, c], {}, policy(), ledger))
    for (const order of [[c, b, a], [b, a, c], [a, c, b]]) expect(ids(plan(order, {}, policy(), ledger))).toEqual(first)
    expect(first[0]).toBe('b/m')
  })
  it('with no history it falls back to a stable order by id', () => { expect(ids(plan([c, a, b]))).toEqual(['a/m', 'b/m', 'c/m']) })
  it('prefers the model with the better success record, and one that has failed lately ranks below', () => {
    const ledger = fresh()
    for (let i = 0; i < 5; i++) ledger.success(c.id, { latencyMs: 500, taskClass: 'general' })
    ledger.retryable(a.id, 'timeout', { latencyMs: 1, taskClass: 'general' }, 'x'); clock += 60_000
    expect(ids(plan([a, b, c], {}, policy(), ledger))).toEqual(['c/m', 'b/m', 'a/m'])
  })
  it('prefers a model that has done this kind of task well (task affinity)', () => {
    const ledger = fresh()
    for (let i = 0; i < 4; i++) ledger.success(a.id, { latencyMs: 100, taskClass: 'general' })
    for (let i = 0; i < 3; i++) ledger.success(b.id, { latencyMs: 900, taskClass: 'coding' })
    expect(ids(plan([a, b], {}, policy(), ledger, 'coding'))[0]).toBe('b/m')
    expect(ids(plan([a, b], {}, policy(), ledger, 'general'))[0]).toBe('a/m')
  })
  it('weighs tool-call and structured-output success when the request needs them', () => {
    const ledger = fresh()
    for (let i = 0; i < 4; i++) { ledger.success(a.id, { latencyMs: 1, taskClass: 'g', usedTools: true, toolCallOk: false }); ledger.success(b.id, { latencyMs: 1, taskClass: 'g', usedTools: true, toolCallOk: true }) }
    expect(ids(plan([a, b], { toolUse: true }, policy(), ledger, 'g'))[0]).toBe('b/m')
  })
  it('uses latency only as the tie-breaker', () => {
    const ledger = fresh()
    ledger.success(a.id, { latencyMs: 4000, taskClass: 'general' }); ledger.success(b.id, { latencyMs: 100, taskClass: 'general' })
    expect(ids(plan([a, b], {}, policy(), ledger))[0]).toBe('b/m')                                  // equal quality → faster wins
    for (let i = 0; i < 3; i++) ledger.success(a.id, { latencyMs: 4000, taskClass: 'general' })
    expect(ids(plan([a, b], {}, policy(), ledger))[0]).toBe('a/m')                                  // better record beats latency
  })
})

describe('error classification: only transient failures move on to another model', () => {
  it.each([
    [httpError(429), { retry: 'rate-limited' }], [new Error('Rate limit exceeded, retry later'), { retry: 'rate-limited' }], [new Error('RESOURCE_EXHAUSTED: quota'), { retry: 'rate-limited' }],
    [httpError(503), { retry: 'capacity-unavailable' }], [new Error('The model is overloaded'), { retry: 'capacity-unavailable' }], [httpError(529), { retry: 'capacity-unavailable' }],
    [Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }), { retry: 'timeout' }], [new Error('request timed out'), { retry: 'timeout' }], [httpError(504), { retry: 'timeout' }],
    [httpError(500), { retry: 'temporary-provider-error' }], [new Error('fetch failed'), { retry: 'temporary-provider-error' }], [new Error('502 Bad Gateway'), { retry: 'temporary-provider-error' }],
    [httpError(401), { permanent: 'authentication' }], [new Error('Invalid API key'), { permanent: 'authentication' }], [httpError(403), { permanent: 'authentication' }],
    [httpError(400, 'bad request'), { permanent: 'invalid-request' }], [httpError(422), { permanent: 'invalid-request' }],
    [httpError(402, 'payment required'), { permanent: 'policy-violation' }], [new Error('insufficient credits'), { permanent: 'policy-violation' }],
    [new Error('invalid tool call arguments'), { permanent: 'malformed-tool-call' }], [new Error('maximum context length exceeded'), { permanent: 'unsupported-capability' }],
    [new Error('something odd happened'), { permanent: 'other' }], [new Error('exceeds 512 tokens'), { permanent: 'other' }]
  ])('%s', (error, expected) => { expect(classifyError(error)).toEqual(expected) })
  it('keeps a provider’s retry-after', () => { expect(classifyError(Object.assign(httpError(429), { retryAfterMs: 5000 }))).toEqual({ retry: 'rate-limited', retryAfterMs: 5000 }) })
  it('lets the adapter say an otherwise-unknown error is transient', () => { expect(classifyError(Object.assign(new Error('model is loading'), { transient: true }))).toEqual({ retry: 'temporary-provider-error' }) })
})

describe('cycling: the request continues on the next eligible model', () => {
  const pool = () => [candidate('a', 'm'), candidate('b', 'm'), candidate('c', 'm')]
  const run = (behaviour: Record<string, () => unknown>, p = policy(), candidates = pool(), ledger = fresh(), classify?: Parameters<typeof routeWithFallback>[0]['classify']) => {
    const called: string[] = []
    const result = routeWithFallback<string>({ request: request(), policy: p, candidates, ledger, now, classify, invoke: async c => { called.push(c.id); const b = behaviour[c.provider]; if (b) { const v = b(); if (v instanceof Error) throw v } return { value: c.id } } })
    return { called, result, ledger }
  }
  it('429 → next model', async () => { const r = run({ a: () => httpError(429) }); expect((await r.result).value).toBe('b/m'); expect(r.called).toEqual(['a/m', 'b/m']) })
  it('timeout → next model', async () => { const r = run({ a: () => new Error('timeout') }); expect((await r.result).value).toBe('b/m') })
  it('capacity failure → next model', async () => { const r = run({ a: () => httpError(503) }); expect((await r.result).value).toBe('b/m') })
  it('A 429 → B timeout → C success, with every attempt recorded', async () => {
    const r = run({ a: () => httpError(429), b: () => new Error('timed out') })
    const { value, decision } = await r.result
    expect(value).toBe('c/m'); expect(r.called).toEqual(['a/m', 'b/m', 'c/m'])
    expect(decision).toMatchObject({ outcome: 'succeeded', selected: 'c/m', policy: { kind: 'free-only' }, costPolicy: 'Free only · $0 maximum', candidatesConsidered: ['a/m', 'b/m', 'c/m'] })
    expect(decision.attempts.map(item => [item.model, item.outcome, item.retryReason, item.retried])).toEqual([['a/m', 'failed', 'rate-limited', true], ['b/m', 'failed', 'timeout', true], ['c/m', 'success', undefined, false]])
  })
  it('the failed models rest in cooldown; the next request goes straight to the one that worked', async () => {
    const ledger = fresh(); await run({ a: () => httpError(429), b: () => httpError(503) }, policy(), pool(), ledger).result
    const again = run({}, policy(), pool(), ledger); await again.result
    expect(again.called).toEqual(['c/m'])
  })
  it('authentication failure → no blind retry on another model', async () => {
    const r = run({ a: () => httpError(401, 'Invalid API key') }); await expect(r.result).rejects.toMatchObject({ name: 'ModelRoutingError', decision: { outcome: 'failed' } }); expect(r.called).toEqual(['a/m'])
  })
  it('invalid request → no retry', async () => { const r = run({ a: () => httpError(400, 'bad request') }); await expect(r.result).rejects.toBeInstanceOf(ModelRoutingError); expect(r.called).toEqual(['a/m']) })
  it('malformed tool call → no retry', async () => { const r = run({ a: () => new Error('malformed tool call arguments') }); await expect(r.result).rejects.toBeInstanceOf(ModelRoutingError); expect(r.called).toEqual(['a/m']) })
  it('unsupported capability and policy violation → no retry', async () => {
    await expect(run({ a: () => new Error('maximum context length exceeded') }).result).rejects.toBeInstanceOf(ModelRoutingError)
    await expect(run({ a: () => httpError(402, 'payment required') }).result).rejects.toBeInstanceOf(ModelRoutingError)
  })
  it('…unless the provider’s adapter says the error is transient', async () => {
    const r = run({ a: () => new Error('model is loading') }, policy(), pool(), fresh(), (c, error) => c.provider === 'a' && /loading/.test(String(error)) ? { retry: 'capacity-unavailable' } : undefined)
    expect((await r.result).value).toBe('b/m')
  })
  it('does not fail over when the person turned fail-over off', async () => { const r = run({ a: () => httpError(429) }, policy({ failover: false })); await expect(r.result).rejects.toThrow(/fail-over is off/); expect(r.called).toEqual(['a/m']) })
  it('all eligible models exhausted → a clean failure, decision recorded, nothing widened', async () => {
    const r = run({ a: () => httpError(429), b: () => httpError(429), c: () => httpError(503) })
    const error = await failure(r.result)
    expect(error).toBeInstanceOf(ModelRoutingError); expect(error.message).toBe(NO_ELIGIBLE_MESSAGE); expect(error.message).toContain('No paid model was used.')
    expect(error.decision.outcome).toBe('no-eligible-model'); expect(error.decision.selected).toBeUndefined(); expect(error.decision.attempts).toHaveLength(3)
  })
  it('no candidate at all → the same clean failure', async () => { await expect(run({}, policy(), []).result).rejects.toMatchObject({ message: NO_ELIGIBLE_MESSAGE, decision: { outcome: 'no-eligible-model', ranked: [] } }) })
  it('an aborted request stops without cycling', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(routeWithFallback({ request: request(), policy: policy(), candidates: pool(), ledger: fresh(), now, signal: controller.signal, invoke: async () => ({ value: 1 }) })).rejects.toBeDefined()
  })
})

describe('cost invariant: under free-only a paid candidate can never reach a provider', () => {
  const paid = candidate('paid', 'expensive', { access: 'paid' })
  const unknown = candidate('paid', 'mystery', { access: 'unknown', pricing: 'unknown' })
  const stale = candidate('stale', 'old', { expiresAt: T0 - 1 })
  const userAuthorized = candidate('user', 'mine', { access: 'user-authorized' })
  const forbidden = [paid, unknown, stale, userAuthorized]

  it('the invocation guard refuses each of them even when handed one directly', () => {
    for (const item of forbidden) expect(() => guardInvocation(item, policy(), T0)).toThrow(CostPolicyViolation)
    expect(() => guardInvocation(candidate('a', 'free'), policy(), T0)).not.toThrow()
  })
  it('the router never invokes them, whatever else is wrong with the free models', async () => {
    const invoked: string[] = []
    const free = [candidate('a', 'm'), candidate('b', 'm')]
    await expect(routeWithFallback({ request: request(), policy: policy(), candidates: [...forbidden, ...free], ledger: fresh(), now,
      invoke: async c => { invoked.push(c.id); throw httpError(429) } })).rejects.toBeInstanceOf(ModelRoutingError)
    expect(invoked).toEqual(['a/m', 'b/m'])
  })
  it('a fake paid provider that fails the test if it is ever called stays uncalled through discovery, routing, cycling and exhaustion', async () => {
    const PaidProvider = new FakeProvider('paid', () => [paid, unknown], () => { throw new Error('PAID PROVIDER WAS INVOKED') })
    const A = new FakeProvider('a', () => [candidate('a', 'm')], () => httpError(429))
    const B = new FakeProvider('b', () => [candidate('b', 'm')], () => new Error('timed out'))
    const store = new MemoryStore()
    const fabric = new ModelFabric(store, () => [PaidProvider, A, B], { now })
    await fabric.setPolicy({ automatic: true }); await fabric.discover()
    const error = await failure(fabric.complete(fabric.request('general'), 'hi'))
    expect(error.message).toBe(NO_ELIGIBLE_MESSAGE)
    expect(PaidProvider.calls).toEqual([]); expect(A.calls).toEqual(['a/m']); expect(B.calls).toEqual(['b/m'])
    expect(error.decision.rejected.filter(item => item.stage === 'policy').map(item => item.model).sort()).toEqual(['paid/expensive', 'paid/mystery'])
  })
  it('a registry that claims a paid model is free is still caught when the entry says paid', async () => {
    const store = new MemoryStore(); const P = new FakeProvider('paid', () => [paid], () => { throw new Error('PAID PROVIDER WAS INVOKED') })
    const fabric = new ModelFabric(store, () => [P], { now }); await fabric.discover()
    await expect(fabric.complete(fabric.request('general'), 'hi')).rejects.toMatchObject({ message: NO_ELIGIBLE_MESSAGE }); expect(P.calls).toEqual([])
  })
})

describe('the fabric: discovery, persistence, status, and integration with fake providers', () => {
  const build = (providers: FakeProvider[], store = new MemoryStore()) => ({ store, fabric: new ModelFabric(store, () => providers, { now }) })

  it('integration: A → 429, B → timeout, C → success; the paid provider is never called', async () => {
    const A = new FakeProvider('freea', () => [candidate('freea', 'm')], () => httpError(429))
    const B = new FakeProvider('freeb', () => [candidate('freeb', 'm')], () => new Error('request timed out'))
    const C = new FakeProvider('freec', () => [candidate('freec', 'm')], () => 'answer')
    const Paid = new FakeProvider('paidp', () => [candidate('paidp', 'm', { access: 'paid' })], () => { throw new Error('PAID PROVIDER WAS INVOKED') })
    const { fabric } = build([A, B, C, Paid]); await fabric.discover()
    const { response, decision } = await fabric.complete(fabric.request('coding', { toolUse: true }), 'hi')
    expect(response.text).toBe('answer'); expect(A.calls).toHaveLength(1); expect(B.calls).toHaveLength(1); expect(Paid.calls).toEqual([])
    expect(decision.attempts.map(item => item.outcome)).toEqual(['failed', 'failed', 'success']); expect(fabric.recentDecisions()[0]).toBe(decision)
  })
  it('all free models exhausted: “No eligible model available”, no paid fallback, and the reasons are in the decision', async () => {
    const A = new FakeProvider('freea', () => [candidate('freea', 'm')], () => httpError(429))
    const Paid = new FakeProvider('paidp', () => [candidate('paidp', 'm', { access: 'paid' })], () => { throw new Error('PAID PROVIDER WAS INVOKED') })
    const { fabric } = build([A, Paid]); await fabric.discover()
    const error = await failure(fabric.complete(fabric.request('general'), 'hi'))
    expect(error.message).toContain('No paid model was used.'); expect(Paid.calls).toEqual([])
    // and the second request does not even try the model that is resting
    const again = await failure(fabric.complete(fabric.request('general'), 'hi'))
    expect(again.decision.attempts).toEqual([]); expect(again.decision.rejected.find(item => item.model === 'freea/m')).toMatchObject({ stage: 'health', reason: 'cooldown' }); expect(A.calls).toHaveLength(1)
  })
  it('a flaky provider recovers: after its cooldown it is tried again and returns to the pool', async () => {
    let healthy = false
    const Flaky = new FakeProvider('flaky', () => [candidate('flaky', 'm')], () => healthy ? 'back' : httpError(503))
    const { fabric } = build([Flaky]); await fabric.discover()
    await expect(fabric.complete(fabric.request('g'), 'x')).rejects.toBeInstanceOf(ModelRoutingError)
    healthy = true; clock = T0 + 31_000
    expect((await fabric.complete(fabric.request('g'), 'x')).response.text).toBe('back')
    expect((await fabric.entries())[0]!.health.state).toBe('healthy')
  })
  it('discovers whatever the providers offer — no model is built in — and persists only the registry and the policy', async () => {
    const P = new FakeProvider('p', () => [candidate('p', 'whatever-it-offers-today')])
    const { fabric, store } = build([P]); const registry = await fabric.discover()
    expect(registry.candidates.map(item => item.id)).toEqual(['p/whatever-it-offers-today'])
    expect(Object.keys(store.saved!).sort()).toEqual(['disabled', 'policy', 'registry', 'version'])
    P.behave(() => 'ok'); const next = new ModelFabric(store, () => [new FakeProvider('p', () => [candidate('p', 'tomorrows-model')])], { now })
    expect((await next.discover()).candidates.map(item => item.id)).toEqual(['p/tomorrows-model'])
  })
  it('keeps a provider’s previous entries (which age out) when it cannot be asked, and records the error', async () => {
    let up = true
    const P = { id: 'p', name: 'P', discover: async () => { if (!up) throw new Error('network down'); return [candidate('p', 'm')] }, invoke: async () => ({ text: '' }) }
    const { fabric } = build([P as never]); await fabric.discover(); up = false
    const registry = await fabric.discover()
    expect(registry.candidates.map(item => item.id)).toEqual(['p/m']); expect(registry.errors).toEqual([{ provider: 'p', message: 'network down' }])
    clock = T0 + 7 * 3600_000
    expect((await fabric.status()).eligible).toBe(0)   // the copy is stale, so it is not assumed free
    clock = T0
  })
  it('forgets a provider that was removed', async () => {
    const store = new MemoryStore()
    await new ModelFabric(store, () => [new FakeProvider('p', () => [candidate('p', 'm')]), new FakeProvider('q', () => [candidate('q', 'm')])], { now }).discover()
    expect((await new ModelFabric(store, () => [new FakeProvider('q', () => [candidate('q', 'm')])], { now }).discover()).candidates.map(item => item.id)).toEqual(['q/m'])
  })
  it('stamps freshness on entries that do not carry it, and a stale entry is not eligible until rediscovered', async () => {
    const bare = { ...candidate('p', 'm'), observedAt: 0, expiresAt: 0 }
    const { fabric } = build([new FakeProvider('p', () => [bare])]); const registry = await fabric.discover()
    expect(registry.candidates[0]).toMatchObject({ observedAt: T0, expiresAt: T0 + 6 * 3600_000 })
    clock = T0 + 6 * 3600_000 + 1
    expect((await fabric.entries())[0]).toMatchObject({ eligible: false, rejection: { reason: 'stale-pricing' } })
    await fabric.discover(); expect((await fabric.entries())[0]!.eligible).toBe(true); clock = T0
  })
  it('policy: free-only is the default, the budget cannot be changed, the switches are persisted', async () => {
    const { fabric, store } = build([])
    expect(await fabric.policy()).toEqual({ budget: { kind: 'free-only' }, automatic: false, failover: true, useBeta: true })
    expect(await fabric.setPolicy({ automatic: true, useBeta: false, budget: { kind: 'unrestricted' } } as never)).toEqual({ budget: { kind: 'free-only' }, automatic: true, failover: true, useBeta: false })
    expect((store.saved!.policy).budget).toEqual({ kind: 'free-only' })
  })
  it('a person can turn a model off without forgetting it', async () => {
    const { fabric } = build([new FakeProvider('p', () => [candidate('p', 'a'), candidate('p', 'b')])]); await fabric.discover()
    await fabric.setEnabled('p/a', false)
    expect((await fabric.status()).entries.find(entry => entry.candidate.id === 'p/a')).toMatchObject({ eligible: false, rejection: { reason: 'disabled' } })
    await fabric.setEnabled('p/a', true); expect((await fabric.status()).eligible).toBe(2)
  })
  it('status: counts, current pick, fallbacks, providers, and the honest cost note', async () => {
    const { fabric } = build([new FakeProvider('a', () => [candidate('a', 'm')]), new FakeProvider('b', () => [candidate('b', 'm'), candidate('b', 'paid', { access: 'paid' })]), new FakeProvider('c', () => [candidate('c', 'm', { availability: { state: 'not-connected' } })])]); await fabric.discover()
    fabric.ledger.retryable('a/m', 'rate-limited', { latencyMs: 1, taskClass: 'g' }, 'HTTP 429 rate limited')
    const status = await fabric.status()
    expect(status).toMatchObject({ discovered: 4, eligible: 1, rateLimited: 1, unavailable: 1, current: { candidate: { id: 'b/m' } }, fallbacks: [] })
    expect(status.providers.map(item => [item.id, item.models, item.eligible])).toEqual([['a', 1, 0], ['b', 2, 1], ['c', 1, 0]])
    expect(status.costNote).toContain('not unlimited')
  })
  it('never persists a credential: the registry holds identifiers, classifications and capabilities only', async () => {
    const secret = 'sk-test-SECRET-KEY-123'
    const { fabric, store } = build([new FakeProvider('p', () => [candidate('p', 'm')])]); await fabric.discover()
    expect(JSON.stringify(store.saved)).not.toContain(secret); expect(JSON.stringify(store.saved)).not.toMatch(/api.?key|secret|bearer|authorization|password|\bsk-/i)
  })
  it('ignores a corrupt or hostile persisted value rather than trusting it', () => {
    expect(loadPersisted('garbage').policy).toEqual({ budget: { kind: 'free-only' }, automatic: false, failover: true, useBeta: true })
    expect(loadPersisted({ version: 2, registry: { candidates: [{ id: 1 }, { id: 'a/b', provider: 'a', access: 'freebie', expiresAt: 1 }, candidate('a', 'ok')] } }).registry.candidates.map(item => item.id)).toEqual(['a/ok'])
  })
  it('invalidates the old discovery cache so Ollama capabilities are rediscovered before routing', () => {
    const loaded = loadPersisted({ version: 1, policy: { automatic: true }, registry: { discoveredAt: T0, candidates: [candidate('ollama', 'nomic-embed-text:latest')], errors: [] } })
    expect(loaded).toMatchObject({ version: 2, policy: { automatic: true }, registry: { discoveredAt: 0, candidates: [] } })
  })
})
