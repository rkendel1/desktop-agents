import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestKit } from '../coding/testkit'
import { CodingService } from '../coding/service'
import { FixtureCompute } from './testkit'
import { EnvironmentError, EnvironmentService } from './service'

/**
 * What only a contract fixture can do on demand: put Compute into the states a healthy host will not — a bootstrap that fails, a
 * target that stops satisfying the requirements, a machine that is lost, a Compute that predates the contract. The fixture speaks the
 * declared contract (its JSON is derived from recordings of real Compute main); Foundry's code under test is the real code.
 */
vi.setConfig({ testTimeout: 60_000 })
const kit = new TestKit()
const backends: FixtureCompute[] = []
afterEach(async () => { await kit.cleanup(); for (const backend of backends.splice(0)) await backend.stop() })

async function world(options: ConstructorParameters<typeof FixtureCompute>[0] = {}) {
  const backend = new FixtureCompute(options); backends.push(backend)
  await backend.defineRecipe('developer')
  const booted = await kit.boot()
  const project = await booted.coding.addProject(kit.repository(), 'Fixture')
  const service = new EnvironmentService(booted.desktop.repository, backend.client, { settleMs: 1500, pollMs: 50 })
  return { backend, booted, projectId: project.id, service }
}
async function ready(options: ConstructorParameters<typeof FixtureCompute>[0] = {}) {
  const w = await world({ auto: true, ...options })
  const view = await w.service.create({ projectId: w.projectId, recipe: 'developer' })
  expect(view.state).toBe('ready')
  return { ...w, name: view.reference!.environment }
}

describe('following Compute through creation', () => {
  it('walks created → provisioning → configuring → ready one Compute transition at a time', async () => {
    const { backend, service, projectId } = await world()
    await service.create({ projectId, recipe: 'developer' })
    const name = (await service.view(projectId)).reference!.environment
    const trail: { state: string; steps: string[] }[] = []
    const hand = (...args: string[]) => (backend as unknown as { hand: (...a: string[]) => Promise<unknown> }).hand(...args)
    for (let index = 0; index < 4; index++) {
      const view = await service.view(projectId)
      trail.push({ state: view.state, steps: view.progress.map(step => `${step.id}:${step.status}`) })
      await hand('advance', name)
    }
    expect(trail.map(item => item.state)).toEqual(['creating', 'creating', 'configuring', 'ready'])
    expect(trail[2]!.steps).toEqual(['recipe:done', 'computer:done', 'configuration:active', 'readiness:pending', 'ready:pending'])
    expect(trail[3]!.steps.every(step => step.endsWith(':done'))).toBe(true)
  })

  it('does not read a machine that is running as an environment that is ready: running + configuring is Configuring', async () => {
    const { backend, service, projectId } = await world()
    await service.create({ projectId, recipe: 'developer' })
    const name = (await service.view(projectId)).reference!.environment
    await backend.phase(name, 'configuring')
    const view = await service.view(projectId)
    expect(view).toMatchObject({ state: 'configuring', lifecycle: 'running', readiness: 'starting', configuration: 'running' })
    expect(view.actions).not.toContain('open')
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'not-ready', state: 'configuring' })
  })
})

