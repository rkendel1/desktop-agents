import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { runCommand } from '../coding/commands'
import { waitUntil } from '../coding/testkit'
import { ComputeClient } from '../compute/client'

/**
 * Two implementations of the same Compute environment contract, for one suite.
 *
 *  • `FixtureCompute` — `fixtures/compute-contract.cjs`, a `compute` command over a state file whose JSON is derived from recordings of
 *    real Compute main. It reaches the states a real host cannot be made to reach on demand (failed bootstrap, an unsatisfied target,
 *    a lost machine, a daemon that stops answering).
 *  • `ComputeMain` — the real `compute` built from the Compute repository's main: a real daemon, real recipes, a real Computer.
 *    Nothing of Compute is mocked; only the shell runtime's *artifact source* is the host's /bin/sh (Compute's own documented
 *    `COMPUTE_RUNTIME_CATALOG` mechanism), so no download is needed. Absent a build, its suite is skipped and reported so.
 */
export interface ComputeBackend {
  readonly name: 'fixture' | 'compute-main'
  readonly client: ComputeClient
  start(): Promise<void>
  stop(): Promise<void>
  /** A recipe that any target can host. */
  defineRecipe(name: string, spec?: Record<string, unknown>): Promise<void>
  /** A recipe that no target here can host. */
  defineUnsatisfiableRecipe(name: string): Promise<void>
  /** Let Compute bring newly created environments to ready: a real daemon does it by itself; the fixture is stepped. */
  bring(environment: string, until?: string): Promise<void>
  daemon(up: boolean): Promise<void>
}

export function findComputeMain(): string | undefined {
  for (const candidate of [process.env.FOUNDRY_COMPUTE_MAIN, process.env.COMPUTE_MAIN_REPO && join(process.env.COMPUTE_MAIN_REPO, 'target/debug/compute'), process.env.COMPUTE_MAIN_REPO && join(process.env.COMPUTE_MAIN_REPO, 'target/release/compute'),
    join(__dirname, '../../../../rkendel1/compute/target/debug/compute'), '/home/user/rkendel1/compute/target/debug/compute']) {
    if (!candidate) continue
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
}

const freePort = (): Promise<number> => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) }) })

export class FixtureCompute implements ComputeBackend {
  readonly name = 'fixture' as const
  readonly home = mkdtempSync(join(tmpdir(), 'foundry-fixture-'))
  readonly script = join(this.home, 'compute')
  readonly state = join(this.home, 'state.json')
  readonly client: ComputeClient
  private readonly env: NodeJS.ProcessEnv

  constructor(options: { legacy?: boolean; auto?: boolean; extra?: NodeJS.ProcessEnv } = {}) {
    // The script's shebang names this node, so it runs wherever the tests do.
    const source = readFileSync(join(__dirname, 'fixtures', 'compute-contract.cjs'), 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
    writeFileSync(this.script, source.replace("path.join(__dirname, 'compute-main', name)", `path.join(${JSON.stringify(join(__dirname, 'fixtures'))}, 'compute-main', name)`)); chmodSync(this.script, 0o755)
    this.env = { FIXTURE_STATE: this.state, ...(options.legacy ? { FIXTURE_LEGACY: '1' } : {}), ...(options.auto ? { FIXTURE_AUTO: '1' } : {}), ...options.extra }
    this.client = new ComputeClient({ binary: this.script, daemon: 'http://127.0.0.1:8787', env: this.env })
  }

  private hand = (...args: string[]) => runCommand([this.script, '__fixture', ...args], { cwd: this.home, env: this.env, timeoutMs: 15_000 })
  async start(): Promise<void> { /* nothing to start */ }
  async stop(): Promise<void> { rmSync(this.home, { recursive: true, force: true }) }
  async defineRecipe(name: string, spec: Record<string, unknown> = { lifecycle: 'persistent', requirements: {} }): Promise<void> { await this.hand('recipe', name, JSON.stringify(spec)) }
  async defineUnsatisfiableRecipe(name: string): Promise<void> { await this.hand('recipe', name, JSON.stringify({ lifecycle: 'persistent', requirements: { capabilities: ['terminal'] }, __unsatisfiable: true })) }
  async bring(environment: string, until = 'ready'): Promise<void> { for (let step = 0; step < 4; step++) await this.hand('advance', environment); if (until !== 'ready') await this.hand('phase', environment, until) }
  async daemon(up: boolean): Promise<void> { await this.hand('daemon', up ? 'up' : 'down') }
  /** Put an environment into a phase Compute could report (see the phases in compute-contract.cjs). */
  phase = (environment: string, phase: string) => this.hand('phase', environment, phase)
  set = (environment: string, patch: object) => this.hand('set', environment, JSON.stringify(patch))
  calls = async (): Promise<string[]> => (await this.hand('calls')).stdout.split('\n').filter(Boolean)
}

export class ComputeMain implements ComputeBackend {
  readonly name = 'compute-main' as const
  readonly binary = findComputeMain()
  readonly home = mkdtempSync(join(tmpdir(), 'foundry-compute-main-'))
  port = 0
  client!: ComputeClient
  private env: NodeJS.ProcessEnv = {}

