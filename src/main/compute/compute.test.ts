import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@appport/client'
import { createInProcessTransport } from '@appport/transport-inprocess'
import { CodingApi } from '../coding/api'
import { createFoundryAppPort } from '../appport/host'
import { apiKeyAuthenticator, ensureClientApiKey, openDesktopServices } from '../appport/services'
import { runCommand } from '../coding/commands'
import { pidsReady, taskText, TestKit, waitUntil, type Booted } from '../coding/testkit'
import { ComputeClient, platformView, readStackEvidence } from './client'

/**
 * Foundry's coding sessions on the installed Compute Configured product: its real CLI, daemon, environment, Computer (a workspace
 * provided by the `this-machine` target) and the real PAX binary. Nothing of Compute is mocked. The tests need the installed
 * product, so they run where `compute-configured` (and `pax`) are installed — Homebrew, or `FOUNDRY_COMPUTE` / `FOUNDRY_PAX` — and are
 * reported as skipped elsewhere.
 */
const findBinary = (name: string, hints: string[]): string | undefined => {
  for (const candidate of [process.env[name === 'pax' ? 'FOUNDRY_PAX' : 'FOUNDRY_COMPUTE'], ...hints, ...(process.env.PATH ?? '').split(':').map(directory => join(directory, name))]) {
    if (!candidate) continue
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
}
const COMPUTE = findBinary('compute-configured', ['/opt/homebrew/bin/compute-configured', '/home/linuxbrew/.linuxbrew/bin/compute-configured', '/opt/homebrew-emulated/bin/compute-configured'])
const PAX = findBinary('pax', ['/opt/pax/pax', '/opt/homebrew/bin/pax'])
const installed = Boolean(COMPUTE && PAX)
const repositoryOf = (session: { execution?: { kind: string; repository?: string } }): string => session.execution?.repository ?? ''

describe('what Compute says about the platform', () => {
  it('reports Certified and Preview from Compute’s own evidence, and never from a run having worked', () => {
    // Real distribution evidence shipped with Compute Configured 0.1.5 for each platform.
    const linux = readStackEvidence(join(__dirname, 'fixtures/stack.linux-x86_64.json'))
    const mac = readStackEvidence(join(__dirname, 'fixtures/stack.macos-aarch64.json'))
    expect(platformView(linux, 'stack.json')).toMatchObject({ status: 'certified', label: 'Linux x86_64 — Certified' })
    expect(platformView(mac, 'stack.json')).toMatchObject({ status: 'preview', label: 'macOS ARM64 — Preview' })
    // A pass result, a missing status or a made-up one is not a certification.
    expect(platformView({ platform: 'linux-x86_64', status: 'pass' }, 'x').label).toBe('Linux x86_64 — Unverified')
    expect(platformView({ platform: 'macos-aarch64' }, 'x').label).toBe('macOS ARM64 — Unverified')
    expect(platformView({ platform: 'macos-aarch64', status: 'certified' }, 'x').label).toBe('macOS ARM64 — Certified') // only ever what Compute stated
  })
})

describe.skipIf(!installed)('Foundry coding sessions on Compute Configured', () => {
  const kit = new TestKit()
  const home = mkdtempSync(join(tmpdir(), 'foundry-compute-'))
  const stateDir = join(home, 'daemon')
  let port = 0
  let client: ComputeClient
  const env = (): NodeJS.ProcessEnv => ({ COMPUTE_HOME: home, COMPUTE_DAEMON: `http://127.0.0.1:${port}` })
  const cli = (args: string[], timeoutMs = 120_000) => runCommand([COMPUTE!, ...args], { cwd: home, env: env(), timeoutMs })
  let environments = 0

  const freePort = (): Promise<number> => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port: value } = server.address() as { port: number }; server.close(() => resolve(value)) }) })

  async function computer(name = `foundry-${++environments}-${Date.now() % 100000}`): Promise<string> {
    const created = await cli(['environment', 'create', name, '--cpu', '1', '--memory', '1Gi', '--persistent', '--json', '--daemon', env().COMPUTE_DAEMON!])
    expect(created.exitCode, created.stderr).toBe(0)
    await waitUntil(async () => (await client.computer(name)).observed === 'running', 60_000)
    return name
  }

  /** A real repository with a real package-lock, so PAX has evidence to select npm from. */
  function repository(extra: (path: string) => void = () => undefined): string {
    const path = kit.repository()
    writeFileSync(join(path, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }))
    extra(path)
    kit.git(path, 'add', '-A'); kit.git(path, 'commit', '-q', '-m', 'evidence')
    return path
  }

  beforeAll(async () => {
    port = await freePort()
    client = new ComputeClient({ binary: COMPUTE, pax: PAX, daemon: `http://127.0.0.1:${port}`, env: env() })
    const started = await cli(['start', '--insecure', '--detach', '--listen', `127.0.0.1:${port}`, '--state-dir', stateDir], 120_000)
    if (started.exitCode !== 0) throw new Error(`compute start failed: ${started.stderr}${started.stdout}`)
    await waitUntil(() => client.reachable(), 60_000)
    await waitUntil(async () => (await cli(['target', 'list', '--daemon', env().COMPUTE_DAEMON!])).stdout.includes('this-machine'), 60_000)
  }, 240_000)

  afterEach(() => kit.cleanup())
  afterAll(async () => {
    await cli(['down', '--listen', `127.0.0.1:${port}`], 60_000).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }, 90_000)

  const boot = (): Promise<Booted> => kit.boot(undefined, { compute: client, pax: PAX })
  const serveProcess = (): number | undefined => {
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').includes(`--job-store ${stateDir}/local/computers/jobs`)) return Number(pid) } catch { /* gone */ }
    }
  }
  const alive = (pid: number): boolean => { try { process.kill(pid, 0) } catch { return false }; try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true } }

  it('reports the installed platform from the packaged verification: Linux x86_64 is Certified', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return
    const platform = await client.platform()
    expect(platform.platform).toMatchObject({ platform: 'linux-x86_64', status: 'certified', label: 'Linux x86_64 — Certified', evidence: 'compute-configured-verify' })
    expect(platform.installation).toMatchObject({ configured: true, version: expect.stringMatching(/^\d+\.\d+\.\d+$/) })
    const inventory = await client.inventory()
    expect(inventory).toMatchObject({ available: true, daemon: { reachable: true } })
    expect(inventory.platform?.label).toBe('Linux x86_64 — Certified')
  }, 60_000)

  it('runs a real coding session on a real Computer: the agent, its cwd, its processes, PAX, its edit and its tests are all there', async () => {
    const environment = await computer()
    const path = repository()
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Compute fixture')
    const localBefore = readFileSync(join(path, 'src', 'math.js'), 'utf8')

    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment },
      task: taskText('Fix add() on the Computer, using PAX.', { action: 'compute-work', pax: PAX, hold: 8 }) })
    expect(started.execution).toMatchObject({ kind: 'compute', environment, repository: expect.stringMatching(/^foundry-compute-fixture-/) })
    expect(started.events[0]).toMatchObject({ label: 'Agent started on Compute' })

    // While the agent runs, Compute's own report shows the process, on the Computer, in the project's checkout.
    let remotePid = 0
    let name = ''
    await waitUntil(async () => {
      const current = await client.computer(environment)
      const running = Object.entries(current.processes).find(([process_, state]) => process_.startsWith('foundry-') && state.state === 'running' && state.pid)
      if (running) { name = running[0]; remotePid = running[1].pid! }
      return remotePid > 0
    }, 60_000)
    const workspace = (await client.exec(environment, ['pwd'])).stdout.trim()
    expect(workspace).toContain('/computers/sessions/workspaces/')
    const remoteCwd = realpathSync(readlinkSync(`/proc/${remotePid}/cwd`))
    expect(remoteCwd).toBe(realpathSync(join(workspace, 'repos', repositoryOf(started))))
    expect(remoteCwd).not.toBe(realpathSync(path))
    // Compute's own API and UI show the same executing Computer and process.
    const api = await (await fetch(`${client.daemon}/environments/${environment}/computer`)).json() as { observed?: { processes?: Record<string, { state?: string }> } }
    expect(api.observed?.processes?.[name]?.state).toBe('running')
    expect((await fetch(`${client.daemon}/ui/`)).status).toBe(200)
    // No local fallback: nothing was started here as an agent.
    expect((await booted.desktop.repository.processLedger().all()).filter(row => row.role === 'agent')).toEqual([])

    const session = (await booted.coding.settled(started.id))!
    expect(session.error).toBeUndefined()
    expect(session.status).toBe('succeeded')
    const evidence = JSON.parse(/EVIDENCE (.*)/.exec(session.result ?? '')![1]) as { cwd: string; pid: number; ppid: number; hostname: string; node: string; pax: { infoExit: number; manager: { name: string }; testBefore: number; testAfter: number }; gitStatus: string }
    expect(realpathSync(evidence.cwd)).toBe(remoteCwd)
    // The process Compute reports is the agent's parent (Compute starts a command through its shell runtime): the agent ran under it, on the Computer.
    expect(evidence.ppid).toBe(remotePid)
    expect(evidence.pid).not.toBe(process.pid)
    expect(evidence.node).toMatch(/^v\d+/)
    expect(evidence.pax).toMatchObject({ infoExit: 0, manager: { name: 'npm' }, testBefore: 1, testAfter: 0 })
    expect(evidence.gitStatus).toContain(' M src/math.js')

    // Foundry observes the change on the Computer, with its existing dirty-repository accounting…
    expect(session.changes).toEqual([expect.objectContaining({ path: 'src/math.js', code: ' M', origin: 'session' })])
    expect((await booted.coding.gitStatus(project.id, session.id)).changes.map(change => change.path)).toEqual(['src/math.js'])
    expect((await booted.coding.gitDiff(project.id, 'src/math.js', session.id)).diff).toContain('+  return a + b')
    // …and the repository here is untouched: the work happened there.
    expect(readFileSync(join(path, 'src', 'math.js'), 'utf8')).toBe(localBefore)
    expect((await booted.coding.gitStatus(project.id)).changes).toEqual([])
    // The checkout on the Computer is where the file changed.
    expect(readFileSync(join(workspace, 'repos', repositoryOf(session), 'src', 'math.js'), 'utf8')).toContain('return a + b')
    // Foundry stored a reference to the Computer and no copy of its state or of the source.
    const stored = JSON.stringify(await booted.desktop.repository.codingSession(session.id))
    expect(stored).toContain(environment)
    expect(stored).not.toContain('return a + b')
    expect(Object.keys(session.execution!).sort()).toEqual(['environment', 'environmentId', 'kind', 'repository'])
  }, 180_000)

  it('asks PAX and shows what PAX says: an ambiguous project stays ambiguous and a delegated operation fails closed', async () => {
    const environment = await computer()
    const path = repository(dir => { writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n') })
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Ambiguous')
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Look.', { action: 'none' }) })).id))!
    expect(session.status).toBe('succeeded')

    const drift = await booted.coding.pax(session.id, 'drift')
    expect(drift.findings.ambiguous).toBe(true)
    const issues = (drift.json as { issues: { status: string; expected: string; actual: string }[] }).issues
    expect(issues.find(issue => issue.status === 'ambiguous')).toMatchObject({ expected: 'one JavaScript package-manager authority', actual: 'pnpm-lock.yaml, package-lock.json' })
    // Foundry does not choose a tool: PAX's delegated operation refuses, and that refusal is what Foundry reports.
    const test = await booted.coding.pax(session.id, 'test', { dryRun: true })
    expect(test.exitCode).not.toBe(0)
    expect(test.findings.failedClosed).toBe(true)
    expect(`${test.stderr}${test.stdout}`).toMatch(/multiple JavaScript package managers detected/)
    // `info` is passed through as PAX wrote it — including how PAX itself says it picked.
    const info = await booted.coding.pax(session.id, 'info')
    expect((info.json as { manager: { selectedBy: string } }).manager.selectedBy).toBe('lockfile precedence')
    // Nothing was repaired or installed by asking.
    expect((await booted.coding.gitStatus(project.id, session.id)).changes).toEqual([])
  }, 180_000)

  it('shows drift between what is declared, resolved and installed, without repairing it', async () => {
    const environment = await computer()
    const path = repository(dir => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test.js' }, dependencies: { 'left-pad': '1.3.0' } }))
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }, 'node_modules/left-pad': { version: '1.3.0' } } }))
    })
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Drift')
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Look.', { action: 'none' }) })).id))!
    const drift = await booted.coding.pax(session.id, 'drift')
    expect(drift.exitCode).toBe(1)
    expect(drift.findings).toMatchObject({ drift: true })
    // PAX's own words for the disagreement: dependencies are declared and resolved, and are not installed.
    expect((drift.json as { issues: { status: string; expected: string; actual: string; evidence: { kind: string }[] }[] }).issues).toEqual([expect.objectContaining({ status: 'drift', expected: 'installed dependencies', actual: 'node_modules/ absent', evidence: [expect.objectContaining({ kind: 'declared' }), expect.objectContaining({ kind: 'installed' })] })])
    const after = await booted.coding.pax(session.id, 'drift')
    expect(after.exitCode).toBe(1) // still drifting: nothing repaired it
    expect((await booted.coding.gitStatus(project.id, session.id)).changes).toEqual([])
  }, 180_000)

  it('keeps a requirement the platform cannot meet explicit: Compute names it and nothing is substituted', async () => {
    const path = repository(dir => { writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js', test: 'node test.js' } })); writeFileSync(join(dir, 'index.js'), "console.log('hi')\n") })
    const plan = await client.placement(path, { platform: 'linux-riscv64' })
    expect(plan.outcome).toBe('placement_failed')
    expect(plan.providers.length).toBeGreaterThan(0)
    for (const provider of plan.providers) {
      expect(provider.eligible).toBe(false)
      expect(provider.reasons).toContainEqual(expect.objectContaining({ code: 'architecture_mismatch', required: 'riscv64' }))
    }
  }, 60_000)

  it('records a delegated command that fails as a failed session — Compute reports the exit, and nothing pretends it succeeded', async () => {
    const environment = await computer()
    const path = repository()
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Failing')
    const seen: { exitCode?: number | null; state: string }[] = []
    const original = client.computer.bind(client)
    client.computer = async (...args) => { const value = await original(...args); for (const state of Object.values(value.processes)) seen.push(state); return value }
    try {
      const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Fail.', { action: 'exit-code', code: 3 }) })).id))!
      expect(session.status).toBe('failed')
      expect(session.error).toMatch(/3/)
      expect(session.result).toBeUndefined()
      expect((await booted.desktop.repository.codingSession(session.id))!.events.map(event => event.label)).toEqual(['Agent started on Compute', 'No files changed during this session', 'Failed'])
      expect(seen.some(state => state.exitCode === 3)).toBe(true) // Compute's own report of the process failure
      expect((await booted.desktop.repository.runs()).find(run => run.id === session.runId)?.status).toBe('failed')
    } finally { client.computer = original }
  }, 120_000)

  it('cancels a running agent: the process on the Computer is stopped through Compute, and the session says cancelled', async () => {
    const environment = await computer()
    const path = repository()
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Cancel')
    const pids = kit.pidfile()
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Keep editing.', { action: 'mutate-forever', pidfile: pids, target: 'growing.log' }) })
    await waitUntil(() => pidsReady(pids), 60_000)
    const pid = Number(readFileSync(pids, 'utf8').split('\n')[0])
    expect(alive(pid)).toBe(true)
    await booted.coding.cancel(started.id)
    const session = (await booted.coding.settled(started.id))!
    expect(session.status).toBe('cancelled')
    await waitUntil(() => !alive(pid), 30_000)
    // Compute no longer reports it running, and the file it was writing stops growing.
    await waitUntil(async () => !Object.values((await client.computer(environment)).processes).some(item => item.state === 'running'), 30_000)
    const log = join((await client.exec(environment, ['pwd'])).stdout.trim(), 'repos', repositoryOf(session), 'growing.log')
    const size = readFileSync(log, 'utf8').length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(readFileSync(log, 'utf8').length).toBe(size)
  }, 120_000)

  it('reaches the same Computer through AppPort: the client starts a Compute session, reads its execution and asks PAX, with no new route', async () => {
    const environment = await computer()
    const path = repository(dir => { writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n') })
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Through AppPort')
    const api = new CodingApi(booted.desktop.repository, booted.coding, (id, allow) => booted.runtime.resolveAgentPermission(id, allow), client)
    const services = openDesktopServices(booted.desktop.databaseDirectory)
    const { secret } = await ensureClientApiKey(services, booted.root)
    const app = createFoundryAppPort(api, apiKeyAuthenticator(services))
    const identity = await app.server.identify({ transport: 'inprocess', headers: { authorization: `Bearer ${secret}` } })
    const remote = createClient({ transport: createInProcessTransport({ server: app.server, identity }) })
    await remote.connect()
    try {
      const inventory = await remote.call<{ available: boolean; environments: { name: string }[]; platform?: { label: string } }>('douchat.coding.compute.inventory', {})
      expect(inventory.available).toBe(true)
      expect(inventory.environments.map(item => item.name)).toContain(environment)
      const started = await remote.call<{ id: string; execution?: { kind: string; environment: string } }>('douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Look.', { action: 'none' }) })
      expect(started.execution).toMatchObject({ kind: 'compute', environment })
      await booted.coding.settled(started.id)
      const view = await remote.call<{ status: string; execution?: { environment: string } }>('douchat.coding.sessions.get', { id: started.id })
      expect(view).toMatchObject({ status: 'succeeded', execution: { environment } })
      const drift = await remote.call<{ findings: { ambiguous: boolean } }>('douchat.coding.sessions.pax', { id: started.id, command: 'drift' })
      expect(drift.findings.ambiguous).toBe(true)
      // Only read-only inspections are reachable: a delegated operation is not a capability.
      await expect(remote.call('douchat.coding.sessions.pax', { id: started.id, command: 'test' })).rejects.toBeDefined()
    } finally { await remote.close(); app.close(); await services.apiKeys.close() }
  }, 180_000)

  it('reports the execution interrupted when the Computer stops answering, not the task completed (run last)', async () => {
    const environment = await computer()
    const path = repository()
    const booted = await boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Disconnect')
    const pids = kit.pidfile()
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, execution: { kind: 'compute', environment }, task: taskText('Keep editing.', { action: 'mutate-forever', pidfile: pids, target: 'growing.log' }) })
    await waitUntil(() => pidsReady(pids), 60_000)
    const pid = Number(readFileSync(pids, 'utf8').split('\n')[0])
    const host = serveProcess()
    expect(host).toBeGreaterThan(0)
    // The Computer's host stops answering (its target is unreachable to Compute); the agent's process is not touched by Foundry.
    process.kill(host!, 'SIGSTOP')
    try {
      const session = (await booted.coding.settled(started.id))!
      expect(session.status).toBe('interrupted')
      expect(session.error).toMatch(/interrupted|unreachable|stopped answering/i)
      expect(session.result).toBeUndefined()
      const events = (await booted.desktop.repository.codingSession(session.id))!.events
      expect(events.at(-1)).toMatchObject({ kind: 'interrupted' })
      expect(events.map(event => event.label)).not.toContain('Agent finished')
    } finally {
      process.kill(host!, 'SIGCONT')
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  }, 240_000)
})
