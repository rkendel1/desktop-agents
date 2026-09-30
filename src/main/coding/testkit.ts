import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerProvider } from '../computer'
import type { SecretCodec } from '../credentialVault'
import { startDesktop, stopDesktop, type DesktopState } from '../desktop'
import { addCustomLocalAgent, detectLocalAgents } from '../localAgents'
import { DouchatRuntime } from '../runtime'
import { CodingService } from './service'
import type { ComputeClient } from '../compute/client'
import { EnvironmentService } from '../environment/service'

/** Shared by the coding tests: real repositories, real desktops, and the scripted stand-in agent (a real child process). */
export const fixture = join(__dirname, 'fixtures', 'scripted-agent.cjs')
const codec: SecretCodec = { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }
const idleComputer: ComputerProvider = { snapshots: () => [], start: async () => undefined, stop: async () => undefined, show: async () => undefined, createTools: () => [], dispose: () => undefined } as never

export interface Booted { root: string; desktop: DesktopState; runtime: DouchatRuntime; coding: CodingService }

export class TestKit {
  readonly directories: string[] = []
  readonly running: Booted[] = []

  temporary(prefix: string): string { const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix))); this.directories.push(directory); return directory }
  git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }

  repository(): string {
    const path = this.temporary('coding-repo-')
    this.git(path, 'init', '-q', '-b', 'main')
    this.git(path, 'config', 'user.email', 'test@example.com'); this.git(path, 'config', 'user.name', 'Test')
    mkdirSync(join(path, 'src'))
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test.js' } }))
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
    writeFileSync(join(path, 'test.js'), "const { add } = require('./src/math')\nif (add(2, 3) !== 5) { console.error('add(2, 3) should be 5, got ' + add(2, 3)); process.exit(1) }\nconsole.log('ok')\n")
    this.git(path, 'add', '-A'); this.git(path, 'commit', '-q', '-m', 'initial')
    return path
  }

  async boot(root = this.temporary('coding-desktop-'), options: { compute?: ComputeClient; environments?: EnvironmentService | true; pax?: string } = {}): Promise<Booted> {
    const desktop = await startDesktop({ userData: root, codec })
    const runtime = new DouchatRuntime(desktop.repository, idleComputer, () => undefined)
    // `environments: true`: the project's environment service over the same repository and Compute client, as the app wires it.
    const environments = options.environments === true ? (options.compute ? new EnvironmentService(desktop.repository, options.compute) : undefined) : options.environments
    const booted = { root, desktop, runtime, coding: new CodingService(desktop.repository, runtime, () => undefined, { ...options, environments }) }
    this.running.push(booted)
    return booted
  }

  /** The orderly shutdown of index.ts, in the same order. */
  async shutdown(booted: Booted): Promise<void> {
    booted.runtime.stopAccepting()
    await booted.coding.cancelAll()
    booted.runtime.cancelAll()
    await booted.coding.idle()
    await booted.runtime.idle()
    await stopDesktop(booted.desktop)
    this.running.splice(this.running.indexOf(booted), 1)
  }

  async scriptedAgent(booted: Booted, name = 'Scripted coder') {
    await addCustomLocalAgent({ name, command: process.execPath, args: [fixture, `--agent=${name}`] })
    const local = (await detectLocalAgents()).find(agent => agent.name === name)!
    return booted.desktop.repository.createAgent({ name, role: 'Engineer', instructions: '', color: '#0b5cff', localAgentId: local.id, provider: 'local', model: 'default' })
  }

  async cleanup(): Promise<void> {
    for (const booted of [...this.running]) await this.shutdown(booted).catch(() => undefined)
    for (const directory of this.directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  }

  pidfile(): string { return join(this.temporary('coding-pids-'), 'pids') }
}

export const taskText = (description: string, task: object): string => `${description}\nCODING-TASK ${JSON.stringify(task)}`
export const pidsReady = (pids: string): boolean => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n')

export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a state change')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
