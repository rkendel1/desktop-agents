import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CommandResult, ComputeInventory, ComputePlatformView } from '../../shared/types'
import { runCommand } from '../coding/commands'
import { spawnEnvironment } from '../shellPath'

/**
 * Foundry's boundary to Compute is Compute's own: the installed `compute-configured` command and the environment API it speaks to
 * (the daemon at `compute start`). Every call below is one documented Compute CLI invocation, run through the same no-shell
 * command runner Foundry uses for everything else. Nothing here is a Foundry-specific Compute protocol, and nothing
 * Compute owns — Computers, environments, processes, their lifecycle and state — is kept or cached on Foundry's side.
 */
export const DEFAULT_DAEMON = 'http://127.0.0.1:8787'

export class ComputeError extends Error {
  constructor(readonly code: 'not-installed' | 'daemon-unreachable' | 'not-found' | 'failed' | 'unparseable', message: string, readonly detail?: string) {
    super(message)
    this.name = 'ComputeError'
  }
}

export interface ComputeClientOptions {
  /** The `compute-configured` executable. Default: `$FOUNDRY_COMPUTE`, then `compute-configured` on PATH or in the usual Homebrew prefixes. */
  binary?: string
  /** The Compute API endpoint. Default: `$COMPUTE_DAEMON`, then http://127.0.0.1:8787. */
  daemon?: string
  /** Extra environment for the CLI (e.g. `COMPUTE_HOME`). */
  env?: NodeJS.ProcessEnv
  /** The `pax` executable Compute discovers projects with (`COMPUTE_PAX`). Default: `$FOUNDRY_PAX`, else Compute's own lookup on PATH. */
  pax?: string
}

const HOMEBREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']

