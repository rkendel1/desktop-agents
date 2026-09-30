import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TestKit, waitUntil, type Booted } from '../coding/testkit'
import type { DevelopmentEnvironmentView } from '../../shared/types'
import { ComputeMain, FixtureCompute, type ComputeBackend } from './testkit'
import { EnvironmentError, EnvironmentRefusal, EnvironmentService } from './service'

/**
 * Foundry's Environment control plane against the Compute environment contract — one suite, two implementations of that contract:
 * the contract fixture (recordings of real Compute main output) and, wherever a Compute main build exists, the real daemon
 * (`FOUNDRY_COMPUTE_MAIN`, `COMPUTE_MAIN_REPO`, or a checkout next to this one). The assertions are identical; only what "ready" takes differs.
 * The real-Compute suite is skipped, and reported as skipped, where no build is present.
 */
vi.setConfig({ testTimeout: 120_000 })
const main = new ComputeMain()
const backends: { label: string; enabled: boolean; make: () => ComputeBackend }[] = [
  { label: 'contract fixture', enabled: true, make: () => new FixtureCompute() },
  { label: 'real Compute main', enabled: main.installed, make: () => main }
]

for (const { label, enabled, make } of backends) {
  describe.skipIf(!enabled)(`Foundry Environment control plane on the ${label}`, () => {
    const backend = make()
    const kit = new TestKit()
    beforeAll(async () => { await backend.start(); await backend.defineRecipe('developer'); await backend.defineUnsatisfiableRecipe('needs-terminal') }, 240_000)
    afterEach(() => kit.cleanup())
    afterAll(() => backend.stop(), 90_000)

    const options = { settleMs: 60_000, pollMs: 100 }
    async function world(): Promise<{ booted: Booted; projectId: string; service: EnvironmentService }> {
      const booted = await kit.boot()
      const project = await booted.coding.addProject(kit.repository(), 'Fixture')
      return { booted, projectId: project.id, service: new EnvironmentService(booted.desktop.repository, backend.client, options) }
    }
    /** Let Compute finish, then read what it says — waiting on Compute's readiness, never assuming it. */
    async function untilReady(service: EnvironmentService, projectId: string): Promise<DevelopmentEnvironmentView> {
      let view = await service.view(projectId)
      await waitUntil(async () => { if (view.reference) await backend.bring(view.reference.environment); view = await service.view(projectId); return view.state === 'ready' }, 120_000)
      return view
    }
    const created = async (): Promise<Awaited<ReturnType<typeof world>> & { view: DevelopmentEnvironmentView; name: string }> => {
      const w = await world()
      await w.service.create({ projectId: w.projectId, recipe: 'developer' })
      const view = await untilReady(w.service, w.projectId)
      return { ...w, view, name: view.reference!.environment }
    }

    it('discovers the recipes Compute has, with the digest Compute gives them', async () => {
      const { service } = await world()
      const recipes = await service.recipes()
      expect(recipes.map(recipe => recipe.name)).toEqual(expect.arrayContaining(['developer', 'needs-terminal']))
      expect(recipes.find(recipe => recipe.name === 'developer')).toMatchObject({ version: 1, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), lifecycle: 'persistent' })
    })

    it('resolves a recipe in Compute: requirements, placement, and satisfiable', async () => {
      const { service } = await world()
      const resolution = await service.resolve('developer')
      expect(resolution).toMatchObject({ verdict: 'satisfiable', recipe: { name: 'developer', version: 1 }, problems: [] })
      expect(resolution.requirements).toMatchObject({ lifecycle: 'persistent', network: 'network' })
      expect(resolution.placement?.selected).toBe('this-machine')
      expect(resolution.placement?.targets.find(target => target.id === 'this-machine')).toMatchObject({ eligible: true, selected: true })
    })

    it('reports an unsatisfiable recipe as unsatisfied, with placement’s reason for every target, and creates nothing from it', async () => {
      const { service, projectId, booted } = await world()
      const resolution = await service.resolve('needs-terminal')
      expect(resolution.verdict).toBe('unsatisfied')
      expect(resolution.placement?.targets.every(target => !target.eligible && target.reasons.length > 0)).toBe(true)
      expect(resolution.placement?.targets.flatMap(target => target.reasons.map(reason => reason.code))).toContain('session_capability_unsupported')
      const before = (await backend.client.inventory()).environments.length
      await expect(service.create({ projectId, recipe: 'needs-terminal' })).rejects.toMatchObject({ name: 'EnvironmentError', category: 'requirements_unsatisfied', message: expect.stringContaining('no Computer can satisfy it') })
      expect((await backend.client.inventory()).environments.length).toBe(before)
      expect(await booted.desktop.repository.developmentEnvironment(projectId)).toBeUndefined()
      expect((await service.view(projectId)).state).toBe('none')
    })

    it('refuses to resolve a recipe Compute does not have', async () => {
      const { service } = await world()
      await expect(service.resolve('no-such-recipe')).rejects.toBeInstanceOf(EnvironmentError)
    })

    it('creates an environment through Compute, follows it to ready, and shows the recipe Compute recorded — not one Foundry remembers', async () => {
      const { booted, projectId, service } = await world()
      const first = await service.create({ projectId, recipe: 'developer' })
      // The reference is all Foundry stored: identifiers, and the request.
      const reference = await booted.desktop.repository.developmentEnvironment(projectId)
      expect(reference).toMatchObject({ projectId, environment: expect.stringMatching(/^foundry-fixture-[0-9a-f]{6}$/), environmentId: expect.stringMatching(/^env_/), requestedRecipe: { name: 'developer', version: 1 } })
      expect(Object.keys(reference!).sort()).toEqual(['createdAt', 'environment', 'environmentId', 'projectId', 'requestedRecipe'])
      // Just after create Compute has a Computer for it and it is not ready.
      expect(first.computer).toBeDefined()
      expect(first.state).not.toBe('ready')
      expect(first.readiness).not.toBe('ready')
      const ready = await untilReady(service, projectId)
      expect(ready).toMatchObject({ state: 'ready', readiness: 'ready', configuration: 'succeeded', lifecycle: 'running', actions: ['open', 'restart', 'stop', 'destroy'] })
      expect(ready.recipe).toMatchObject({ name: 'developer', version: 1, digest: (await service.recipes()).find(recipe => recipe.name === 'developer')!.digest })
      expect(ready.computer).toMatchObject({ target: 'this-machine', platformLabel: expect.stringMatching(/Linux x86_64|macOS ARM64/), lifecycle: 'persistent' })
      expect(ready.progress.map(step => step.status)).toEqual(['done', 'done', 'done', 'done', 'done'])
    })

    it('never shows ready unless Compute’s readiness is ready, at any step of getting there', async () => {
      const { service, projectId } = await world()
      await service.create({ projectId, recipe: 'developer' })
      const seen: DevelopmentEnvironmentView[] = []
      await waitUntil(async () => {
        const view = await service.view(projectId); seen.push(view)
        if (view.reference) await backend.bring(view.reference.environment, undefined).catch(() => undefined)
        return view.state === 'ready'
      }, 120_000)
      for (const view of seen) if (view.state === 'ready') expect(view.readiness).toBe('ready')
      // Every observation with a Computer that was not ready said so.
      expect(seen.filter(view => view.readiness !== 'ready').every(view => view.state !== 'ready')).toBe(true)
    })

    it('admits a workload to a ready environment, and only after Compute says so', async () => {
      const { service, projectId, view, name } = await created()
      const admission = await service.admit(projectId)
      expect(admission).toMatchObject({ environment: name, environmentId: view.reference!.environmentId })
      expect(admission.view.state).toBe('ready')
    })

    it('stops through Compute, shows Stopped only once Compute says so, refuses workloads while stopped, and starts again', async () => {
      const { service, projectId, name } = await created()
      const stopped = await service.act(projectId, 'stop')
      expect(stopped).toMatchObject({ state: 'stopped', lifecycle: 'stopped', actions: ['start', 'destroy'] })
      // Compute is the authority on that: it says the same.
      expect((await backend.client.inspectEnvironment(name)).computer!.reality.observed).toBe('stopped')
      await expect(service.admit(projectId)).rejects.toMatchObject({ name: 'EnvironmentRefusal', code: 'not-ready', state: 'stopped', message: expect.stringContaining('stopped') })
      let started = await service.act(projectId, 'start')
      if (started.state !== 'ready') started = await untilReady(service, projectId)
      expect(started).toMatchObject({ state: 'ready', readiness: 'ready' })
      expect((await service.admit(projectId)).environment).toBe(name)
    })

    it('restarts through Compute and is ready again only as Compute verifies it', async () => {
      const { service, projectId } = await created()
      let restarted = await service.act(projectId, 'restart')
      if (restarted.state !== 'ready') restarted = await untilReady(service, projectId)
      expect(restarted).toMatchObject({ state: 'ready', readiness: 'ready' })
    })

    it('destroys through Compute: Compute confirms it, then the project has no environment, and Compute keeps the record as evidence', async () => {
      const { service, projectId, name, booted } = await created()
      const destroyed = await service.act(projectId, 'destroy')
      expect(destroyed.state).toBe('none')
      expect(await booted.desktop.repository.developmentEnvironment(projectId)).toBeUndefined()
      expect((await backend.client.inspectEnvironment(name)).computer!.reality.observed).toBe('destroyed')
    })

    it('does not allow an action the environment’s state does not offer', async () => {
      const { service, projectId } = await created()
      await expect(service.act(projectId, 'start')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('does not allow') })
    })

    it('does not create a second environment over a live one', async () => {
      const { service, projectId } = await created()
      await expect(service.create({ projectId, recipe: 'developer' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('already has an environment') })
    })

    it('says the environment is unavailable — and does not replace it — when Compute no longer has it', async () => {
      const { service, projectId, booted, view } = await created()
      // Foundry’s reference names something Compute has no record of (lost, or removed from Compute’s state).
      const lost = { ...view.reference!, environment: 'foundry-never-existed-abc123', environmentId: 'env_gone' }
      await booted.desktop.repository.putDevelopmentEnvironment(lost)
      const missing = await service.view(projectId)
      expect(missing).toMatchObject({ state: 'missing', actions: ['create'], reason: { title: 'Environment unavailable', message: 'The Compute environment associated with this project no longer exists.' } })
      await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'missing' })
      // Nothing was created behind the person’s back; the reference is still the lost one.
      expect((await booted.desktop.repository.developmentEnvironment(projectId))?.environment).toBe('foundry-never-existed-abc123')
      // Creating a new one is an explicit act, and replaces the reference.
      await service.create({ projectId, recipe: 'developer' })
      expect((await booted.desktop.repository.developmentEnvironment(projectId))?.environment).not.toBe('foundry-never-existed-abc123')
    })

    it('shows an environment destroyed in Compute (not through Foundry) as Destroyed, with a way to create a new one', async () => {
      const { service, projectId, name } = await created()
      await backend.client.destroyEnvironment(name)
      const view = await service.view(projectId)
      expect(view).toMatchObject({ state: 'destroyed', actions: ['create'], readiness: 'unavailable' })
      await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'not-ready', state: 'destroyed' })
    })

    it('does not accept a different environment under the referenced name', async () => {
      const { service, projectId, booted, view } = await created()
      await booted.desktop.repository.putDevelopmentEnvironment({ ...view.reference!, environmentId: 'env_someone_elses' })
      expect(await service.view(projectId)).toMatchObject({ state: 'missing', reason: { category: 'environment_replaced' } })
      await expect(service.admit(projectId)).rejects.toMatchObject({ code: 'mismatch' })
    })

    it('adopts an environment Compute recorded when Foundry died before it learned the id, and reports one Compute never recorded', async () => {
      const { service, projectId, booted } = await world()
      await backend.client.createFromRecipe('foundry-interrupted-aaa111', { name: 'developer', version: 1 })
      await booted.desktop.repository.putDevelopmentEnvironment({ projectId, environment: 'foundry-interrupted-aaa111', requestedRecipe: { name: 'developer', version: 1 }, createdAt: Date.now() })
      const adopted = await service.view(projectId)
      expect(adopted.reference?.environmentId).toMatch(/^env_/)
      expect((await booted.desktop.repository.developmentEnvironment(projectId))?.environmentId).toBe(adopted.reference!.environmentId)
      // …and when Compute has no record, it says the creation was interrupted rather than “Creating…” forever.
      await booted.desktop.repository.putDevelopmentEnvironment({ projectId, environment: 'foundry-never-recorded-bbb222', createdAt: Date.now() })
      expect(await service.view(projectId)).toMatchObject({ state: 'missing', reason: { message: expect.stringContaining('interrupted') } })
    })

    it('recovers after a Foundry restart and a Compute daemon restart by asking Compute again', async () => {
      const root = kit.temporary('env-root-')
      const first = await kit.boot(root)
      const project = await first.coding.addProject(kit.repository(), 'Fixture')
      const service = new EnvironmentService(first.desktop.repository, backend.client, options)
      await service.create({ projectId: project.id, recipe: 'developer' })
      const ready = await untilReady(service, project.id)
      await kit.shutdown(first)
      // Foundry restarts on the same data…
      const second = await kit.boot(root)
      const restarted = new EnvironmentService(second.desktop.repository, backend.client, options)
      expect(await restarted.view(project.id)).toMatchObject({ state: 'ready', reference: { environment: ready.reference!.environment, environmentId: ready.reference!.environmentId } })
      // …and so does Compute’s controller: nothing Foundry remembered is consulted.
      await backend.daemon(false)
      expect(await restarted.view(project.id)).toMatchObject({ state: 'compute-unavailable', reason: { category: 'daemon-unreachable' } })
      await backend.daemon(true)
      await waitUntil(async () => { const view = await restarted.view(project.id); return view.state === 'ready' }, 120_000)
      expect((await restarted.view(project.id)).reference?.environmentId).toBe(ready.reference!.environmentId)
    }, 240_000)

    it('refuses workloads with an explicit reason, and starts nothing anywhere else, when there is no environment, Compute is down, or the environment is not ready', async () => {
      const { service, projectId, booted } = await world()
      const agent = await booted.desktop.repository.createAgent({ name: 'Coder', role: 'Engineer', instructions: '', color: '#0b5cff', provider: 'local', model: 'default' })
      const coding = new (await import('../coding/service')).CodingService(booted.desktop.repository, booted.runtime, () => undefined, { compute: backend.client, environments: service })
      const start = () => coding.start({ projectId, agentId: agent.id, task: 'Fix add()', execution: { kind: 'compute' } })
      await expect(start()).rejects.toThrow(/Compute was selected, so nothing was started on this computer\. This project has no development environment/)
      await service.create({ projectId, recipe: 'developer' })
      await expect(start()).rejects.toThrow(/not ready for workloads/)
      const ready = await untilReady(service, projectId)
      await service.act(projectId, 'stop')
      await expect(start()).rejects.toThrow(/environment “.+” is stopped, not ready for workloads/)
      await backend.daemon(false)
      await expect(start()).rejects.toThrow(/Compute daemon is not answering/)
      await backend.daemon(true)
      expect(ready.state).toBe('ready')
      // None of those became a session, here or elsewhere.
      expect(await booted.desktop.repository.codingSessions()).toEqual([])
    }, 240_000)
  })
}

describe('the contract suite runs against real Compute main when one is built', () => {
  it.skipIf(main.installed)('is skipped here: no Compute main build was found (set FOUNDRY_COMPUTE_MAIN or COMPUTE_MAIN_REPO)', () => { expect(main.installed).toBe(false) })
  it.skipIf(!main.installed)('found a Compute main build', () => { expect(main.binary).toBeTruthy() })
})