describe('failure keeps Compute’s meaning', () => {
  it('shows a failed bootstrap as Failed with the class and the operation, offers Retry, and Retry is Compute’s reconcile', async () => {
    const { backend, service, projectId, name } = await ready()
    await backend.phase(name, 'bootstrap-failed')
    const failed = await service.view(projectId)
    expect(failed).toMatchObject({ state: 'failed', readiness: 'failed', configuration: 'failed', actions: ['retry', 'destroy'],
      reason: { category: 'configuration_failed', title: 'Environment configuration failed.', retryable: true, message: expect.stringContaining('package install: npm install exited 1') } })
    expect(failed.reason?.computeSays).toContain('failed to become ready')
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'not-ready', state: 'failed', message: expect.stringContaining('Environment configuration failed.') })
    const retried = await service.act(projectId, 'retry')
    expect((await backend.calls()).some(call => call === `environment reconcile ${name}`)).toBe(true)
    expect(retried.state).not.toBe('failed')
  })

  it('shows unmet requirements as Not Ready with placement’s reason, and offers no retry', async () => {
    const { backend, service, projectId, name } = await ready()
    await backend.phase(name, 'requirements-unsatisfied')
    const view = await service.view(projectId)
    expect(view).toMatchObject({ state: 'not-ready', actions: ['destroy'], reason: { category: 'requirements_unsatisfied', title: 'Environment couldn’t become ready.', message: expect.stringContaining('cannot satisfy') } })
    expect(view.reason?.unsatisfied).toEqual([{ code: 'runtime_unavailable', required: 'node 22', available: '["node 20.11.0"]', detail: 'the target cannot resolve node 22' }])
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'not-ready', state: 'not-ready' })
  })

  it('keeps a placement failure Compute recorded against a still-starting environment visible, with its category', async () => {
    const { backend, service, projectId } = await world()
    await service.create({ projectId, recipe: 'developer' })
    const name = (await service.view(projectId)).reference!.environment
    await backend.phase(name, 'placement-failed')
    const view = await service.view(projectId)
    expect(view.state).toBe('creating')   // Compute’s readiness still says starting: that is the state
    expect(view.reason).toMatchObject({ category: 'placement/target_incompatible', message: expect.stringContaining('runtime_unavailable'), retryable: true })
    expect(view.actions).toEqual(['retry', 'destroy'])
  })

  it('shows a lost machine as Not Ready, not as anything running', async () => {
    const { backend, service, projectId, name } = await ready()
    await backend.phase(name, 'lost')
    expect(await service.view(projectId)).toMatchObject({ state: 'not-ready', lifecycle: 'lost', actions: ['destroy'] })
  })

  it('admits a degraded environment exactly as Compute does, and says it is degraded', async () => {
    const { backend, service, projectId, name } = await ready()
    await backend.phase(name, 'degraded')
    expect(await service.view(projectId)).toMatchObject({ state: 'degraded', readiness: 'degraded' })
    expect((await service.admit(projectId)).view.state).toBe('degraded')
  })

  it('treats a readiness value it does not know as unknown — never ready', async () => {
    const { backend, service, projectId, name } = await ready()
    await backend.phase(name, 'mystery')
    const view = await service.view(projectId)
    expect(view.state).toBe('unknown')
    expect(view.reason?.category).toBe('unrecognised')
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'not-ready' })
  })

  it('reports a destroy Compute could not complete, keeps the reference, and does not call it destroyed', async () => {
    const { backend, service, projectId, name, booted } = await ready()
    await backend.set(name, { destroyFails: true })
    await expect(service.act(projectId, 'destroy')).rejects.toMatchObject({ code: 'compute', message: expect.stringContaining('termination_failed') })
    expect(await booted.desktop.repository.developmentEnvironment(projectId)).toBeDefined()
    expect((await service.view(projectId)).state).toBe('destroying')
  })
})

describe('no optimistic terminal state', () => {
  it('returns Stopping, not Stopped, while Compute has not confirmed the stop', async () => {
    const { backend, service, projectId, name } = await ready({ extra: { FIXTURE_SLOW_STOP: '1' } })
    const view = await service.act(projectId, 'stop')
    expect(view.state).toBe('stopping')
    expect(view.actions).toEqual([])
    expect((await backend.calls()).filter(call => call === `environment stop ${name}`)).toHaveLength(1)
    await backend.phase(name, 'stopped')
    expect((await service.view(projectId)).state).toBe('stopped')
  })

  it('keeps the reference and shows Destroying until Compute confirms destroyed', async () => {
    const { backend, service, projectId, name, booted } = await ready()
    await backend.phase(name, 'destroying')
    expect((await service.view(projectId)).state).toBe('destroying')
    expect(await booted.desktop.repository.developmentEnvironment(projectId)).toBeDefined()
  })
})