function findExecutable(name: string, path: string | undefined): string | undefined {
  for (const directory of [...(path ?? '').split(delimiter), ...HOMEBREW_BINS]) {
    if (!directory) continue
    const candidate = join(directory, name)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
}

const PLATFORM_NAMES: Record<string, string> = { 'linux-x86_64': 'Linux x86_64', 'macos-aarch64': 'macOS ARM64' }

/** What Compute says about a distribution — `certified` and `preview` are Compute's words, and anything else is not called either. */
export function platformView(evidence: { platform?: unknown; status?: unknown; compute?: unknown }, source: string): ComputePlatformView {
  const platform = typeof evidence.platform === 'string' ? evidence.platform : 'unknown'
  const status = evidence.status === 'certified' || evidence.status === 'preview' ? evidence.status : 'unverified'
  const name = PLATFORM_NAMES[platform] ?? platform
  return { platform, status, label: `${name} — ${status === 'certified' ? 'Certified' : status === 'preview' ? 'Preview' : 'Unverified'}`,
    ...(typeof evidence.compute === 'string' ? { computeVersion: evidence.compute } : {}), evidence: source }
}

export interface ComputeProcessState {
  state: string
  pid?: number
  exitCode?: number | null
  reason?: string
  message?: string
}

export interface ComputeComputer {
  environment: string
  environmentId: string
  status: string
  observed: string
  explanation?: string
  target?: string
  sessionId?: string
  machine?: string
  repositories: Record<string, { revision: string; commit?: string }>
  processes: Record<string, ComputeProcessState>
  raw: Record<string, unknown>
}

export class ComputeClient {
  readonly daemon: string
  private located?: { binary: string; sibling: (name: string) => string | undefined }

  constructor(private readonly options: ComputeClientOptions = {}) {
    this.daemon = options.daemon ?? process.env.COMPUTE_DAEMON ?? DEFAULT_DAEMON
  }

  private async locate(): Promise<{ binary: string; sibling: (name: string) => string | undefined }> {
    if (this.located) return this.located
    const environment = await spawnEnvironment()
    const binary = this.options.binary ?? process.env.FOUNDRY_COMPUTE ?? findExecutable('compute-configured', environment.PATH)
    if (!binary) throw new ComputeError('not-installed', 'Compute Configured is not installed. Install it with `brew install compute-configured`, then run `compute-configured-verify`.')
    const directory = dirname(binary)
    this.located = { binary, sibling: name => findExecutable(name, directory) }
    return this.located
  }

  /** One Compute CLI call. Compute's own `--json` output is parsed by the callers; nothing is interpreted here. */
  async cli(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; binary?: string } = {}): Promise<CommandResult> {
    const { binary } = await this.locate()
    const pax = this.options.pax ?? process.env.FOUNDRY_PAX
    const env = { ...(pax ? { COMPUTE_PAX: pax } : {}), ...this.options.env }
    try {
      return await runCommand([options.binary ?? binary, ...args], { cwd: tmpdir(), signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000, env, maxOutput: 4 * 1024 * 1024 })
    } catch (error) {
      throw new ComputeError('failed', `Compute could not be run: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async json<T>(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; binary?: string } = {}): Promise<T> {
    const result = await this.cli(args, options)
    if (result.exitCode !== 0) throw this.failure(args, result)
    try { return JSON.parse(result.stdout) as T } catch { throw new ComputeError('unparseable', `Compute answered \`${args.slice(0, 3).join(' ')}\` with something that is not JSON.`, result.stdout.slice(0, 500)) }
  }

  private failure(args: string[], result: CommandResult): ComputeError {
    const text = `${result.stderr}${result.stdout}`.trim()
    if (/cannot reach the Compute daemon|daemon did not answer|Connection refused/i.test(text)) {
      return new ComputeError('daemon-unreachable', `The Compute daemon is not answering at ${this.daemon}. Start it with \`compute start\`.`, text)
    }
    if (/not found|no such environment/i.test(text)) return new ComputeError('not-found', text.split('\n')[0] || 'Not found', text)
    return new ComputeError('failed', text.split('\n')[0] || `compute ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode ?? result.signal})`, text)
  }

  private daemonArgs = (): string[] => ['--daemon', this.daemon]

  // ─────────────── the installed product ───────────────

  /** What Compute Configured says about itself: version, and its packaged verification — the source of "Certified" / "Preview". */
  async platform(): Promise<{ installation: { binary: string; version: string; configured: boolean }; platform: ComputePlatformView }> {
    const { binary, sibling } = await this.locate()
    const version = (await this.cli(['--version'])).stdout.trim().replace(/^compute\s+/, '')
    const verify = sibling('compute-configured-verify')
    if (!verify) throw new ComputeError('not-installed', '`compute-configured-verify` was not found next to compute-configured; the configured product is incomplete.')
    // The packaged verification prints its evidence as JSON: {result, status, platform, compute, …}.
    const result = await runCommand([verify], { cwd: tmpdir(), timeoutMs: 60_000, env: { ...this.options.env }, maxOutput: 1024 * 1024 })
    let evidence: { result?: string; status?: string; platform?: string; compute?: string } = {}
    try { evidence = JSON.parse(result.stdout) } catch { /* reported as unverified below */ }
    const verified = result.exitCode === 0 && evidence.result === 'pass'
    return { installation: { binary, version, configured: true }, platform: platformView(verified ? evidence : { platform: evidence.platform }, 'compute-configured-verify') }
  }

  /** The daemon answers `compute status`. */
  async reachable(): Promise<boolean> {
    try { const result = await this.cli(['status', ...this.daemonArgs()], { timeoutMs: 15_000 }); return result.exitCode === 0 } catch { return false }
  }

  /** Everything the UI needs to offer Compute as a target — read from Compute, not kept. */
  async inventory(): Promise<ComputeInventory> {
    const base: ComputeInventory = { available: false, daemon: { endpoint: this.daemon, reachable: false }, environments: [], uiUrl: `${this.daemon.replace(/\/$/, '')}/ui/` }
    let platform: Awaited<ReturnType<ComputeClient['platform']>>
    try { platform = await this.platform() } catch (error) { return { ...base, reason: error instanceof Error ? error.message : String(error) } }
    const withProduct: ComputeInventory = { ...base, installation: platform.installation, platform: platform.platform }
    try {
      const environments = await this.json<{ name: string; environment_id: string; computer?: string; reality?: { observed?: string; explanation?: string } }[]>(['environment', 'list', '--json', ...this.daemonArgs()])
      return { ...withProduct, available: true, daemon: { endpoint: this.daemon, reachable: true },
        environments: environments.map(item => ({ name: item.name, environmentId: item.environment_id, observed: item.reality?.observed ?? item.computer ?? 'unknown', ...(item.reality?.explanation ? { explanation: item.reality.explanation } : {}) })) }
    } catch (error) {
      return { ...withProduct, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Compute's own placement of a PAX project: whether any provider can satisfy what the project requires, with the reason each cannot.
   * The answer is Compute's — a target that lacks the platform or runtime is reported as lacking it, and nothing is substituted.
   */
  async placement(projectDirectory: string, options: { platform?: string; command?: string } = {}): Promise<{ outcome: string; providers: { id: string; eligible: boolean; reasons: { code: string; required?: unknown; available?: unknown; detail?: string }[] }[] }> {
    // `placement inspect` exits non-zero when nothing can be placed — and still prints the full report, which is the answer.
    const result = await this.cli(['placement', 'inspect', '--project', projectDirectory, ...(options.platform ? ['--platform', options.platform] : []), ...(options.command ? ['--command', options.command] : []), '--json'], { timeoutMs: 60_000 })
    let raw: { outcome: string; providers?: { provider_id: string; candidate?: { eligible?: boolean }; reasons?: { code: string; required?: unknown; available?: unknown; detail?: string }[] }[] }
    try { raw = JSON.parse(result.stdout) } catch { throw this.failure(['placement', 'inspect'], result) }
    return { outcome: raw.outcome, providers: (raw.providers ?? []).map(provider => ({ id: provider.provider_id, eligible: provider.candidate?.eligible === true, reasons: provider.reasons ?? [] })) }
  }

  // ─────────────── computers ───────────────

  async computer(environment: string, signal?: AbortSignal): Promise<ComputeComputer> {
    const raw = await this.json<Record<string, any>>(['environment', 'computer', environment, '--json', ...this.daemonArgs()], { signal, timeoutMs: 30_000 })
    const observed = raw.observed ?? {}
    const processes: Record<string, ComputeProcessState> = {}
    for (const [name, value] of Object.entries<any>(observed.processes ?? {})) {
      processes[name] = { state: value.state, ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
        ...(value.last_failure ? { exitCode: value.last_failure.exit_code ?? null, reason: value.last_failure.reason, message: value.last_failure.message } : {}) }
    }
    const repositories: ComputeComputer['repositories'] = {}
    for (const [name, value] of Object.entries<any>(observed.repositories ?? {})) repositories[name] = { revision: value.revision, ...(value.commit ? { commit: value.commit } : {}) }
    return { environment: raw.environment, environmentId: raw.environment_id, status: raw.status, observed: raw.reality?.observed ?? raw.status,
      ...(raw.reality?.explanation ? { explanation: raw.reality.explanation } : {}), ...(raw.target ? { target: raw.target } : {}), ...(raw.session_id ? { sessionId: raw.session_id } : {}),
      ...(raw.machine ? { machine: typeof raw.machine === 'string' ? raw.machine : raw.machine.id ?? JSON.stringify(raw.machine) } : {}), repositories, processes, raw }
  }

  /** The process is running for a live pid read from Compute's process report (`environment computer`). */
  async processState(environment: string, name: string): Promise<ComputeProcessState | undefined> {
    return (await this.computer(environment)).processes[name]
  }

  // ─────────────── ephemeral Computers ───────────────

  /**
   * A temporary Computer: `compute environment create --ephemeral --ttl`. Compute expires it on its own if nobody releases it, which is the
   * backstop for a Foundry that died. Waits until Compute observes it running.
   */
  async acquireEphemeral(name: string, options: { cpu?: number; memory?: string; ttlSeconds: number; signal?: AbortSignal; timeoutMs?: number }): Promise<ComputeComputer> {
    await this.json(['environment', 'create', name, '--cpu', String(options.cpu ?? 1), '--memory', options.memory ?? '1Gi', '--ephemeral', '--ttl', `${Math.ceil(options.ttlSeconds / 60)}m`, '--json', ...this.daemonArgs()], { timeoutMs: 120_000 })
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    for (;;) {
      options.signal?.throwIfAborted()
      const computer = await this.computer(name)
      if (computer.observed === 'running') return computer
      if (['destroyed', 'lost', 'failed'].includes(computer.observed)) throw new ComputeError('failed', `Compute could not start the Computer "${name}": it is ${computer.observed}${computer.explanation ? ` (${computer.explanation})` : ''}.`)
      if (Date.now() > deadline) throw new ComputeError('failed', `The Computer "${name}" was not running ${Math.round((options.timeoutMs ?? 120_000) / 1000)} seconds after it was requested (it is ${computer.observed}).`)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  /**
   * Release a Computer: `compute environment destroy`, which stops everything on it and destroys the machine (Compute keeps the record as
   * evidence). Idempotent — an environment that is not there is already released. The answer is what Compute *observes* afterwards.
   */
  async release(name: string, timeoutMs = 60_000): Promise<{ released: boolean; observed: string; note?: string }> {
    // `environment destroy` on the this-machine target removes the Computer's workspace but leaves the processes running on the host (measured
    // against Compute Configured 0.1.5). Release is therefore stop-then-destroy, both Compute's own verbs: every process Compute reports
    // running on the Computer is stopped through Compute first, so nothing outlives the machine it belonged to.
    try {
      const running = Object.entries((await this.computer(name)).processes).filter(([, state]) => state.state === 'running').map(([process_]) => process_)
      for (const process_ of running) await this.stopProcess(name, process_).catch(() => undefined)
      const deadline = Date.now() + 20_000
      while (running.length && Date.now() < deadline && Object.values((await this.computer(name)).processes).some(state => state.state === 'running')) await new Promise(resolve => setTimeout(resolve, 300))
    } catch { /* the Computer may already be gone or unreachable; destroy below reports what is true */ }
    const result = await this.cli(['environment', 'destroy', name, '--json', ...this.daemonArgs()], { timeoutMs: 120_000 })
    if (result.exitCode !== 0) {
      const failure = this.failure(['environment', 'destroy'], result)
      if (failure.code === 'not-found') return { released: true, observed: 'absent', note: 'Compute has no such environment.' }
      return { released: false, observed: 'unknown', note: failure.message }
    }
    // Destroying is asynchronous in Compute (the Computer is `reconciling` first), so "released" is what Compute observes, waited for.
    const deadline = Date.now() + timeoutMs
    let observed = 'unknown'
    for (;;) {
      try { observed = (await this.computer(name)).observed } catch (error) {
        if (error instanceof ComputeError && error.code === 'not-found') return { released: true, observed: 'absent' }
        return { released: false, observed: 'unknown', note: error instanceof Error ? error.message : String(error) }
      }
      if (observed === 'destroyed') return { released: true, observed }
      if (Date.now() > deadline) return { released: false, observed, note: `Compute still reports the Computer as ${observed} ${Math.round(timeoutMs / 1000)} seconds after it was released.` }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  // ─────────────── repositories ───────────────

  async addRepository(environment: string, name: string, url: string, revision: string): Promise<void> {
    await this.json(['environment', 'repo', 'add', environment, name, '--url', url, '--revision', revision, '--json', ...this.daemonArgs()])
  }

  // ─────────────── work ───────────────

  /** A command in the Computer as a durable job, waited for. cwd is the Computer's workspace root, or the checkout of `repository`. */
  async exec(environment: string, argv: string[], options: { repository?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<CommandResult> {
    const wrapped = options.repository ? ['sh', '-c', 'cd "repos/$0" && exec "$@"', options.repository, ...argv] : argv
    const flags = ['--json', ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...(options.timeoutMs ? ['--timeout', `${Math.ceil(options.timeoutMs / 1000)}s`] : [])]
    const started = Date.now()
    const result = await this.cli(['environment', 'exec', environment, ...flags, ...this.daemonArgs(), '--', ...wrapped], { signal: options.signal, timeoutMs: (options.timeoutMs ?? 300_000) + 30_000 })
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith('{')) throw this.failure(['environment', 'exec'], result)
    let parsed: { status?: string; result?: { exit_code?: number | null; stdout?: { text?: string }; stderr?: { text?: string }; status?: string; error?: { message?: string } | string | null } }
    try { parsed = JSON.parse(result.stdout) } catch { throw new ComputeError('unparseable', 'Compute answered `environment exec` with something that is not JSON.', result.stdout.slice(0, 500)) }
    const outcome = parsed.result ?? {}
    return { argv, exitCode: outcome.exit_code ?? null, ...(outcome.status && outcome.status !== 'completed' ? { signal: outcome.status } : {}), startedAt: started, durationMs: Date.now() - started,
      stdout: outcome.stdout?.text ?? '', stderr: outcome.stderr?.text ?? (typeof outcome.error === 'string' ? outcome.error : outcome.error?.message ?? '') }
  }

  /** Start an agent process in the Computer (Compute's own `environment agent add`), inside a repository's checkout. */
  async startAgent(environment: string, name: string, argv: string[], options: { repository: string; env?: Record<string, string> }): Promise<void> {
    const flags = Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    const result = await this.cli(['environment', 'agent', 'add', environment, name, '--repository', options.repository, '--restart', 'never', ...flags, ...this.daemonArgs(), '--', ...argv])
    if (result.exitCode !== 0) throw this.failure(['environment', 'agent'], result)
  }

  /** A plain process on the Computer (`environment process add`): a build step, not an agent. Run in a repository's checkout; never restarted. */
  async startProcess(environment: string, name: string, argv: string[], options: { repository?: string; env?: Record<string, string> } = {}): Promise<void> {
    const flags = Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    const result = await this.cli(['environment', 'process', 'add', environment, name, ...(options.repository ? ['--repository', options.repository] : []), '--restart', 'never', ...flags, ...this.daemonArgs(), '--', ...argv])
    if (result.exitCode !== 0) throw this.failure(['environment', 'process', 'add'], result)
  }

  async logs(environment: string, name: string, lines = 5000): Promise<string> {
    const result = await this.cli(['environment', 'logs', environment, '--process', name, '--lines', String(lines), ...this.daemonArgs()], { timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw this.failure(['environment', 'logs'], result)
    return result.stdout
  }

  async stopProcess(environment: string, name: string): Promise<void> {
    const result = await this.cli(['environment', 'process', 'stop', environment, name, ...this.daemonArgs()], { timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw this.failure(['environment', 'process', 'stop'], result)
  }

  async removeProcess(environment: string, name: string): Promise<void> {
    await this.cli(['environment', 'process', 'remove', environment, name, ...this.daemonArgs()], { timeoutMs: 30_000 }).catch(() => undefined)
  }
}

/** The distribution facts in a stack/verification document, for tests and diagnostics that read a file rather than run the command. */
export function readStackEvidence(path: string): { platform: string; status: string; compute: string } {
  const stack = JSON.parse(readFileSync(realpathSync(path), 'utf8')) as { platform: string; compute: string; distribution: { certification_status: string } }
  return { platform: stack.platform, status: stack.distribution.certification_status, compute: stack.compute }
}
