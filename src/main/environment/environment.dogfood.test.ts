import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { taskText, TestKit, waitUntil } from '../coding/testkit'
import { ComputeMain } from './testkit'
import { EnvironmentService } from './service'

/**
 * The whole flow on real Foundry and real Compute main — a real daemon, recipe, Computer, bootstrap and readiness, and a real agent
 * process on that Computer — with every transition read back from Compute:
 *
 *   project → create environment → recipe resolves → Computer created → bootstrap → Ready → agent session runs a real command →
 *   Stop → refused while stopped → Start → readiness re-established → workload again → Destroy;  and: Compute unavailable → refused.
 *
 * Skipped, and reported so, where no Compute main build exists (see testkit.ts). It is not run against Compute Configured 0.1.5.
 */
vi.setConfig({ testTimeout: 300_000 })
const main = new ComputeMain()
const kit = new TestKit()

describe.skipIf(!main.installed)('dogfood: Foundry + real Compute main', () => {
  beforeAll(async () => { await main.start(); await main.defineRecipe('developer') }, 240_000)
  afterEach(() => kit.cleanup())
  afterAll(() => main.stop(), 90_000)

  it('creates, uses, stops, restarts and destroys a developer environment, and Foundry reflects every transition Compute reports', async () => {
    const path = kit.repository()
    const booted = await kit.boot(undefined, { compute: main.client })
    const service = new EnvironmentService(booted.desktop.repository, main.client, { settleMs: 60_000, pollMs: 200 })
    const coding = new (await import('../coding/service')).CodingService(booted.desktop.repository, booted.runtime, () => undefined, { compute: main.client, environments: service })
    const agent = await kit.scriptedAgent(booted)
    const project = await coding.addProject(path, 'Dogfood')
    const transitions: string[] = []
    const observe = async () => { const view = await service.view(project.id); if (transitions.at(-1) !== view.state) transitions.push(view.state); return view }

    // Create: the recipe resolves in Compute; Compute places, creates, bootstraps and verifies.
    expect((await service.resolve('developer')).verdict).toBe('satisfiable')
    expect((await observe()).state).toBe('none')
    await service.create({ projectId: project.id, recipe: 'developer' })
    await waitUntil(async () => (await observe()).state === 'ready', 120_000)
    const ready = await service.view(project.id)
    const name = ready.reference!.environment
    expect(transitions[0]).toBe('none')
    expect(transitions.slice(1, -1).every(state => ['creating', 'configuring'].includes(state))).toBe(true)
    expect(transitions.at(-1)).toBe('ready')
    expect(ready.recipe).toMatchObject({ name: 'developer', version: 1 })
    // Compute agrees with what Foundry shows.
    const inspected = await main.client.inspectEnvironment(name)
    expect(inspected.computer).toMatchObject({ status: 'running', readiness: { state: 'ready' }, bootstrap: { state: 'succeeded' } })

    // Run a real workload: a real agent process on the Computer runs the project's tests, edits a file, and runs them again.
    const started = await coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute' }, task: taskText('Fix add().', { action: 'fix-add' }) })
    expect(started.execution).toMatchObject({ kind: 'compute', environment: name, environmentId: ready.reference!.environmentId })
    const first = (await coding.settled(started.id))!
    expect(first.error).toBeUndefined()
    expect(first.status).toBe('succeeded')
    expect(first.result).toContain('test-before=1'); expect(first.result).toContain('test-after=0')
    expect(first.changes).toEqual([expect.objectContaining({ path: 'src/math.js', origin: 'session' })])
    expect(readFileSync(join(path, 'src', 'math.js'), 'utf8')).toContain('a - b')   // the work happened on the Computer, not here
    expect((await booted.desktop.repository.processLedger().all()).filter(row => row.role === 'agent')).toEqual([])

    // Stop: Compute confirms it, Foundry then shows Stopped, and a workload is refused with the reason.
    const stopped = await service.act(project.id, 'stop')
    expect(stopped.state).toBe('stopped')
    expect((await main.client.inspectEnvironment(name)).computer!.reality.observed).toBe('stopped')
    await expect(coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute' }, task: taskText('Again.', { action: 'none' }) }))
      .rejects.toThrow(/Compute was selected, so nothing was started on this computer\..*is stopped, not ready for workloads/)

    // Start: readiness is re-established by Compute, and only then does the workload run again.
    let again = await service.act(project.id, 'start')
    if (again.state !== 'ready') await waitUntil(async () => (again = await service.view(project.id)).state === 'ready', 120_000)
    expect(again.readiness).toBe('ready')
    const second = (await coding.settled((await coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute' }, task: taskText('Again.', { action: 'touch', files: { 'notes.txt': 'second run\n' } }) })).id))!
    expect(second.status).toBe('succeeded')
    expect(second.changes.map(change => change.path)).toContain('notes.txt')

    // Compute unavailable: refused with an explicit reason, nothing runs here instead.
    await main.daemon(false)
    expect((await service.view(project.id)).state).toBe('compute-unavailable')
    await expect(coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute' }, task: taskText('Never.', { action: 'none' }) })).rejects.toThrow(/Compute was selected, so nothing was started on this computer\..*not answering/)
    await main.daemon(true)
    await waitUntil(async () => (await service.view(project.id)).state === 'ready', 120_000)

    // Destroy: the project has no environment once Compute has confirmed the Computer is gone.
    expect((await service.act(project.id, 'destroy')).state).toBe('none')
    expect((await main.client.inspectEnvironment(name)).computer!.reality.observed).toBe('destroyed')
    expect((await booted.desktop.repository.codingSessions()).every(session => session.status !== 'running')).toBe(true)
  })
})