describe('Compute unavailable', () => {
  it('says so, keeps the reference, and refuses workloads instead of falling back', async () => {
    const { backend, service, projectId, booted } = await ready()
    await backend.daemon(false)
    const view = await service.view(projectId)
    expect(view).toMatchObject({ state: 'compute-unavailable', actions: [], reason: { category: 'daemon-unreachable' }, reference: expect.objectContaining({ projectId }) })
    expect(view.reason?.message).toContain('compute start')
    const agent = await booted.desktop.repository.createAgent({ name: 'Coder', role: 'Engineer', instructions: '', color: '#0b5cff', provider: 'local', model: 'default' })
    const coding = new CodingService(booted.desktop.repository, booted.runtime, () => undefined, { compute: backend.client, environments: service })
    await expect(coding.start({ projectId, agentId: agent.id, task: 'Fix add()', execution: { kind: 'compute' } })).rejects.toThrow(/Compute was selected, so nothing was started on this computer\..*Compute daemon is not answering/)
    expect(await booted.desktop.repository.codingSessions()).toEqual([])
    await backend.daemon(true)
    expect((await service.view(projectId)).state).toBe('ready')
  })

  it('needs no reference to say Compute is down: the create surface says why it cannot create', async () => {
    const { backend, service, projectId } = await world()
    await backend.daemon(false)
    expect(await service.view(projectId)).toMatchObject({ state: 'compute-unavailable', reason: { category: 'daemon-unreachable' } })
    await expect(service.create({ projectId, recipe: 'developer' })).rejects.toBeInstanceOf(EnvironmentError)
  })
})

describe('a Compute older than the contract (Compute Configured 0.1.5)', () => {
  it('asks for an update and emulates nothing: no recipes, no bootstrap, no readiness, no environment', async () => {
    const { service, projectId, booted } = await world({ legacy: true })
    const view = await service.view(projectId)
    expect(view).toMatchObject({ state: 'compute-unavailable', compute: { ok: false, reason: 'upgrade-required', installed: { version: '0.1.5' } }, actions: [],
      reason: { title: 'Compute update required.', message: expect.stringContaining('Environment Recipes, Bootstrap, Readiness and lifecycle support. Installed: Compute Configured 0.1.5.') } })
    await expect(service.recipes()).rejects.toMatchObject({ code: 'compute', category: 'upgrade-required' })
    await expect(service.create({ projectId, recipe: 'developer' })).rejects.toMatchObject({ category: 'upgrade-required' })
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'no-environment' })
    expect(await booted.desktop.repository.developmentEnvironment(projectId)).toBeUndefined()
  })

  it('also refuses an existing reference’s workloads: an old Compute is not ready, it is unsupported', async () => {
    const { service, projectId, booted } = await world({ legacy: true })
    await booted.desktop.repository.putDevelopmentEnvironment({ projectId, environment: 'foundry-old-abc123', environmentId: 'env_old', createdAt: 1 })
    expect((await service.view(projectId)).state).toBe('compute-unavailable')
    await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'compute-unavailable', message: expect.stringContaining('Compute update required') })
  })

  it('does not accept an inspect answer that carries no readiness or bootstrap', async () => {
    const { service, projectId } = await world({ auto: true, extra: { FIXTURE_BARE_INSPECT: '1' } })
    await service.create({ projectId, recipe: 'developer' }).catch(() => undefined)
    expect(await service.view(projectId)).toMatchObject({ state: 'compute-unavailable', compute: { ok: false, reason: 'upgrade-required' } })
  })
})

describe('an updated CLI with a pre-update controller still running', () => {
  it('reports the exact mismatch before calling a route the old controller does not have', async () => {
    const backend = new FixtureCompute({ extra: { FIXTURE_CONTROLLER_VERSION: '0.1.0' } }); backends.push(backend)
    const contract = await backend.client.environmentContract()
    expect(contract).toMatchObject({ ok: false, reason: 'upgrade-required', installed: { version: '0.1.6' },
      message: expect.stringMatching(/running controller is Compute 0\.1\.0.*compute-configured down.*compute-configured up/) })
    expect(await backend.calls()).not.toContain('recipe list')
  })
})

describe('concurrent requests', () => {
  it('refuses a second operation on the same project while one is in flight', async () => {
    const { service, projectId } = await world({ auto: true })
    const results = await Promise.allSettled([service.create({ projectId, recipe: 'developer' }), service.create({ projectId, recipe: 'developer' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' })
  })
})

it('waits for Compute rather than assuming: an environment that never becomes ready is still Configuring after the settle window', async () => {
  const { backend, service, projectId } = await world({ extra: { FIXTURE_SLOW_START: '1' } })
  await service.create({ projectId, recipe: 'developer' })
  const name = (await service.view(projectId)).reference!.environment
  await backend.phase(name, 'stopped')
  const started = await service.act(projectId, 'start')
  expect(started.state).toBe('configuring')
})
