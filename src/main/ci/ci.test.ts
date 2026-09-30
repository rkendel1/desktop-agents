import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@appport/client'
import { createInProcessTransport } from '@appport/transport-inprocess'
import { createFoundryAppPort } from '../appport/host'
import { apiKeyAuthenticator, ensureClientApiKey, openDesktopServices } from '../appport/services'
import { CodingApi } from '../coding/api'
import { TestKit, waitUntil, type Booted } from '../coding/testkit'
import { ComputeHarness } from '../compute/testkit'
import type { CiRun } from '../../shared/types'
import { CI_OUTPUT_LIMIT, CiService, type CiOptions } from './service'

/**
 * CI on ephemeral Compute Computers, against the installed Compute Configured and the real PAX. Nothing of Compute or PAX is mocked;
 * every workload runs on a Computer Compute creates for it and destroys afterwards. Skipped (and reported so) where they are not installed.
 */
interface CiPlanView { ready: boolean; computer: { lifecycle: string }; platform?: { label: string }; source?: { workspaceSource: string } }
const harness = new ComputeHarness()
const kit = new TestKit()

/**
 * A project whose PAX operations all exist. package-lock.json is the evidence PAX selects npm from, and one local dependency makes
 * `pax install` produce a node_modules — PAX reports a lockfile without one as drift, even for a project that depends on nothing.
 */
function project(scripts: Record<string, string> = {}, extra: (path: string) => void = () => undefined): string {
  const path = kit.repository()
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: {
    typecheck: 'node -e "console.log(\'typecheck ok\')"', lint: 'node -e "console.log(\'lint ok\')"', test: 'node test.js', build: 'node -e "console.log(\'build ok\')"', ...scripts } }))
  mkdirSync(join(path, 'localdep'))
  writeFileSync(join(path, 'localdep', 'package.json'), JSON.stringify({ name: 'localdep', version: '1.0.0' }))
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  writeFileSync(join(path, 'package.json'), JSON.stringify({ ...manifest, dependencies: { localdep: 'file:./localdep' } }))
  writeFileSync(join(path, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { localdep: 'file:./localdep' } }, localdep: { version: '1.0.0' }, 'node_modules/localdep': { resolved: 'localdep', link: true } } }))
  writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n')
  extra(path)
  kit.git(path, 'add', '-A'); kit.git(path, 'commit', '-q', '-m', 'ci fixture')
  return path
}