  get installed(): boolean { return Boolean(this.binary && existsSync(this.lock)) }
  /** The runtime lock of the Compute checkout the binary was built from: the catalog is written from it. */
  private get lock(): string { return join(dirname(dirname(dirname(this.binary ?? '/nowhere'))), 'distribution', 'runtime-lock.json') }
  get daemonUrl(): string { return `http://127.0.0.1:${this.port}` }
  cli = (args: string[], timeoutMs = 120_000) => runCommand([this.binary!, ...args], { cwd: this.home, env: this.env, timeoutMs })

  /** Compute's own fixture-catalog mechanism: the shell runtime is the host's /bin/sh. Compute still acquires, verifies, prepares and runs it as it does any runtime. */
  private writeCatalog(): string {
    const lock = JSON.parse(readFileSync(this.lock, 'utf8')) as { runtimes: Record<string, { version: string; executable: string }> }
    const shell = lock.runtimes.shell!
    const script = `#!/bin/sh\ncase "$1" in --version|--help) echo "BusyBox v${shell.version}"; exit 0;; esac\nexec /bin/sh "$@"\n`
    const artifact = join(this.home, 'shell-fixture')
    writeFileSync(artifact, script); chmodSync(artifact, 0o755)
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const catalog = join(this.home, 'runtime-catalog.json')
    writeFileSync(catalog, JSON.stringify({ schema_version: 2, runtimes: { wasm: lock.runtimes.wasm, native: lock.runtimes.native, shell: { version: shell.version, executable: shell.executable,
      artifacts: { [`${process.platform === 'darwin' ? 'macos' : 'linux'}-${arch}`]: { url: `file://${artifact}`, sha256: createHash('sha256').update(script).digest('hex'), format: 'file', install: [{ source: 'artifact', destination: shell.executable }] } } } } }))
    return catalog
  }

  async start(): Promise<void> {
    this.port = this.port || await freePort()
    mkdirSync(join(this.home, 'store'), { recursive: true })
    this.env = { COMPUTE_HOME: this.home, COMPUTE_DAEMON: this.daemonUrl, COMPUTE_NO_BROWSER: '1', COMPUTE_RUNTIME_CATALOG: this.writeCatalog(), COMPUTE_RUNTIME_STORE: join(this.home, 'store') }
    this.client = new ComputeClient({ binary: this.binary, daemon: this.daemonUrl, env: this.env })
    await this.up()
  }

  private async up(): Promise<void> {
    const started = await this.cli(['start', '--insecure', '--detach', '--listen', `127.0.0.1:${this.port}`, '--state-dir', join(this.home, 'daemon')])
    if (started.exitCode !== 0) throw new Error(`compute start failed: ${started.stderr}${started.stdout}`)
    await waitUntil(() => this.client.reachable(), 60_000)
    await waitUntil(async () => (await this.cli(['target', 'list', '--daemon', this.daemonUrl])).stdout.includes('this-machine'), 60_000)
  }

  async stop(): Promise<void> {
    await this.cli(['down', '--listen', `127.0.0.1:${this.port}`], 60_000).catch(() => undefined)
    rmSync(this.home, { recursive: true, force: true })
  }

  private async recipe(name: string, spec: object): Promise<void> {
    const file = join(this.home, `recipe-${name}.json`)
    writeFileSync(file, JSON.stringify(spec))
    const created = await this.cli(['recipe', 'create', name, '--file', file, '--json', '--daemon', this.daemonUrl])
    if (created.exitCode !== 0) throw new Error(`recipe create failed: ${created.stderr}${created.stdout}`)
  }
  defineRecipe(name: string, spec: Record<string, unknown> = { description: 'A developer computer kept until destroyed.', lifecycle: 'persistent', requirements: {} }): Promise<void> { return this.recipe(name, spec) }
  /** The stock `dev` recipe asks for `terminal`, which the this-machine target does not offer. */
  defineUnsatisfiableRecipe(name: string): Promise<void> { return this.recipe(name, { lifecycle: 'persistent', requirements: { capabilities: ['terminal'] } }) }
  async bring(): Promise<void> { /* Compute brings it to ready by itself */ }
  async daemon(up: boolean): Promise<void> {
    if (up) await this.up()
    else await this.cli(['down', '--listen', `127.0.0.1:${this.port}`], 60_000)
  }
}
