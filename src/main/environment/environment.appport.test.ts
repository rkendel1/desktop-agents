import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@appport/client'
import { createInProcessTransport } from '@appport/transport-inprocess'
import { createFoundryAppPort } from '../appport/host'
import { apiKeyAuthenticator, ensureClientApiKey, openDesktopServices } from '../appport/services'
import { CodingApi } from '../coding/api'
import { CodingService } from '../coding/service'
import { TestKit, waitUntil } from '../coding/testkit'
import type { DevelopmentEnvironmentView, RecipeResolutionView, RecipeSummary } from '../../shared/types'
import { EnvironmentService } from './service'
import { ComputeMain, FixtureCompute, type ComputeBackend } from './testkit'

/**
 * The Environment is the same service through AppPort as it is on the desktop: a client reads and controls it through the public
 * contract, and gets Compute's answers — including the refusals. Run against the contract fixture and, where built, real Compute main.
 */
vi.setConfig({ testTimeout: 120_000 })
const main = new ComputeMain()
for (const { label, enabled, make } of [{ label: 'contract fixture', enabled: true, make: (): ComputeBackend => new FixtureCompute({ auto: true }) }, { label: 'real Compute main', enabled: main.installed, make: (): ComputeBackend => main }]) {
  describe.skipIf(!enabled)(`Environment through AppPort on the ${label}`, () => {
    const backend = make()
    const kit = new TestKit()
    beforeAll(async () => { await backend.start(); await backend.defineRecipe('developer'); await backend.defineUnsatisfiableRecipe('needs-terminal') }, 240_000)
    afterEach(() => kit.cleanup())
    afterAll(() => backend.stop(), 90_000)

    async function connect() {
      const booted = await kit.boot()
      const project = await booted.coding.addProject(kit.repository(), 'Remote')
      const environments = new EnvironmentService(booted.desktop.repository, backend.client, { settleMs: 60_000, pollMs: 100 })
      const coding = new CodingService(booted.desktop.repository, booted.runtime, () => undefined, { compute: backend.client, environments })
      const api = new CodingApi(booted.desktop.repository, coding, () => undefined, backend.client, undefined, environments)
      const services = openDesktopServices(booted.desktop.databaseDirectory)
      const { secret } = await ensureClientApiKey(services, booted.root)
      const app = createFoundryAppPort(api, apiKeyAuthenticator(services))
      const identity = await app.server.identify({ transport: 'inprocess', headers: { authorization: `Bearer ${secret}` } })
      const remote = createClient({ transport: createInProcessTransport({ server: app.server, identity }) })
      await remote.connect()
      return { remote, project, environments, booted, close: async () => { await remote.close(); app.close(); await services.apiKeys.close() } }
    }

    it('reads recipes and their resolution, creates the environment, follows it to ready, and controls it — through the contract, with Compute’s answers', async () => {
      const { remote, project, environments, close } = await connect()
      try {
        const recipes = await remote.call<{ recipes: RecipeSummary[] }>('douchat.environment.recipes', {})
        expect(recipes.recipes.map(recipe => recipe.name)).toEqual(expect.arrayContaining(['developer']))
        expect(await remote.call<RecipeResolutionView>('douchat.environment.resolve', { recipe: 'developer' })).toMatchObject({ verdict: 'satisfiable' })
        expect(await remote.call<RecipeResolutionView>('douchat.environment.resolve', { recipe: 'needs-terminal' })).toMatchObject({ verdict: 'unsatisfied' })
        expect(await remote.call<DevelopmentEnvironmentView>('douchat.environment.get', { projectId: project.id })).toMatchObject({ state: 'none', actions: ['create'] })
        await expect(remote.call('douchat.environment.create', { projectId: project.id, recipe: 'needs-terminal' })).rejects.toBeDefined()

        const created = await remote.call<DevelopmentEnvironmentView>('douchat.environment.create', { projectId: project.id, recipe: 'developer' })
        expect(created.reference?.environment).toMatch(/^foundry-remote-/)
        let view = created
        for (let attempt = 0; attempt < 240 && view.state !== 'ready'; attempt++) { await new Promise(resolve => setTimeout(resolve, 250)); view = await remote.call<DevelopmentEnvironmentView>('douchat.environment.get', { projectId: project.id }) }
        expect(view).toMatchObject({ state: 'ready', readiness: 'ready', recipe: { name: 'developer', version: 1 } })
        // The desktop’s service is the very same environment.
        expect((await environments.view(project.id)).reference?.environment).toBe(view.reference!.environment)

        expect(await remote.call<DevelopmentEnvironmentView>('douchat.environment.stop', { projectId: project.id })).toMatchObject({ state: 'stopped' })
        await expect(remote.call('douchat.environment.stop', { projectId: project.id })).rejects.toBeDefined()   // Compute’s state does not allow it now
        let started = await remote.call<DevelopmentEnvironmentView>('douchat.environment.start', { projectId: project.id })
        for (let attempt = 0; attempt < 240 && started.state !== 'ready'; attempt++) { await new Promise(resolve => setTimeout(resolve, 250)); started = await remote.call<DevelopmentEnvironmentView>('douchat.environment.get', { projectId: project.id }) }
        expect(started.state).toBe('ready')
        const detail = await remote.call<{ state: string; detail?: { conditions: unknown[]; environmentId: string } }>('douchat.environment.detail', { projectId: project.id })
        expect(detail.state).toBe('ready'); expect(detail.detail?.conditions.length).toBeGreaterThan(0)

        // Destroy is irreversible: the client must say so, and Compute confirms it.
        await expect(remote.call('douchat.environment.destroy', { projectId: project.id, confirm: false })).rejects.toBeDefined()
        expect((await environments.view(project.id)).state).toBe('ready')
        expect(await remote.call<DevelopmentEnvironmentView>('douchat.environment.destroy', { projectId: project.id, confirm: true })).toMatchObject({ state: 'none' })
      } finally { await close() }
    })

    it('refuses a session on the environment with Compute’s reason until it is ready, and nothing runs anywhere else', async () => {
      const { remote, project, booted, environments, close } = await connect()
      try {
        const agent = await booted.desktop.repository.createAgent({ name: 'Coder', role: 'Engineer', instructions: '', color: '#0b5cff', provider: 'local', model: 'default' })
        const start = () => remote.call('douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: 'Fix add()', execution: { kind: 'compute' } })
        await expect(start()).rejects.toThrow(/Compute was selected, so nothing was started on this computer\. This project has no development environment/)
        await remote.call('douchat.environment.create', { projectId: project.id, recipe: 'developer' })
        await waitUntil(async () => (await environments.view(project.id)).state === 'ready', 120_000)
        await environments.act(project.id, 'stop')
        await expect(start()).rejects.toThrow(/is stopped, not ready for workloads/)
        expect(await booted.desktop.repository.codingSessions()).toEqual([])
      } finally { await close() }
    })
  })
}
