import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../coding/commands'
import { waitUntil } from '../coding/testkit'
import { ComputeClient } from './client'

/** Where the installed products are: `FOUNDRY_COMPUTE` / `FOUNDRY_PAX`, else the usual prefixes and PATH. Tests that need them are skipped when they are absent. */
export function findBinary(name: 'compute-configured' | 'pax'): string | undefined {
  const hints = name === 'pax' ? ['/opt/pax/pax', '/opt/homebrew/bin/pax'] : ['/opt/homebrew/bin/compute-configured', '/home/linuxbrew/.linuxbrew/bin/compute-configured', '/opt/homebrew-emulated/bin/compute-configured']
  for (const candidate of [process.env[name === 'pax' ? 'FOUNDRY_PAX' : 'FOUNDRY_COMPUTE'], ...hints, ...(process.env.PATH ?? '').split(':').map(directory => join(directory, name))]) {
    if (!candidate) continue
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
}

/** A real Compute daemon of its own (isolated `COMPUTE_HOME`, random port) for tests that drive the installed product. Nothing of Compute is mocked. */
export class ComputeHarness {
  readonly compute = findBinary('compute-configured')
  readonly pax = findBinary('pax')
  readonly home = mkdtempSync(join(tmpdir(), 'foundry-compute-'))
  port = 0
  client!: ComputeClient

  get installed(): boolean { return Boolean(this.compute && this.pax) }
  get daemon(): string { return `http://127.0.0.1:${this.port}` }
  env = (): NodeJS.ProcessEnv => ({ COMPUTE_HOME: this.home, COMPUTE_DAEMON: this.daemon })
  cli = (args: string[], timeoutMs = 120_000) => runCommand([this.compute!, ...args], { cwd: this.home, env: this.env(), timeoutMs })

  async start(): Promise<void> {
    this.port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) }) })
    this.client = new ComputeClient({ binary: this.compute, pax: this.pax, daemon: this.daemon, env: this.env() })
    const started = await this.cli(['start', '--insecure', '--detach', '--listen', `127.0.0.1:${this.port}`, '--state-dir', join(this.home, 'daemon')])
    if (started.exitCode !== 0) throw new Error(`compute start failed: ${started.stderr}${started.stdout}`)
    await waitUntil(() => this.client.reachable(), 60_000)
    await waitUntil(async () => (await this.cli(['target', 'list', '--daemon', this.daemon])).stdout.includes('this-machine'), 60_000)
  }

  async stop(): Promise<void> {
    await this.cli(['down', '--listen', `127.0.0.1:${this.port}`], 60_000).catch(() => undefined)
    rmSync(this.home, { recursive: true, force: true })
  }

  /** Every environment Compute lists whose Computer is not destroyed. */
  async liveEnvironments(prefix = ''): Promise<string[]> {
    return (await this.client.inventory()).environments.filter(item => item.name.startsWith(prefix) && item.observed !== 'destroyed').map(item => item.name)
  }
}
