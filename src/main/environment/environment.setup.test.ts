import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { TestKit } from '../coding/testkit'
import { FixtureCompute } from './testkit'
import { EnvironmentService } from './service'

vi.setConfig({ testTimeout: 60_000 })
const kit = new TestKit()
const active: FixtureCompute[] = []
afterEach(async () => {
  await kit.cleanup()
  await Promise.all(active.splice(0).map(backend => backend.stop()))
})

async function world(options: ConstructorParameters<typeof FixtureCompute>[0] = { auto: true }) {
  const backend = new FixtureCompute(options); active.push(backend)
  const booted = await kit.boot()
  const project = await booted.coding.addProject(kit.repository(), 'Foundry')
  return { backend, booted, project, service: new EnvironmentService(booted.desktop.repository, backend.client, { settleMs: 2_000, pollMs: 10 }) }
}

it('creates, validates and attaches the installed Developer starter and dev environment using argv', async () => {
  const { backend, booted, project, service } = await world()
  const cli = vi.spyOn(backend.client, 'cli')
  const progress: string[][] = []
  const result = await service.setupDevelopment(project.id, update => progress.push(update.steps.map(step => `${step.id}:${step.status}`)))
  expect(result.view).toMatchObject({ state: 'ready', reference: { projectId: project.id, environment: 'dev', environmentId: expect.stringMatching(/^env_/) }, recipe: { name: 'developer', version: 1 } })
  expect(result.steps.every(step => step.status === 'done')).toBe(true)
  expect(progress.length).toBeGreaterThan(4)
  const recipeCall = cli.mock.calls.find(([args]) => args[0] === 'recipe' && args[1] === 'create')?.[0]
  expect(recipeCall).toEqual(['recipe', 'create', 'developer', '--file', expect.stringMatching(/libexec\/examples\/recipes\/dev\.json$/), '--daemon', 'http://127.0.0.1:8787'])
  expect(cli.mock.calls.some(([args]) => args.slice(0, 3).join(' ') === 'recipe validate developer')).toBe(true)
  expect(cli.mock.calls.some(([args]) => args.slice(0, 3).join(' ') === 'environment create dev')).toBe(true)
  expect(Object.keys((await booted.desktop.repository.developmentEnvironment(project.id))!).sort()).toEqual(['createdAt', 'environment', 'environmentId', 'projectId', 'requestedRecipe'])
})

it('is idempotent: it never recreates the user recipe or the existing dev environment', async () => {
  const { backend, project, service } = await world()
  await backend.defineRecipe('developer', { description: 'My recipe', lifecycle: 'persistent', requirements: {} })
  await backend.client.createFromRecipe('dev', { name: 'developer', version: 1 })
  await service.setupDevelopment(project.id)
  await service.setupDevelopment(project.id)
  const calls = await backend.calls()
  expect(calls.filter(call => call === 'recipe create developer')).toHaveLength(0)
  expect(calls.filter(call => call === 'environment create dev')).toHaveLength(1)
  expect((await service.view(project.id)).reference?.environment).toBe('dev')
})

it('does not create an environment from an invalid existing Developer recipe', async () => {
  const { backend, booted, project, service } = await world()
  await backend.defineRecipe('developer', { lifecycle: 'persistent', requirements: {}, __invalid: true })
  await expect(service.setupDevelopment(project.id)).rejects.toMatchObject({ code: 'conflict', category: 'invalid', message: expect.stringContaining('failed validation') })
  expect((await backend.client.inventory()).environments).toEqual([])
  expect(await booted.desktop.repository.developmentEnvironment(project.id)).toBeUndefined()
})

it('reports an installed-package starter defect and never consults a source checkout', async () => {
  const { backend, booted, project, service } = await world()
  rmSync(join(backend.home, 'libexec', 'examples', 'recipes', 'dev.json'))
  await expect(service.setupDevelopment(project.id)).rejects.toMatchObject({ category: 'starter_unavailable', message: expect.stringContaining('installed Compute distribution') })
  expect(await booted.desktop.repository.developmentEnvironment(project.id)).toBeUndefined()
})

it.each([
  ['recipe creation', { auto: true, extra: { FIXTURE_CREATE_RECIPE_FAIL: '1' } }, 'Could not create the Developer recipe'],
  ['environment creation', { auto: true, extra: { FIXTURE_CREATE_ENV_FAIL: '1' } }, 'could not create the development environment']
] as const)('reports %s failures and leaves no Project environment reference', async (_name, options, message) => {
  const { booted, project, service } = await world(options)
  await expect(service.setupDevelopment(project.id)).rejects.toThrow(message)
  expect(await booted.desktop.repository.developmentEnvironment(project.id)).toBeUndefined()
})

it('does not replace a pre-existing dev environment with different configuration', async () => {
  const { backend, project, service } = await world()
  await backend.defineRecipe('developer')
  await backend.defineRecipe('custom')
  await backend.client.createFromRecipe('dev', { name: 'custom', version: 1 })
  await expect(service.setupDevelopment(project.id)).rejects.toMatchObject({ category: 'environment_conflict' })
  expect((await backend.client.inspectEnvironment('dev')).recipe?.name).toBe('custom')
})

it('reports Computer startup failure while preserving the existing environment', async () => {
  const { backend, project, service } = await world({ auto: true, extra: { FIXTURE_START_FAIL: '1' } })
  await backend.defineRecipe('developer')
  await backend.client.createFromRecipe('dev', { name: 'developer', version: 1 })
  await backend.phase('dev', 'stopped')
  await expect(service.setupDevelopment(project.id)).rejects.toThrow('Computer did not start')
  expect((await backend.client.inspectEnvironment('dev')).computer?.reality.observed).toBe('stopped')
})

it('connects an existing Compute environment by verified name and immutable id without recreating it', async () => {
  const { backend, booted, project, service } = await world()
  await backend.defineRecipe('developer')
  const existing = await backend.client.createFromRecipe('dev', { name: 'developer', version: 1 })
  const before = (await backend.calls()).filter(call => call === 'environment create dev').length
  const result = await service.attach({ projectId: project.id, environment: 'dev', environmentId: existing.environment_id })
  expect(result).toMatchObject({ reference: { projectId: project.id, environment: 'dev', environmentId: existing.environment_id }, recipe: { name: 'developer', version: 1 } })
  expect(await booted.desktop.repository.developmentEnvironment(project.id)).toMatchObject({ environment: 'dev', environmentId: existing.environment_id })
  expect((await backend.calls()).filter(call => call === 'environment create dev')).toHaveLength(before)
})

it('does not connect when an environment name now belongs to a different id', async () => {
  const { backend, booted, project, service } = await world()
  await backend.defineRecipe('developer')
  await backend.client.createFromRecipe('dev', { name: 'developer', version: 1 })
  await expect(service.attach({ projectId: project.id, environment: 'dev', environmentId: 'env_replaced' })).rejects.toMatchObject({ code: 'conflict', category: 'environment_replaced' })
  expect(await booted.desktop.repository.developmentEnvironment(project.id)).toBeUndefined()
})