describe.skipIf(!harness.installed)('CI on ephemeral Compute Computers', () => {
  beforeAll(() => harness.start(), 240_000)
  afterEach(() => kit.cleanup())
  afterAll(() => harness.stop(), 90_000)

  async function ci(options: CiOptions = {}, root?: string): Promise<{ booted: Booted; service: CiService }> {
    const booted = await kit.boot(root, { compute: harness.client, pax: harness.pax })
    return { booted, service: new CiService(booted.desktop.repository, { compute: harness.client, pax: harness.pax, ...options }) }
  }
  const started = async (service: CiService, booted: Booted, path: string, input: { tool?: string } = {}): Promise<CiRun> => {
    const added = await booted.coding.addProject(path)
    return service.start({ projectId: added.id, ...input })
  }
  /** The Computer is gone: Compute observes it destroyed, nothing of it runs, and nothing is left listed as live. */
  async function expectReleased(run: CiRun): Promise<void> {
    expect(run.computer, JSON.stringify(run.computer)).toMatchObject({ lifecycle: 'ephemeral', released: true })
    expect((await harness.client.computer(run.computer!.environment)).observed).toBe('destroyed')
    expect(await harness.liveEnvironments('foundry-ci-')).not.toContain(run.computer!.environment)
  }
  const running = async (service: CiService, run: CiRun, operation: string): Promise<{ name: string; pid: number }> => {
    let found: { name: string; pid: number } | undefined
    await waitUntil(async () => {
      if (!found && (await service.get(run.id))?.status !== 'running') throw new Error(`The run ended before ${operation} was running: ${JSON.stringify(await service.get(run.id), null, 1)}`)
      const environment = (await service.get(run.id))?.computer?.environment
      const current = environment ? await harness.client.computer(environment).catch(() => undefined) : undefined
      const entry = Object.entries(current?.processes ?? {}).find(([name, state]) => name.startsWith(`foundry-ci-${operation}-`) && state.state === 'running' && state.pid)
      if (entry) found = { name: entry[0], pid: entry[1].pid! }
      return Boolean(found)
    }, 90_000)
    return found!
  }
  const alive = (pid: number): boolean => { try { process.kill(pid, 0) } catch { return false }; try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true } }

  it('plans with PAX, runs the operations on an ephemeral Computer, keeps the evidence and releases the Computer', async () => {
    const path = project({ test: 'node -e "console.log(\'on the computer:\', process.cwd()); setTimeout(() => {}, 4000)"' })
    const before = kit.git(path, 'rev-parse', 'HEAD').trim()
    const { booted, service } = await ci()
    const added = await booted.coding.addProject(path)

    // What Run CI would do, from PAX: the operations are PAX's answer for this project.
    const plan = await service.plan(added.id)
    expect(plan).toMatchObject({ ready: true, blockers: [], source: { revision: before, workspaceSource: 'committed-revision' }, computer: { lifecycle: 'ephemeral' } })
    expect(plan.platform?.status).toBe(process.platform === 'linux' && process.arch === 'x64' ? 'certified' : plan.platform?.status)
    expect(plan.plan!.operations.filter(item => item.supported).map(item => item.operation)).toEqual(['install', 'typecheck', 'lint', 'test', 'build'])
    expect(plan.plan!.operations.find(item => item.operation === 'test')).toMatchObject({ tool: 'npm', command: ['npm', 'run', 'test'], evidence: ['package-lock.json'] })

    const run = await service.start({ projectId: added.id })
    expect(run).toMatchObject({ number: 1, status: 'running', source: { revision: before } })
    // While it runs there is one real Computer, and Compute's own API and UI show it.
    const test = await running(service, run, 'test')
    const live = (await booted.desktop.repository.ciRun(run.id))!
    expect(live.computer).toMatchObject({ lifecycle: 'ephemeral', released: false, environment: expect.stringMatching(/^foundry-ci-1-/) })
    const api = await (await fetch(`${harness.daemon}/environments/${live.computer!.environment}/computer`)).json() as { lifecycle?: string; observed?: { processes?: Record<string, { state?: string }> } }
    expect(api.lifecycle).toBe('ephemeral')
    expect(api.observed?.processes?.[test.name]?.state).toBe('running')
    expect((await fetch(`${harness.daemon}/ui/`)).status).toBe(200)
    expect(await harness.liveEnvironments('foundry-ci-')).toContain(live.computer!.environment)

    const done = (await service.settled(run.id))!
    expect(done).toMatchObject({ status: 'passed', phase: 'done' })
    expect(done.operations.map(item => [item.operation, item.status, item.exitCode])).toEqual([['install', 'passed', 0], ['typecheck', 'passed', 0], ['lint', 'passed', 0], ['test', 'passed', 0], ['build', 'passed', 0]])
    // The tests ran on the Computer, in its checkout of the revision — not here.
    const cwd = /on the computer: (.*)/.exec(done.operations.find(item => item.operation === 'test')!.stdout)![1].trim()
    expect(cwd).toContain('/computers/sessions/workspaces/')
    expect(cwd).toContain(`/repos/${done.computer!.repository}`)
    expect(realpathSync(path)).not.toBe(cwd)
    expect(done.operations.find(item => item.operation === 'typecheck')).toMatchObject({ tool: 'npm', command: ['npm', 'run', 'typecheck'] })
    expect(done.plan).toMatchObject({ ambiguous: false, drift: false, note: 'PAX on the Computer planned the same commands.' })
    expect(done.platform?.label).toBe('Linux x86_64 — Certified')
    await expectReleased(done)
    expect(alive(test.pid)).toBe(false)
    expect(existsSync(cwd)).toBe(false)
    // The local repository is exactly as it was: the work happened on the Computer.
    expect(kit.git(path, 'status', '--porcelain')).toBe('')
    // The record is references and bounded evidence: no source, no diff.
    const stored = JSON.stringify(await booted.desktop.repository.ciRun(run.id))
    expect(stored).not.toContain('return a + b')
    expect(stored).not.toContain('function add')
    expect(done.events.map(item => item.label)).toEqual(expect.arrayContaining(['PAX planned the project', 'Acquiring an ephemeral Computer', 'Revision checked out on the Computer', 'Releasing the Computer', 'CI passed']))

    // Foundry can inspect the durable result after the Computer is gone — and after Foundry itself restarted.
    const root = booted.root
    await kit.shutdown(booted)
    const again = await ci({}, root)
    expect(await again.service.get(run.id)).toMatchObject({ status: 'passed', computer: { released: true }, source: { revision: before } })
    expect((await again.service.list()).map(item => item.number)).toEqual([1])
  }, 300_000)

  it('a failing operation fails the run, stops after it, keeps the exit status and output, and still releases the Computer', async () => {
    const path = project({ test: 'node -e "console.error(\'assertion: expected 5\'); process.exit(3)"' })
    const { booted, service } = await ci()
    const run = await started(service, booted, path)
    const done = (await service.settled(run.id))!
    expect(done.status).toBe('failed')
    expect(done.failure).toMatchObject({ kind: 'operation', operation: 'test' })
    expect(done.operations.map(item => item.operation)).toEqual(['install', 'typecheck', 'lint', 'test'])
    const failed = done.operations.at(-1)!
    expect(failed).toMatchObject({ status: 'failed', exitCode: 3, tool: 'npm' })
    expect(`${failed.stdout}${failed.stderr}`).toContain('assertion: expected 5')
    await expectReleased(done)
  }, 300_000)

  it('cancelling stops the process on the Computer through Compute, then releases the Computer', async () => {
    const path = project({ test: 'node -e "setTimeout(() => {}, 120000)"' })
    const { booted, service } = await ci()
    const run = await started(service, booted, path)
    const test = await running(service, run, 'test')
    await service.cancel(run.id)
    const done = (await service.settled(run.id))!
    expect(done).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' } })
    expect(done.operations.at(-1)).toMatchObject({ operation: 'test', status: 'cancelled' })
    expect(alive(test.pid)).toBe(false)
    await expectReleased(done)
  }, 300_000)

  it('a timeout stops the workload and releases the Computer', async () => {
    const path = project({ test: 'node -e "setTimeout(() => {}, 120000)"' })
    const { booted, service } = await ci({ operationTimeoutMs: 6000 })
    const run = await started(service, booted, path)
    const test = await running(service, run, 'test')
    const done = (await service.settled(run.id))!
    expect(done).toMatchObject({ status: 'failed', failure: { kind: 'timeout', operation: 'test' } })
    expect(done.operations.at(-1)).toMatchObject({ operation: 'test', status: 'timed-out' })
    expect(alive(test.pid)).toBe(false)
    await expectReleased(done)
  }, 300_000)

  it('a Compute error is Compute’s: a Computer it cannot place fails the run with its reason, nothing is left, and nothing runs locally', async () => {
    const path = project()
    const { booted, service } = await ci({ memory: '9999Ti' })
    const run = await started(service, booted, path)
    const done = (await service.settled(run.id))!
    expect(done).toMatchObject({ status: 'failed', failure: { kind: 'compute' } })
    expect(done.operations).toEqual([])
    expect(done.computer?.released).toBe(true)
    expect(await harness.liveEnvironments('foundry-ci-')).toEqual([])
    expect((await booted.desktop.repository.processLedger().all()).filter(row => row.role === 'agent')).toEqual([])
  }, 300_000)

  it('Foundry closing stops the workload and releases the Computer before it goes', async () => {
    const path = project({ test: 'node -e "setTimeout(() => {}, 120000)"' })
    const { booted, service } = await ci()
    const run = await started(service, booted, path)
    const test = await running(service, run, 'test')
    await service.shutdown()
    const done = (await booted.desktop.repository.ciRun(run.id))!
    expect(done).toMatchObject({ status: 'interrupted', failure: { kind: 'interrupted' } })
    expect(alive(test.pid)).toBe(false)
    await expectReleased(done)
  }, 300_000)

  it('after Foundry died mid-run, the next start releases the Computer the run left and marks the run interrupted', async () => {
    const path = project()
    const { booted, service } = await ci()
    const added = await booted.coding.addProject(path)
    // The state a crashed Foundry leaves: a run marked running, and a real Computer with a real process on it.
    const environment = `foundry-ci-crash-${Date.now() % 100000}`
    await harness.client.acquireEphemeral(environment, { ttlSeconds: 1800 })
    await harness.client.startProcess(environment, 'foundry-ci-test-orphan', ['sh', '-c', 'sleep 300'])
    let orphan = 0
    await waitUntil(async () => { orphan = (await harness.client.computer(environment)).processes['foundry-ci-test-orphan']?.pid ?? 0; return orphan > 0 }, 60_000)
    expect(alive(orphan)).toBe(true)
    const source = { repository: `file://${path}`, revision: kit.git(path, 'rev-parse', 'HEAD').trim(), workspaceSource: 'committed-revision' as const }
    const crashed = await booted.desktop.repository.createCiRun({ projectId: added.id, status: 'running', phase: 'executing', startedAt: Date.now(), source, computer: { environment, lifecycle: 'ephemeral', ttlSeconds: 1800, released: false } })
    expect(await harness.liveEnvironments('foundry-ci-crash')).toEqual([environment])
    const recovered = await service.recover()
    expect(recovered.map(item => item.id)).toEqual([crashed.id])
    const done = (await booted.desktop.repository.ciRun(crashed.id))!
    expect(done).toMatchObject({ status: 'interrupted', failure: { kind: 'interrupted' } })
    await expectReleased(done)
    expect(alive(orphan)).toBe(false)
    expect(await service.recover()).toEqual([]) // nothing further to do
  }, 300_000)

  it('PAX ambiguity stops the run before any Computer exists; choosing a tool explicitly runs it', async () => {
    const path = project({}, dir => writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      localdep:\n        specifier: file:./localdep\n        version: file:localdep\n"))
    const { booted, service } = await ci()
    const added = await booted.coding.addProject(path)
    const plan = await service.plan(added.id)
    expect(plan).toMatchObject({ ready: false, plan: { ambiguous: true } })
    const blocked = (await service.settled((await service.start({ projectId: added.id })).id))!
    expect(blocked).toMatchObject({ status: 'blocked', failure: { kind: 'ambiguous' }, operations: [] })
    expect(blocked.computer).toBeUndefined()
    expect(await harness.liveEnvironments('foundry-ci-')).not.toContainEqual(expect.stringMatching(/^foundry-ci-\d/))
    const explicit = (await service.settled((await service.start({ projectId: added.id, tool: 'npm' })).id))!
    expect(explicit.plan).toMatchObject({ tool: 'npm', note: expect.stringContaining('the person chose npm') })
    expect(explicit.status, JSON.stringify([explicit.failure, explicit.operations.map(o => [o.operation, o.status, o.stderr.slice(-300)])])).toBe('passed')
    expect(explicit.operations.find(item => item.operation === 'test')?.tool).toBe('npm')
    await expectReleased(explicit)
  }, 300_000)

  it('reports drift as drift, does not repair it, and releases the Computer', async () => {
    // `pax install` succeeds and leaves node_modules absent: what the project declares and what is installed no longer agree.
    const path = project({}, dir => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { localdep: 'file:./localdep' },
        scripts: { test: 'node test.js', postinstall: 'node -e "require(\'fs\').rmSync(\'node_modules\', { recursive: true, force: true })"' } }))
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'fixture', version: '1.0.0', hasInstallScript: true, dependencies: { localdep: 'file:./localdep' } }, localdep: { version: '1.0.0' }, 'node_modules/localdep': { resolved: 'localdep', link: true } } }))
    })
    const { booted, service } = await ci()
    const run = await started(service, booted, path)
    const done = (await service.settled(run.id))!
    expect(done).toMatchObject({ status: 'failed', failure: { kind: 'drift' }, plan: { drift: true } })
    expect(done.failure!.message).toMatch(/installed dependencies: node_modules\/ absent/)
    expect(done.failure!.message).toMatch(/not repaired/)
    // The install ran (that is the declared preparation); nothing after drift did.
    expect(done.operations.map(item => item.operation)).toEqual(['install'])
    await expectReleased(done)
  }, 300_000)

  it('is the same service through AppPort: plan, start, get, list and cancel a run, and a run started either way is the one record', async () => {
    const path = project({ test: 'node -e "setTimeout(() => {}, 120000)"' })
    const { booted, service } = await ci()
    const added = await booted.coding.addProject(path)
    const api = new CodingApi(booted.desktop.repository, booted.coding, (id, allow) => booted.runtime.resolveAgentPermission(id, allow), harness.client, service)
    const services = openDesktopServices(booted.desktop.databaseDirectory)
    const { secret } = await ensureClientApiKey(services, booted.root)
    const app = createFoundryAppPort(api, apiKeyAuthenticator(services))
    const identity = await app.server.identify({ transport: 'inprocess', headers: { authorization: `Bearer ${secret}` } })
    const remote = createClient({ transport: createInProcessTransport({ server: app.server, identity }) })
    await remote.connect()
    try {
      const plan = await remote.call<CiPlanView>('douchat.ci.plan', { projectId: added.id })
      expect(plan).toMatchObject({ ready: true, computer: { lifecycle: 'ephemeral' }, platform: { label: 'Linux x86_64 — Certified' }, source: { workspaceSource: 'committed-revision' } })
      const started = await remote.call<CiRun>('douchat.ci.runs.start', { projectId: added.id })
      expect(started).toMatchObject({ number: 1, status: 'running' })
      // The desktop's service sees the very run the remote client started.
      expect((await service.get(started.id))?.id).toBe(started.id)
      await running(service, started, 'test')
      expect((await remote.call<{ runs: CiRun[] }>('douchat.ci.runs.list', { status: 'running' })).runs.map(item => item.id)).toEqual([started.id])
      const cancelled = await remote.call<CiRun>('douchat.ci.runs.cancel', { id: started.id })
      expect(cancelled).toMatchObject({ status: 'cancelled', computer: { released: true } })
      expect(await remote.call<CiRun>('douchat.ci.runs.get', { id: started.id })).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' } })
      await expectReleased(cancelled)
      await expect(remote.call('douchat.ci.runs.cancel', { id: started.id })).rejects.toBeDefined() // already ended
    } finally { await remote.close(); app.close(); await services.apiKeys.close() }
  }, 300_000)

  it('refuses to test uncommitted local state, and records the revision it does test', async () => {
    const path = project()
    const { booted, service } = await ci()
    const added = await booted.coding.addProject(path)
    writeFileSync(join(path, 'src', 'math.js'), 'dirty\n')
    expect((await service.plan(added.id)).blockers.join(' ')).toMatch(/1 uncommitted file/)
    await expect(service.start({ projectId: added.id })).rejects.toThrow(/uncommitted/)
    expect(await service.list()).toEqual([])
    expect(CI_OUTPUT_LIMIT).toBe(16 * 1024)
  }, 120_000)
})
